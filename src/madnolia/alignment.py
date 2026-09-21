from uuid import uuid4

from madnolia.constants import VOWEL_PHONE_PREFIX
from madnolia.phonetics import KoreanPhonetics
from madnolia.types.common import AlignmentMethod, PhoneOccurrence, TranscriptWord


def estimate_phone_occurrences(
    source_id: str,
    words: list[TranscriptWord],
    phonetics: KoreanPhonetics,
) -> list[PhoneOccurrence]:
    occurrences: list[PhoneOccurrence] = []
    for word_index, word in enumerate(words):
        pronunciation = phonetics.pronounce(word.text)
        phones = phonetics.to_phones(pronunciation)
        if not phones:
            continue
        weights = [1.0 if phone_id.startswith(VOWEL_PHONE_PREFIX) else 0.65 for phone_id, _, _ in phones]
        boundaries = _weighted_boundaries(word.start_ms, word.end_ms, weights)
        for phone_index, (phone_id, ipa, grapheme) in enumerate(phones):
            occurrences.append(
                PhoneOccurrence(
                    occurrence_id=f"phone_{uuid4().hex}",
                    source_id=source_id,
                    word_index=word_index,
                    grapheme=grapheme,
                    pronunciation=pronunciation,
                    phone_id=phone_id,
                    ipa=ipa,
                    start_ms=boundaries[phone_index],
                    end_ms=boundaries[phone_index + 1],
                    confidence=word.confidence * 0.7 if word.confidence is not None else None,
                    alignment_method=AlignmentMethod.ESTIMATED_WORD,
                )
            )
    return occurrences


def _weighted_boundaries(start_ms: int, end_ms: int, weights: list[float]) -> list[int]:
    duration = max(0, end_ms - start_ms)
    total_weight = sum(weights)
    boundaries = [start_ms]
    accumulated = 0.0
    for weight in weights[:-1]:
        accumulated += weight
        boundaries.append(start_ms + round(duration * accumulated / total_weight))
    boundaries.append(end_ms)
    return boundaries
