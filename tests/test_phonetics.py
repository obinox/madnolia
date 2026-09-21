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
