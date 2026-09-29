import re
import shutil
import sys
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path

import nltk

from madnolia.constants import (
    ARPABET_IPA,
    FINAL_COUNT,
    FINAL_IPA,
    FINALS,
    HANGUL_BASE,
    HANGUL_END,
    INITIAL_IPA,
    INITIALS,
    JAPANESE_GEMINATE,
    JAPANESE_MORAIC_NASAL,
    JAPANESE_ONSETS,
    JAPANESE_VOWELS,
    MEDIAL_COUNT,
    MEDIAL_IPA,
    MEDIALS,
    NLTK_DATA_DIR,
)
from madnolia.types.common import InputLanguage, PhoneticTranscription


class KoreanPhonetics:
    def __init__(self) -> None:
        _prepare_nltk_data()
        from g2pk import G2p

        self._g2p = G2p()

    def pronounce(self, text: str) -> str:
        normalized = re.sub(r"\s+", " ", text.strip())
        return self._g2p(normalized)

    def to_phones(self, pronunciation: str) -> list[tuple[str, str, str]]:
        phones: list[tuple[str, str, str]] = []
        for character in pronunciation:
            codepoint = ord(character)
            if not HANGUL_BASE <= codepoint <= HANGUL_END:
                continue
            syllable_index = codepoint - HANGUL_BASE
            initial_index = syllable_index // (MEDIAL_COUNT * FINAL_COUNT)
            medial_index = (syllable_index % (MEDIAL_COUNT * FINAL_COUNT)) // FINAL_COUNT
            final_index = syllable_index % FINAL_COUNT
            initial = INITIALS[initial_index]
            medial = MEDIALS[medial_index]
            final = FINALS[final_index]
            if initial != "ㅇ":
                phone_id, ipa = self._contextual_initial(initial, medial)
                phones.append((phone_id, ipa, character))
            phone_id, ipa = MEDIAL_IPA[medial]
            phones.append((phone_id, ipa, character))
            if final:
                phone_id, ipa = FINAL_IPA[final]
                phones.append((phone_id, ipa, character))
        return phones

    def _contextual_initial(self, initial: str, medial: str) -> tuple[str, str]:
        phone_id, ipa = INITIAL_IPA[initial]
        if initial in {"ㅅ", "ㅆ"} and medial in {"ㅑ", "ㅒ", "ㅕ", "ㅖ", "ㅛ", "ㅠ", "ㅣ"}:
            return phone_id.replace("alveolar", "alveolopalatal"), ipa.replace("s", "ɕ")
        return phone_id, ipa


