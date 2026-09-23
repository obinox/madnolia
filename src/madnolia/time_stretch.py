import numpy as np

from madnolia.constants import STRETCH_FRAME_SAMPLES, STRETCH_SEARCH_SAMPLES


def stretch_audio(samples: np.ndarray, target_length: int) -> np.ndarray:
    if target_length <= len(samples):
        return samples[:target_length]
    if len(samples) < 2:
        return np.full(target_length, samples[0] if len(samples) else 0, dtype=np.float32)

    frame_size = min(STRETCH_FRAME_SAMPLES, len(samples))
    hop = max(1, frame_size // 2)
    last_start = target_length - frame_size
    source_last = len(samples) - frame_size
    positions = list(range(0, last_start, hop)) + [last_start]
    window = np.hanning(frame_size + 2)[1:-1].astype(np.float32)
    output = np.zeros(target_length, dtype=np.float32)
    weights = np.zeros(target_length, dtype=np.float32)

    for index, position in enumerate(positions):
        expected = round(position * source_last / last_start) if last_start else 0
        if index == 0:
            source_start = 0
        elif index == len(positions) - 1:
            source_start = source_last
        else:
            source_start = _matching_start(
                samples, output, weights, position, frame_size, expected, source_last,
            )
        end = position + frame_size
        output[position:end] += samples[source_start:source_start + frame_size] * window
        weights[position:end] += window

    return output / np.maximum(weights, np.finfo(np.float32).eps)


def _matching_start(
    samples: np.ndarray,
    output: np.ndarray,
    weights: np.ndarray,
    position: int,
    frame_size: int,
    expected: int,
    source_last: int,
) -> int:
    overlap = weights[position:position + frame_size] > 0.1
    if overlap.sum() < 4:
        return expected
    reference = output[position:position + frame_size][overlap]
    reference /= weights[position:position + frame_size][overlap]
    reference_energy = np.linalg.norm(reference)
    if reference_energy < 1e-6:
        return expected

    best_start = expected
    best_score = float("-inf")
    for start in range(
        max(0, expected - STRETCH_SEARCH_SAMPLES),
        min(source_last, expected + STRETCH_SEARCH_SAMPLES) + 1,
    ):
        candidate = samples[start:start + frame_size][overlap]
        candidate_energy = np.linalg.norm(candidate)
        score = float(np.dot(reference, candidate) / (reference_energy * candidate_energy)) \
            if candidate_energy > 1e-6 else 0
        if score > best_score:
            best_start, best_score = start, score
    return best_start
