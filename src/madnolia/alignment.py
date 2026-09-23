import wave
from pathlib import Path
from uuid import uuid4

import numpy as np

from madnolia.constants import (
    CTC_ALIGNMENT_CHUNK_MS,
    CTC_ALIGNMENT_PADDING_MS,
    VOWEL_PHONE_PREFIX,
)
from madnolia.ctc_alignment import PhonemeCtcAligner
from madnolia.hierarchy import build_phone_targets
from madnolia.phonetics import KoreanPhonetics
from madnolia.types.common import (
    AlignmentMethod,
    AlignmentStatus,
    PhoneOccurrence,
    PhoneTarget,
    TranscriptSentence,
    TranscriptWord,
)


def estimate_phone_occurrences(
    source_id: str,
    words: list[TranscriptWord],
    phonetics: KoreanPhonetics,
    sentences: list[TranscriptSentence] | None = None,
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
                    sentence_index=_sentence_index(word_index, sentences or []),
                    word_index=word_index,
                    grapheme=grapheme,
                    pronunciation=pronunciation,
                    phone_id=phone_id,
                    ipa=ipa,
                    start_ms=boundaries[phone_index],
                    end_ms=boundaries[phone_index + 1],
                    confidence=word.confidence * 0.7 if word.confidence is not None else None,
                    alignment_method=AlignmentMethod.ESTIMATED_WORD,
                    alignment_status=AlignmentStatus.ESTIMATED,
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


def _sentence_index(word_index: int, sentences: list[TranscriptSentence]) -> int:
    sentence = next(
        (
            item
            for item in sentences
            if item.word_start_index <= word_index < item.word_end_index
        ),
        None,
    )
    return sentence.sentence_index if sentence is not None else -1


def align_phone_occurrences(
    source_id: str,
    audio_path: Path,
    words: list[TranscriptWord],
    sentences: list[TranscriptSentence],
    phonetics: KoreanPhonetics,
    aligner: PhonemeCtcAligner,
) -> list[PhoneOccurrence]:
    targets = build_phone_targets(words, sentences, phonetics)
    targets_by_word: dict[int, list[tuple[int, PhoneTarget]]] = {}
    for target_index, target in enumerate(targets):
        targets_by_word.setdefault(target.word_index, []).append((target_index, target))
    estimates = _target_estimates(words, targets_by_word)
    occurrences: list[PhoneOccurrence | None] = [None] * len(targets)
    duration_ms = _wave_duration_ms(audio_path)
    for word_start, word_end in _alignment_word_chunks(words, sentences):
        indexed_targets = [
            item
            for word_index in range(word_start, word_end)
            for item in targets_by_word.get(word_index, [])
        ]
        if not indexed_targets:
            continue
        chunk_start_ms = max(0, words[word_start].start_ms - CTC_ALIGNMENT_PADDING_MS)
        chunk_end_ms = min(duration_ms, words[word_end - 1].end_ms + CTC_ALIGNMENT_PADDING_MS)
        samples = _read_pcm_interval(audio_path, chunk_start_ms, chunk_end_ms)
        boundaries = aligner.align(
            samples,
            [target.ipa for _, target in indexed_targets],
            chunk_start_ms,
        )
        for (target_index, target), boundary in zip(indexed_targets, boundaries, strict=True):
            estimated_start, estimated_end = estimates[target_index]
            occurrences[target_index] = PhoneOccurrence(
                occurrence_id=f"phone_{uuid4().hex}",
                source_id=source_id,
                sentence_index=target.sentence_index,
                word_index=target.word_index,
                grapheme=target.grapheme,
                pronunciation=target.pronunciation,
                phone_id=target.phone_id,
                ipa=target.ipa,
                start_ms=boundary.start_ms if boundary.start_ms is not None else estimated_start,
                end_ms=boundary.end_ms if boundary.end_ms is not None else estimated_end,
                confidence=boundary.confidence,
                alignment_method=AlignmentMethod.CTC_FORCED,
                alignment_status=boundary.status,
            )
    return [occurrence for occurrence in occurrences if occurrence is not None]


def _alignment_word_chunks(
    words: list[TranscriptWord],
    sentences: list[TranscriptSentence],
) -> list[tuple[int, int]]:
    chunks: list[tuple[int, int]] = []
    for sentence in sentences:
        start = sentence.word_start_index
        while start < sentence.word_end_index:
            end = start + 1
            while (
                end < sentence.word_end_index
                and words[end].end_ms - words[start].start_ms <= CTC_ALIGNMENT_CHUNK_MS
            ):
                end += 1
            chunks.append((start, end))
            start = end
    return chunks


def _target_estimates(
    words: list[TranscriptWord],
    targets_by_word: dict[int, list[tuple[int, PhoneTarget]]],
) -> dict[int, tuple[int, int]]:
    estimates: dict[int, tuple[int, int]] = {}
    for word_index, indexed_targets in targets_by_word.items():
        weights = [
            1.0 if target.phone_id.startswith(VOWEL_PHONE_PREFIX) else 0.65
            for _, target in indexed_targets
        ]
        boundaries = _weighted_boundaries(words[word_index].start_ms, words[word_index].end_ms, weights)
        for offset, (target_index, _) in enumerate(indexed_targets):
            estimates[target_index] = (boundaries[offset], boundaries[offset + 1])
    return estimates


def _wave_duration_ms(audio_path: Path) -> int:
    with wave.open(str(audio_path), "rb") as audio:
        return round(audio.getnframes() * 1000 / audio.getframerate())


def _read_pcm_interval(audio_path: Path, start_ms: int, end_ms: int) -> np.ndarray:
    with wave.open(str(audio_path), "rb") as audio:
        sample_rate = audio.getframerate()
        start_frame = round(start_ms * sample_rate / 1000)
        end_frame = round(end_ms * sample_rate / 1000)
        audio.setpos(start_frame)
        raw = audio.readframes(end_frame - start_frame)
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