class MultilingualPhonetics:
    def __init__(self) -> None:
        self._korean = KoreanPhonetics()
        self._english = None
        self._japanese = None

    def transcribe(
        self, text: str, language: InputLanguage = InputLanguage.AUTO
    ) -> PhoneticTranscription:
        normalized = re.sub(r"\s+", " ", text.strip())
        if not normalized:
            raise ValueError("검색할 문장이 비어 있습니다.")
        resolved = self.detect_language(normalized) if language == InputLanguage.AUTO else language
        if resolved == InputLanguage.KO:
            pronunciation = self._korean.pronounce(normalized)
            phones = self._korean.to_phones(pronunciation)
        elif resolved == InputLanguage.EN:
            pronunciation, phones = self._english_phones(normalized)
        elif resolved == InputLanguage.JA:
            pronunciation, phones = self._japanese_phones(normalized)
        else:
            raise ValueError("지원하는 언어는 한국어, 영어, 일본어입니다.")
        return PhoneticTranscription(resolved, pronunciation, phones)

    @staticmethod
    def detect_language(text: str) -> InputLanguage:
        if re.search(r"[\uac00-\ud7a3]", text):
            return InputLanguage.KO
        if re.search(r"[\u3040-\u30ff]", text):
            return InputLanguage.JA
        if re.search(r"[\u3400-\u9fff]", text):
            raise ValueError("한자만 입력된 문장은 언어 선택에서 일본어를 지정해 주세요.")
        if re.search(r"[a-zA-Z]", text):
            return InputLanguage.EN
        raise ValueError("한국어, 영어, 일본어 문장을 입력하거나 언어를 선택해 주세요.")

    def _english_phones(self, text: str) -> tuple[str, list[tuple[str, str, str]]]:
        if self._english is None:
            from g2p_en import G2p

            with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
                self._english = G2p()
        tokens = re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", text.lower())
        if not tokens:
            raise ValueError("영어 발음으로 변환할 단어가 없습니다.")
        phones: list[tuple[str, str, str]] = []
        pronunciation: list[str] = []
        for word in tokens:
            alternatives = self._english.cmu.get(word)
            arpabet = alternatives[0] if alternatives else self._english.predict(word)
            for symbol in arpabet:
                phone = ARPABET_IPA.get(re.sub(r"\d", "", symbol))
                if phone:
                    phones.extend((phone_id, ipa, word) for phone_id, ipa in phone)
                    pronunciation.extend(ipa for _, ipa in phone)
        return " ".join(pronunciation), phones

    def _japanese_phones(self, text: str) -> tuple[str, list[tuple[str, str, str]]]:
        if self._japanese is None:
            from pykakasi import kakasi

            self._japanese = kakasi()
        romanized = "".join(item["hepburn"] for item in self._japanese.convert(text)).lower()
        phones: list[tuple[str, str, str]] = []
        emitted: list[str] = []
        index = 0
        while index < len(romanized):
            if romanized[index].isspace() or romanized[index] in "'-・":
                index += 1
                continue
            if romanized[index] == "n" and (
                index + 1 == len(romanized) or romanized[index + 1] not in "aiueoyn'"
            ):
                phone_id, ipa = JAPANESE_MORAIC_NASAL
                phones.append((phone_id, ipa, text))
                emitted.append(ipa)
                index += 1
                continue
            if index + 1 < len(romanized) and romanized[index] == romanized[index + 1] and romanized[index] not in "aeioun":
                phone_id, ipa = JAPANESE_GEMINATE
                phones.append((phone_id, ipa, text))
                emitted.append(ipa)
                index += 1
            onset = next(
                (key for key in sorted(JAPANESE_ONSETS, key=len, reverse=True)
                 if romanized.startswith(key, index)),
                "",
            )
            if onset:
                phone_id, ipa = JAPANESE_ONSETS[onset]
                phones.append((phone_id, ipa, text))
                emitted.append(ipa)
                index += len(onset)
            if index < len(romanized) and romanized[index] in JAPANESE_VOWELS:
                vowel = romanized[index]
                long_pair = romanized[index:index + 2]
                long_vowel = {
                    "aa": "a", "ii": "i", "uu": "u", "ee": "e", "oo": "o",
                    "ou": "o", "ei": "e",
                }.get(long_pair)
                if long_vowel:
                    phone_id, ipa = JAPANESE_VOWELS[long_vowel]
                    ipa = f"{ipa}ː"
                    index += 1
                else:
                    phone_id, ipa = JAPANESE_VOWELS[vowel]
                phones.append((phone_id, ipa, text))
                emitted.append(ipa)
                index += 1
            elif not onset:
                index += 1
        if not phones:
            raise ValueError("일본어 발음으로 변환할 수 없습니다.")
        return " ".join(emitted), phones


def _prepare_nltk_data() -> None:
    data_dir = NLTK_DATA_DIR.resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    if getattr(sys, "frozen", False):
        bundled_archive = Path(sys._MEIPASS) / "nltk_data" / "corpora" / "cmudict.zip"
        cached_archive = data_dir / "corpora" / "cmudict.zip"
        if bundled_archive.is_file() and not cached_archive.exists():
            cached_archive.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(bundled_archive, cached_archive)
    data_path = str(data_dir)
    if data_path not in nltk.data.path:
        nltk.data.path.insert(0, data_path)
    try:
        nltk.data.find("corpora/cmudict.zip", paths=[data_path])
    except LookupError:
        if not nltk.download("cmudict", download_dir=data_path, quiet=True):
            raise RuntimeError("g2pK용 cmudict 다운로드에 실패했습니다.")
