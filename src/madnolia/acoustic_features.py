import wave
from pathlib import Path

import numpy as np

from madnolia.types.common import AnalysisCheckpoint, PhoneAcousticFeatures, PhoneOccurrence


def analyze_phone_acoustics(
    audio_path: Path,
    phones: list[PhoneOccurrence],
    checkpoint: AnalysisCheckpoint | None = None,
) -> list[PhoneAcousticFeatures]:
    samples, sample_rate = _read_wave(audio_path)
    features: list[PhoneAcousticFeatures] = []
    for index, phone in enumerate(phones):
        if checkpoint and index % 64 == 0:
            checkpoint()
        start = max(0, round(phone.start_ms * sample_rate / 1000))
        end = min(len(samples), round(phone.end_ms * sample_rate / 1000))
        segment = samples[start:end]
        center = (start + end) // 2
        context_radius = round(0.04 * sample_rate)
        context = samples[
            max(0, center - context_radius) : min(len(samples), center + context_radius)
        ]
        rms = float(np.sqrt(np.mean(np.square(segment)))) if len(segment) else 0.0
        peak = float(np.max(np.abs(segment))) if len(segment) else 0.0
        f0_hz, voiced_probability = _estimate_f0(context, sample_rate)
        if not _supports_voicing(phone.phone_id):
            f0_hz = None
            voiced_probability = 0.0
        features.append(
            PhoneAcousticFeatures(
                occurrence_id=phone.occurrence_id,
                rms_db=_amplitude_db(rms),
                peak_db=_amplitude_db(peak),
                f0_hz=f0_hz,
                voiced_probability=voiced_probability,
                acoustic_unit_id=None,
            )
        )
    return features


def _estimate_f0(samples: np.ndarray, sample_rate: int) -> tuple[float | None, float]:
    if len(samples) < round(sample_rate * 0.04):
        return None, 0.0
    centered = samples - np.mean(samples)
    energy = float(np.dot(centered, centered))
    if energy < 1e-6:
        return None, 0.0
    windowed = centered * np.hanning(len(centered))
    size = 1 << (len(windowed) * 2 - 1).bit_length()
    spectrum = np.fft.rfft(windowed, n=size)
    autocorrelation = np.fft.irfft(spectrum * np.conj(spectrum), n=size)[: len(windowed)]
    minimum_lag = max(1, sample_rate // 500)
    maximum_lag = min(len(autocorrelation) - 1, sample_rate // 60)
    if maximum_lag <= minimum_lag or autocorrelation[0] <= 0:
        return None, 0.0
    lag = minimum_lag + int(np.argmax(autocorrelation[minimum_lag : maximum_lag + 1]))
    probability = float(np.clip(autocorrelation[lag] / autocorrelation[0], 0.0, 1.0))
    if probability < 0.3:
        return None, probability
    return sample_rate / lag, probability


def _amplitude_db(value: float) -> float:
    return float(20 * np.log10(max(value, 1e-8)))


def _supports_voicing(phone_id: str) -> bool:
    return any(category in phone_id for category in ("vowel", "nasal", "tap", "lateral"))


def _read_wave(audio_path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(audio_path), "rb") as audio:
        sample_rate = audio.getframerate()
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype=np.int16)
    return samples.astype(np.float32) / 32768.0, sample_rate
