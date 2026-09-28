import re
import shutil
import sys
from pathlib import Path

import nltk

from madnolia.constants import (
    FINAL_COUNT,
    FINAL_IPA,
    FINALS,
    HANGUL_BASE,
    HANGUL_END,
    INITIAL_IPA,
    INITIALS,
    MEDIAL_COUNT,
    MEDIAL_IPA,
    MEDIALS,
    NLTK_DATA_DIR,
)


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
