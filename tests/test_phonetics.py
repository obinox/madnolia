from zipfile import ZipFile

import nltk

from madnolia import phonetics
from madnolia.alignment import estimate_phone_occurrences
from madnolia.phonetics import KoreanPhonetics
from madnolia.types.common import AlignmentMethod, TranscriptWord


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
