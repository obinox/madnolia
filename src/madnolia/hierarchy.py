import re

from madnolia.constants import SENTENCE_GAP_MS
from madnolia.phonetics import KoreanPhonetics
from madnolia.types.common import PhoneTarget, TranscriptSentence, TranscriptWord


def segment_sentences(words: list[TranscriptWord]) -> list[TranscriptSentence]:
    if not words:
        return []
    boundaries: list[tuple[int, int]] = []
    start = 0
    for index, word in enumerate(words):
        next_word = words[index + 1] if index + 1 < len(words) else None
        punctuation_end = bool(re.search(r"[.!?。？！][\"'”’)]*$", word.text))
        long_gap = next_word is not None and next_word.start_ms - word.end_ms >= SENTENCE_GAP_MS
        if punctuation_end or long_gap or next_word is None:
            boundaries.append((start, index + 1))
            start = index + 1
    return [
        TranscriptSentence(
            sentence_index=sentence_index,
            text=" ".join(word.text for word in words[word_start:word_end]),
            start_ms=words[word_start].start_ms,
            end_ms=words[word_end - 1].end_ms,
            word_start_index=word_start,
            word_end_index=word_end,
        )
        for sentence_index, (word_start, word_end) in enumerate(boundaries)
    ]


def build_phone_targets(
    words: list[TranscriptWord],
    sentences: list[TranscriptSentence],
    phonetics: KoreanPhonetics,
) -> list[PhoneTarget]:
    targets: list[PhoneTarget] = []
    for sentence in sentences:
        sentence_words = words[sentence.word_start_index:sentence.word_end_index]
        pronunciation = phonetics.pronounce(" ".join(word.text for word in sentence_words))
        parts = pronunciation.split()
        if len(parts) != len(sentence_words):
            parts = [phonetics.pronounce(word.text) for word in sentence_words]
        for offset, (word, word_pronunciation) in enumerate(
            zip(sentence_words, parts, strict=True)
        ):
            word_index = sentence.word_start_index + offset
            for phone_id, ipa, grapheme in phonetics.to_phones(word_pronunciation):
                targets.append(
                    PhoneTarget(
                        sentence_index=sentence.sentence_index,
                        word_index=word_index,
                        grapheme=grapheme,
                        pronunciation=word_pronunciation,
                        phone_id=phone_id,
                        ipa=ipa,
                    )
                )
    return targets
