import numpy as np

from madnolia.acoustic_features import _estimate_f0
from madnolia.exporters import _pitch_context
from madnolia.pitch_shift import (
    hz_to_midi,
    render_pitched_audio,
    render_relative_pitch_curve,
    render_relative_pitched_audio,
)
from madnolia.types.common import PhoneAlignmentOperation, PhoneUnit, PitchEnvelopePoint


def test_pitch_shift_changes_frequency_without_changing_length() -> None:
    sample_rate = 16_000
    samples = np.sin(
        2 * np.pi * 220 * np.arange(sample_rate // 2) / sample_rate
    ).astype(np.float32)

    shifted = render_pitched_audio(samples, len(samples), 220.0, 69.0)
    f0_hz, probability = _estimate_f0(shifted[2000:3280], sample_rate)

    assert len(shifted) == len(samples)
    assert f0_hz is not None
    assert abs(f0_hz - 440) < 20
    assert probability > 0.7


def test_relative_cent_pitch_shift_needs_no_source_f0_and_zero_is_exact() -> None:
    samples = np.sin(2 * np.pi * 220 * np.arange(8000) / 16000).astype(np.float32)
    unchanged = render_relative_pitched_audio(samples, len(samples), 0)
    np.testing.assert_array_equal(unchanged, samples)
    for cents in (-100, -25, 25, 100):
        shifted = render_relative_pitched_audio(samples, len(samples), cents)
        frequency = np.argmax(np.abs(np.fft.rfft(shifted[1000:-1000]))) * 16000 / len(shifted[1000:-1000])
        expected = 220 * 2 ** (cents / 1200)
        assert len(shifted) == len(samples)
        assert abs(frequency - expected) <= 2.5
    retimed = render_relative_pitched_audio(samples, 6400, 0)
    assert len(retimed) == 6400


def test_pitch_curve_changes_frequency_over_time_without_changing_duration() -> None:
    sample_rate = 16_000
    samples = np.sin(2 * np.pi * 220 * np.arange(sample_rate) / sample_rate).astype(np.float32)
    points = [PitchEnvelopePoint(0.0, 0), PitchEnvelopePoint(0.5, 0), PitchEnvelopePoint(1.0, 1200)]
    rendered = render_relative_pitch_curve(samples, points)
    assert len(rendered) == len(samples)
    for position in (0.2, 0.4, 0.6, 0.8):
        center = round(position * sample_rate)
        window = rendered[center - 1600 : center + 1600]
        frequency = np.argmax(np.abs(np.fft.rfft(window * np.hanning(len(window))))) * sample_rate / len(window)
        expected_cents = np.interp(position, [point.position for point in points], [point.cents for point in points])
        expected = 220 * 2 ** (expected_cents / 1200)
        assert abs(frequency - expected) <= 7, (position, frequency, expected)


def test_pitch_curve_plateaus_match_cents_and_silence_stays_exact() -> None:
    sample_rate = 16_000
    samples = np.sin(2 * np.pi * 220 * np.arange(sample_rate) / sample_rate).astype(np.float32)
    points = [PitchEnvelopePoint(0, 25), PitchEnvelopePoint(.25, 25), PitchEnvelopePoint(.75, 100), PitchEnvelopePoint(1, 100)]
    rendered = render_relative_pitch_curve(samples, points)
    assert len(rendered) == len(samples)
    for position, cents in ((.125, 25), (.875, 100)):
        center = round(position * sample_rate)
        window = rendered[center - 1600 : center + 1600]
        frequency = np.argmax(np.abs(np.fft.rfft(window * np.hanning(len(window))))) * sample_rate / len(window)
        expected = 220 * 2 ** (cents / 1200)
        assert abs(frequency - expected) <= 7
    silence = np.zeros(sample_rate, dtype=np.float32)
    assert render_relative_pitch_curve(silence, points).shape == silence.shape
    np.testing.assert_array_equal(render_relative_pitch_curve(silence, points), silence)
    assert np.isfinite(rendered).all()


def test_curve_offset_adds_region_base_pitch_once() -> None:
    sample_rate = 16_000
    samples = np.sin(2 * np.pi * 220 * np.arange(sample_rate) / sample_rate).astype(np.float32)
    points = [PitchEnvelopePoint(0, 100), PitchEnvelopePoint(1, 100)]
    rendered = render_relative_pitch_curve(samples, points, np.full(len(samples), 100, dtype=np.float32))
    window = rendered[6400:9600]
    frequency = np.argmax(np.abs(np.fft.rfft(window * np.hanning(len(window))))) * sample_rate / len(window)
    expected = 220 * 2 ** (200 / 1200)
    assert len(rendered) == len(samples)
    assert abs(frequency - expected) <= 6


def test_pitch_transition_moves_toward_next_pitch() -> None:
    sample_rate = 16_000
    samples = np.sin(
        2 * np.pi * 220 * np.arange(sample_rate // 2) / sample_rate
    ).astype(np.float32)

    shifted = render_pitched_audio(
        samples,
        len(samples),
        220.0,
        hz_to_midi(220.0),
        end_pitch_midi=69.0,
        end_transition_samples=4000,
    )
    start_f0, _ = _estimate_f0(shifted[500:1780], sample_rate)
    end_f0, _ = _estimate_f0(shifted[-1800:-520], sample_rate)

    assert start_f0 is not None
    assert end_f0 is not None
    assert start_f0 < end_f0


def test_formant_shift_moves_spectral_envelope() -> None:
    sample_rate = 16_000
    positions = np.arange(sample_rate // 2)
    samples = np.zeros(len(positions), dtype=np.float32)
    for harmonic in range(1, 50):
        frequency = 120 * harmonic
        if frequency >= sample_rate / 2:
            break
        amplitude = np.exp(-((frequency - 700) / 250) ** 2)
        amplitude += 0.7 * np.exp(-((frequency - 1300) / 350) ** 2)
        samples += (
            amplitude * np.sin(2 * np.pi * frequency * positions / sample_rate)
        ).astype(np.float32)
    samples /= np.max(np.abs(samples))

    preserved = render_pitched_audio(
        samples, len(samples), 120.0, hz_to_midi(120.0)
    )
    raised = render_pitched_audio(
        samples,
        len(samples),
        120.0,
        hz_to_midi(120.0),
        formant_shift_semitones=12.0,
    )

    assert _spectral_centroid(raised, sample_rate) > _spectral_centroid(
        preserved, sample_rate
    )


def test_pitch_context_connects_adjacent_parts() -> None:
    left = _phone_unit("left", 57.0)
    right = _phone_unit("right", 69.0)

    start_pitch, start_ms, end_pitch, end_ms = _pitch_context(
        [right], 0, previous_unit=left
    )

    assert start_pitch is not None
    assert start_ms == 40
    assert end_pitch is None
    assert end_ms == 0


def _spectral_centroid(samples: np.ndarray, sample_rate: int) -> float:
    magnitude = np.abs(np.fft.rfft(samples * np.hanning(len(samples))))
    frequencies = np.fft.rfftfreq(len(samples), 1 / sample_rate)
    return float(np.sum(magnitude * frequencies) / np.sum(magnitude))


def _phone_unit(phone_unit_id: str, target_pitch_midi: float) -> PhoneUnit:
    return PhoneUnit(
        phone_unit_id=phone_unit_id,
        operation=PhoneAlignmentOperation.MATCH,
        target_index=0,
        target_phone_id="ko.vowel.a",
        target_ipa="a",
        source_occurrence_id=phone_unit_id,
        source_phone_id="ko.vowel.a",
        source_ipa="a",
        source_start_ms=0,
        source_end_ms=100,
        output_duration_ms=100,
        source_f0_hz=220.0,
        voiced_probability=1.0,
        target_pitch_midi=target_pitch_midi,
    )
