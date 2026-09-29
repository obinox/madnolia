from zipfile import ZipFile

import nltk

from madnolia import phonetics
from madnolia.alignment import estimate_phone_occurrences
from madnolia.phonetics import KoreanPhonetics, MultilingualPhonetics
from madnolia.types.common import AlignmentMethod, InputLanguage, TranscriptWord


def test_hangul_pronunciation_to_ipa() -> None:
    phonetics = KoreanPhonetics()
    pronunciation = phonetics.pronounce("국물")
    phones = phonetics.to_phones(pronunciation)
    assert pronunciation == "궁물"
    assert "ŋ" in [ipa for _, ipa, _ in phones]


def test_phone_timing_stays_inside_word() -> None:
    phonetics = KoreanPhonetics()
    words = [TranscriptWord(text="안녕", start_ms=100, end_ms=700, confidence=0.9)]
    phones = estimate_phone_occurrences("source", words, phonetics)
    assert phones[0].start_ms == 100
    assert phones[-1].end_ms == 700
    assert all(phone.alignment_method == AlignmentMethod.ESTIMATED_WORD for phone in phones)


def test_english_text_uses_arpabet_pronunciation() -> None:
    result = MultilingualPhonetics().transcribe("hello", InputLanguage.EN)

    assert result.language == InputLanguage.EN
    assert next(ipa for _, ipa, _ in result.phones) == "h"
    assert any(phone_id.startswith("en.vowel") for phone_id, _, _ in result.phones)
    assert any(phone_id == "en.consonant.alveolar.lateral.voiced" for phone_id, _, _ in result.phones)


def test_japanese_kana_uses_japanese_pronunciation() -> None:
    result = MultilingualPhonetics().transcribe("こんにちは")

    assert result.language == InputLanguage.JA
    assert any(phone_id == "ja.consonant.alveolar.nasal.voiced" for phone_id, _, _ in result.phones)
    assert any(phone_id == "ja.vowel.a" for phone_id, _, _ in result.phones)


def test_japanese_geminate_and_long_vowel_are_preserved() -> None:
    result = MultilingualPhonetics().transcribe("がっこう", InputLanguage.JA)

    assert any(phone_id == "ja.consonant.geminate" for phone_id, _, _ in result.phones)
    assert any(ipa.endswith("ː") for _, ipa, _ in result.phones)


def test_auto_language_detection_excludes_chinese() -> None:
    phonetics = MultilingualPhonetics()

    assert phonetics.detect_language("hello") == InputLanguage.EN
    assert phonetics.detect_language("こんにちは") == InputLanguage.JA
    assert phonetics.detect_language("안녕하세요") == InputLanguage.KO
    try:
        phonetics.detect_language("你好")
    except ValueError:
        pass
    else:
        raise AssertionError("Han-only input must not be treated as supported Chinese")


def test_frozen_runtime_seeds_bundled_cmudict_before_g2pk_download(monkeypatch, tmp_path) -> None:
    bundle_root = tmp_path / "bundle"
    bundled_archive = bundle_root / "nltk_data" / "corpora" / "cmudict.zip"
    bundled_archive.parent.mkdir(parents=True)
    with ZipFile(bundled_archive, "w") as archive:
        archive.writestr("cmudict/cmudict", "TEST  T EH S T\n")
    cache_dir = tmp_path / "runtime" / "nltk"
    monkeypatch.setattr(phonetics, "NLTK_DATA_DIR", cache_dir)
    monkeypatch.setattr(phonetics.sys, "frozen", True, raising=False)
    monkeypatch.setattr(phonetics.sys, "_MEIPASS", str(bundle_root), raising=False)
    monkeypatch.setattr(nltk.data, "path", [str(tmp_path / "user-nltk")])

    def fail_download(*args, **kwargs):
        raise AssertionError("unexpected download")

    monkeypatch.setattr(nltk, "download", fail_download)

    phonetics._prepare_nltk_data()

    cached_archive = cache_dir / "corpora" / "cmudict.zip"
    assert cached_archive.read_bytes() == bundled_archive.read_bytes()
    assert nltk.data.find("corpora/cmudict.zip")
