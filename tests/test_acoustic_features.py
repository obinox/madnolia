import numpy as np

from madnolia.acoustic_features import _estimate_f0


def test_f0_estimator_detects_voiced_tone() -> None:
    sample_rate = 16_000
    time = np.arange(round(sample_rate * 0.08)) / sample_rate
    samples = np.sin(2 * np.pi * 200 * time).astype(np.float32)
    f0_hz, probability = _estimate_f0(samples, sample_rate)
    assert f0_hz is not None
    assert abs(f0_hz - 200) < 5
    assert probability > 0.3


def test_f0_estimator_marks_silence_unvoiced() -> None:
    f0_hz, probability = _estimate_f0(np.zeros(1280, dtype=np.float32), 16_000)
    assert f0_hz is None
    assert probability == 0
