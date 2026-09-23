import wave
from dataclasses import replace
from pathlib import Path

import numpy as np

from madnolia.constants import (
    ACOUSTIC_MODEL_INPUT_SAMPLES,
    HUBERT_CHUNK_GAP_MS,
    HUBERT_CHUNK_MS,
    HUBERT_CLUSTER_COUNT,
    HUBERT_OPENVINO_MODEL_PATH,
)
from madnolia.types.common import PhoneAcousticFeatures, PhoneOccurrence


class HubertUnitEncoder:
    def __init__(
        self,
        model_path: Path = HUBERT_OPENVINO_MODEL_PATH,
        device: str = "GPU",
    ) -> None:
        import openvino as ov

        self._model = ov.Core().compile_model(model_path, device)

    def encode(self, samples: np.ndarray) -> tuple[np.ndarray, float]:
        normalized = (samples - np.mean(samples)) / np.sqrt(np.var(samples) + 1e-7)
        if len(normalized) < ACOUSTIC_MODEL_INPUT_SAMPLES:
            normalized = np.pad(normalized, (0, ACOUSTIC_MODEL_INPUT_SAMPLES - len(normalized)))
        hidden = self._model([normalized[np.newaxis, :]])[0][0].astype(np.float32)
        frame_ms = len(normalized) * 1000 / 16000 / len(hidden)
        return hidden, frame_ms


def extract_phone_embeddings(
    audio_path: Path,
    phones: list[PhoneOccurrence],
    encoder: HubertUnitEncoder,
) -> np.ndarray:
    samples, sample_rate = _read_wave(audio_path)
    embeddings = np.zeros((len(phones), 768), dtype=np.float32)
    ordered = sorted(enumerate(phones), key=lambda item: item[1].start_ms)
    cursor = 0
    while cursor < len(ordered):
        group = [ordered[cursor]]
        cursor += 1
        while cursor < len(ordered):
            previous = group[-1][1]
            candidate = ordered[cursor][1]
            if (
                candidate.end_ms - group[0][1].start_ms > HUBERT_CHUNK_MS
                or candidate.start_ms - previous.end_ms > HUBERT_CHUNK_GAP_MS
            ):
                break
            group.append(ordered[cursor])
            cursor += 1
        chunk_start_ms = max(0, group[0][1].start_ms - 250)
        chunk_end_ms = min(
            round(len(samples) * 1000 / sample_rate),
            group[-1][1].end_ms + 250,
        )
        start_frame = round(chunk_start_ms * sample_rate / 1000)
        end_frame = round(chunk_end_ms * sample_rate / 1000)
        hidden, frame_ms = encoder.encode(samples[start_frame:end_frame])
        for phone_index, phone in group:
            hidden_start = int((phone.start_ms - chunk_start_ms) / frame_ms)
            hidden_end = int(np.ceil((phone.end_ms - chunk_start_ms) / frame_ms))
            hidden_start = max(0, min(len(hidden) - 1, hidden_start))
            hidden_end = max(hidden_start + 1, min(len(hidden), hidden_end))
            embeddings[phone_index] = np.mean(hidden[hidden_start:hidden_end], axis=0)
    return embeddings


def cluster_acoustic_units(
    embedding_sets: list[np.ndarray],
    cluster_count: int = HUBERT_CLUSTER_COUNT,
    passes: int = 3,
) -> tuple[list[np.ndarray], np.ndarray]:
    if not embedding_sets or sum(len(items) for items in embedding_sets) == 0:
        return [np.empty(0, dtype=np.int32) for _ in embedding_sets], np.empty((0, 768))
    combined = np.concatenate(embedding_sets)
    valid = np.linalg.norm(combined, axis=1) > 0
    valid_embeddings = combined[valid]
    count = min(cluster_count, len(valid_embeddings))
    seeds = np.linspace(0, len(valid_embeddings) - 1, count, dtype=int)
    centroids = valid_embeddings[seeds].copy()
    totals = np.ones(count, dtype=np.int64)
    for _ in range(passes):
        for start in range(0, len(valid_embeddings), 1024):
            batch = valid_embeddings[start:start + 1024]
            assignments = _nearest_centroids(batch, centroids)
            for unit_id in np.unique(assignments):
                members = batch[assignments == unit_id]
                new_total = totals[unit_id] + len(members)
                centroids[unit_id] = (
                    centroids[unit_id] * totals[unit_id] + np.sum(members, axis=0)
                ) / new_total
                totals[unit_id] = new_total
    all_assignments = np.full(len(combined), -1, dtype=np.int32)
    all_assignments[valid] = _nearest_centroids(valid_embeddings, centroids)
    results: list[np.ndarray] = []
    cursor = 0
    for embeddings in embedding_sets:
        results.append(all_assignments[cursor:cursor + len(embeddings)])
        cursor += len(embeddings)
    return results, centroids


def apply_acoustic_unit_ids(
    features: list[PhoneAcousticFeatures],
    unit_ids: np.ndarray,
) -> list[PhoneAcousticFeatures]:
    return [
        replace(feature, acoustic_unit_id=int(unit_id) if unit_id >= 0 else None)
        for feature, unit_id in zip(features, unit_ids, strict=True)
    ]


def _nearest_centroids(embeddings: np.ndarray, centroids: np.ndarray) -> np.ndarray:
    distances = (
        np.sum(np.square(embeddings), axis=1, keepdims=True)
        + np.sum(np.square(centroids), axis=1)
        - 2 * embeddings @ centroids.T
    )
    return np.argmin(distances, axis=1).astype(np.int32)


def _read_wave(audio_path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(audio_path), "rb") as audio:
        sample_rate = audio.getframerate()
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype=np.int16)
    return samples.astype(np.float32) / 32768.0, sample_rate
