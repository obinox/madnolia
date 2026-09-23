import json
import unicodedata
from pathlib import Path

import numpy as np

from madnolia.constants import (
    ACOUSTIC_MODEL_INPUT_SAMPLES,
    CTC_IPA_ALIASES,
    CTC_LOW_CONFIDENCE_THRESHOLD,
    CTC_MODEL_DIR,
    CTC_OPENVINO_MODEL_PATH,
)
from madnolia.types.common import AlignmentStatus, CtcPhoneBoundary


class PhonemeCtcAligner:
    def __init__(
        self,
        model_dir: Path = CTC_MODEL_DIR,
        openvino_model_path: Path = CTC_OPENVINO_MODEL_PATH,
        device: str = "GPU",
    ) -> None:
        import openvino as ov

        self._compiled_model = ov.Core().compile_model(openvino_model_path, device)
        self._vocab = json.loads((model_dir / "vocab.json").read_text(encoding="utf-8"))
        self._blank_id = self._vocab["<pad>"]

    def align(
        self,
        samples: np.ndarray,
        phones: list[str],
        offset_ms: int = 0,
    ) -> list[CtcPhoneBoundary]:
        if not phones:
            return []
        token_groups = [_tokenize_ipa(phone, self._vocab) for phone in phones]
        if any(not group for group in token_groups):
            return _missing_boundaries(phones)
        token_ids = [self._vocab[token] for group in token_groups for token in group]
        normalized = (samples - np.mean(samples)) / np.sqrt(np.var(samples) + 1e-7)
        if len(normalized) < ACOUSTIC_MODEL_INPUT_SAMPLES:
            normalized = np.pad(normalized, (0, ACOUSTIC_MODEL_INPUT_SAMPLES - len(normalized)))
        logits = self._compiled_model([normalized[np.newaxis, :]])[0][0]
        maximum = np.max(logits, axis=-1, keepdims=True)
        stabilized = logits - maximum
        log_probabilities = stabilized - np.log(
            np.sum(np.exp(stabilized), axis=-1, keepdims=True)
        )
        token_spans = _ctc_token_spans(log_probabilities, token_ids, self._blank_id)
        if token_spans is None:
            return _missing_boundaries(phones)
        frame_ms = len(normalized) * 1000 / 16000 / len(log_probabilities)
        boundaries: list[CtcPhoneBoundary] = []
        cursor = 0
        for phone_index, (phone, group) in enumerate(zip(phones, token_groups, strict=True)):
            spans = token_spans[cursor:cursor + len(group)]
            cursor += len(group)
            confidence = float(np.mean([span[2] for span in spans]))
            status = (
                AlignmentStatus.ALIGNED
                if confidence >= CTC_LOW_CONFIDENCE_THRESHOLD
                else AlignmentStatus.LOW_CONFIDENCE
            )
            boundaries.append(
                CtcPhoneBoundary(
                    phone_index=phone_index,
                    ipa=phone,
                    start_ms=offset_ms + round(spans[0][0] * frame_ms),
                    end_ms=offset_ms + round(spans[-1][1] * frame_ms),
                    confidence=confidence,
                    status=status,
                )
            )
        return boundaries


def _tokenize_ipa(ipa: str, vocab: dict[str, int]) -> list[str]:
    alias = CTC_IPA_ALIASES.get(ipa)
    if alias is not None and all(token in vocab for token in alias):
        return list(alias)
    if ipa in vocab:
        return [ipa]
    normalized = "".join(character for character in ipa if not unicodedata.combining(character))
    aspirated = normalized.replace("ʰ", "h")
    for value in (aspirated, normalized):
        if value in vocab:
            return [value]
        tokens = _longest_vocab_tokens(value, vocab)
        if tokens:
            return tokens
    return []


def _longest_vocab_tokens(value: str, vocab: dict[str, int]) -> list[str]:
    tokens: list[str] = []
    cursor = 0
    candidates = sorted(
        (token for token in vocab if not token.startswith("<") and token != "|"),
        key=len,
        reverse=True,
    )
    while cursor < len(value):
        token = next((item for item in candidates if value.startswith(item, cursor)), None)
        if token is None:
            return []
        tokens.append(token)
        cursor += len(token)
    return tokens


def _ctc_token_spans(
    log_probabilities: np.ndarray,
    token_ids: list[int],
    blank_id: int,
) -> list[tuple[int, int, float]] | None:
    frame_count = len(log_probabilities)
    state_count = len(token_ids) * 2 + 1
    if frame_count == 0 or state_count > frame_count * 2 + 1:
        return None
    scores = np.full((frame_count, state_count), -np.inf, dtype=np.float32)
    back = np.full((frame_count, state_count), -1, dtype=np.int32)
    scores[0, 0] = log_probabilities[0, blank_id]
    if token_ids:
        scores[0, 1] = log_probabilities[0, token_ids[0]]
    for frame in range(1, frame_count):
        for state in range(state_count):
            label_id = blank_id if state % 2 == 0 else token_ids[state // 2]
            previous_states = [state]
            if state > 0:
                previous_states.append(state - 1)
            if state > 1 and state % 2 == 1:
                token_index = state // 2
                if token_index == 0 or token_ids[token_index] != token_ids[token_index - 1]:
                    previous_states.append(state - 2)
            previous = max(previous_states, key=lambda item: scores[frame - 1, item])
            scores[frame, state] = scores[frame - 1, previous] + log_probabilities[frame, label_id]
            back[frame, state] = previous
    final_states = [state_count - 1, state_count - 2]
    state = max(final_states, key=lambda item: scores[-1, item])
    if not np.isfinite(scores[-1, state]):
        return None
    states = [state]
    for frame in range(frame_count - 1, 0, -1):
        state = back[frame, state]
        if state < 0:
            return None
        states.append(state)
    states.reverse()
    spans: list[tuple[int, int, float]] = []
    for token_index, token_id in enumerate(token_ids):
        token_state = token_index * 2 + 1
        frames = [index for index, value in enumerate(states) if value == token_state]
        if not frames:
            return None
        confidence = float(np.exp(np.mean(log_probabilities[frames, token_id])))
        spans.append((frames[0], frames[-1] + 1, confidence))
    return spans


def _missing_boundaries(phones: list[str]) -> list[CtcPhoneBoundary]:
    return [
        CtcPhoneBoundary(
            phone_index=index,
            ipa=phone,
            start_ms=None,
            end_ms=None,
            confidence=0.0,
            status=AlignmentStatus.MISSING,
        )
        for index, phone in enumerate(phones)
    ]
