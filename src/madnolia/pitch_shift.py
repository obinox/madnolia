import numpy as np

from madnolia.constants import (
    FORMANT_ENVELOPE_LIFTER,
    FORMANT_GAIN_MAX,
    FORMANT_GAIN_MIN,
    PITCH_CURVE_FRAME_SAMPLES,
    PITCH_CURVE_HOP_SAMPLES,
    PITCH_CURVE_PHASE_ALIGN_SAMPLES,
    PITCH_CURVE_STATIC_TOLERANCE_CENTS,
    PITCH_SHIFT_FRAME_SAMPLES,
    PITCH_SHIFT_HOP_SAMPLES,
    PROFESSIONAL_PITCH_SHIFT_MIN_SEMITONES,
)
from madnolia.time_stretch import stretch_audio
from madnolia.types.common import PitchEnvelopePoint


def hz_to_midi(frequency_hz: float) -> float:
    return 69.0 + 12.0 * float(np.log2(frequency_hz / 440.0))


def midi_to_hz(midi_pitch: float) -> float:
    return 440.0 * 2.0 ** ((midi_pitch - 69.0) / 12.0)


def render_pitched_audio(
    samples: np.ndarray,
    target_length: int,
    source_f0_hz: float | None,
    target_pitch_midi: float | None,
    start_pitch_midi: float | None = None,
    start_transition_samples: int = 0,
    end_pitch_midi: float | None = None,
    end_transition_samples: int = 0,
    formant_shift_semitones: float = 0.0,
    vibrato_depth_cents: int = 0,
    vibrato_rate_hz: float = 0.0,
    vibrato_start_samples: int = 0,
) -> np.ndarray:
    stretched = stretch_audio(samples, target_length)
    if source_f0_hz is None or target_pitch_midi is None or len(stretched) < 2:
        return stretched
    source_pitch = hz_to_midi(source_f0_hz)
    frame_size = min(PITCH_SHIFT_FRAME_SAMPLES, len(stretched))
    hop = min(PITCH_SHIFT_HOP_SAMPLES, max(1, frame_size // 2))
    last_start = len(stretched) - frame_size
    positions = list(range(0, last_start, hop)) + [last_start]
    positions = list(dict.fromkeys(positions))
    window = np.hanning(frame_size + 2)[1:-1].astype(np.float32)
    output = np.zeros(len(stretched), dtype=np.float32)
    weights = np.zeros(len(stretched), dtype=np.float32)
    for position in positions:
        center = position + frame_size // 2
        pitch = _pitch_at(
            center,
            len(stretched),
            target_pitch_midi,
            start_pitch_midi,
            start_transition_samples,
            end_pitch_midi,
            end_transition_samples,
        )
        if vibrato_depth_cents and center >= vibrato_start_samples:
            pitch += vibrato_depth_cents / 100 * np.sin(
                2 * np.pi * vibrato_rate_hz * (center - vibrato_start_samples) / 16000
            )
        frame = stretched[position : position + frame_size]
        shifted = _shift_frame(frame, pitch - source_pitch, formant_shift_semitones)
        output[position : position + frame_size] += shifted * window
        weights[position : position + frame_size] += window
    return output / np.maximum(weights, np.finfo(np.float32).eps)


def render_relative_pitched_audio(samples: np.ndarray, target_length: int, cents: int) -> np.ndarray:
    if cents == 0 and target_length == len(samples):
        return samples.astype(np.float32, copy=True)
    stretched = stretch_audio(samples, target_length)
    if cents == 0 or len(stretched) < 2:
        return stretched
    return _shift_frame(stretched, cents / 100, 0)


def render_relative_pitch_curve(
    samples: np.ndarray,
    points: list[PitchEnvelopePoint],
    base_cents: np.ndarray | None = None,
) -> np.ndarray:
    if len(samples) < 2 or not points and base_cents is None:
        return samples.astype(np.float32, copy=True)
    if points and all(point.cents == points[0].cents for point in points) and (base_cents is None or np.all(base_cents == base_cents[0])):
        return render_relative_pitched_audio(samples, len(samples), int(points[0].cents + (base_cents[0] if base_cents is not None else 0)))
    if (not points or all(point.cents == 0 for point in points)) and (base_cents is None or np.all(base_cents == 0)):
        return samples.astype(np.float32, copy=True)
    length = len(samples)
    positions = np.array([point.position for point in points], dtype=np.float64)
    cents = np.array([point.cents for point in points], dtype=np.float64)
    relative = np.linspace(0, 1, length, endpoint=True, dtype=np.float64)
    target_cents = np.interp(relative, positions, cents) if points else np.zeros(length, dtype=np.float64)
    if base_cents is not None:
        target_cents += base_cents
    if np.all(target_cents == 0):
        return samples.astype(np.float32, copy=True)
    ratios = np.exp2(target_cents / 1200.0)
    cumulative = np.empty(length, dtype=np.float64)
    cumulative[0] = 0
    if length > 1:
        cumulative[1:] = np.cumsum((ratios[:-1] + ratios[1:]) * 0.5)
    mean_ratio = cumulative[-1] / (length - 1)
    resampled_length = max(2, round((length - 1) / mean_ratio) + 1)
    output_positions = np.linspace(0, 1, resampled_length, dtype=np.float64)
    source_positions = np.interp(output_positions, relative, cumulative / cumulative[-1]) * (length - 1)
    resampled = np.interp(source_positions, np.arange(length), samples).astype(np.float32)
    return stretch_audio(resampled, length)


def render_local_pitch_curve(samples: np.ndarray, cents: np.ndarray) -> np.ndarray:
    if len(samples) < 2 or len(cents) != len(samples) or np.all(cents == 0):
        return samples.astype(np.float32, copy=True)
    if np.ptp(cents) <= PITCH_CURVE_STATIC_TOLERANCE_CENTS:
        return render_relative_pitched_audio(samples, len(samples), round(float(cents[0])))
    length = len(samples)
    frame_size = min(PITCH_CURVE_FRAME_SAMPLES, length)
    if length <= PITCH_CURVE_FRAME_SAMPLES:
        return render_relative_pitch_curve(
            samples,
            [PitchEnvelopePoint(0.0, 0), PitchEnvelopePoint(1.0, 0)],
            cents,
        )
    hop = min(PITCH_CURVE_HOP_SAMPLES, max(1, frame_size // 2))
    last_start = length - frame_size
    starts = list(range(0, last_start + 1, hop))
    if starts[-1] != last_start:
        starts.append(last_start)
    window = np.hanning(frame_size + 2)[1:-1].astype(np.float32)
    output = np.zeros(length, dtype=np.float32)
    weights = np.zeros(length, dtype=np.float32)
    for start in starts:
        shifted = render_relative_pitch_curve(
            samples[start : start + frame_size],
            [PitchEnvelopePoint(0.0, 0), PitchEnvelopePoint(1.0, 0)],
            cents[start : start + frame_size],
        )
        if start:
            overlap = min(frame_size - hop, length - start)
            previous = output[start : start + overlap] / np.maximum(
                weights[start : start + overlap], np.finfo(np.float32).eps
            )
            maximum_shift = min(PITCH_CURVE_PHASE_ALIGN_SAMPLES, max(0, overlap // 4))
            best_shift = 0
            best_score = -np.inf
            for shift in range(-maximum_shift, maximum_shift + 1):
                if shift < 0:
                    left, right = previous[-shift:], shifted[: overlap + shift]
                elif shift > 0:
                    left, right = previous[: overlap - shift], shifted[shift : overlap]
                else:
                    left, right = previous, shifted[:overlap]
                left = left - np.mean(left)
                right = right - np.mean(right)
                score = float(np.dot(left, right)) / max(
                    float(np.sqrt(np.dot(left, left) * np.dot(right, right))),
                    np.finfo(np.float32).eps,
                )
                if score > best_score:
                    best_shift, best_score = shift, score
            if best_shift > 0:
                shifted = np.pad(shifted[best_shift:], (0, best_shift), mode="reflect")
            elif best_shift < 0:
                shifted = np.pad(shifted[:best_shift], (-best_shift, 0), mode="reflect")
        output[start : start + frame_size] += shifted * window
        weights[start : start + frame_size] += window
    return output / np.maximum(weights, np.finfo(np.float32).eps)


def _pitch_at(
    position: int,
    length: int,
    target_pitch: float,
    start_pitch: float | None,
    start_samples: int,
    end_pitch: float | None,
    end_samples: int,
) -> float:
    if start_pitch is not None and start_samples > 0 and position < start_samples:
        progress = _smooth(position / start_samples)
        return start_pitch + (target_pitch - start_pitch) * progress
    if end_pitch is not None and end_samples > 0 and position > length - end_samples:
        progress = _smooth((position - (length - end_samples)) / end_samples)
        return target_pitch + (end_pitch - target_pitch) * progress
    return target_pitch


def _shift_frame(
    samples: np.ndarray, semitones: float, formant_shift_semitones: float
) -> np.ndarray:
    if abs(semitones) < PROFESSIONAL_PITCH_SHIFT_MIN_SEMITONES and abs(formant_shift_semitones) < PROFESSIONAL_PITCH_SHIFT_MIN_SEMITONES:
        return samples.copy()
    if abs(semitones) < PROFESSIONAL_PITCH_SHIFT_MIN_SEMITONES:
        shifted = samples.copy()
    else:
        ratio = 2.0 ** (semitones / 12.0)
        resampled_length = max(2, round(len(samples) / ratio))
        source_positions = np.arange(len(samples), dtype=np.float64)
        target_positions = np.linspace(0, len(samples) - 1, resampled_length)
        resampled = np.interp(target_positions, source_positions, samples).astype(np.float32)
        shifted = stretch_audio(resampled, len(samples))
    return _correct_formants(samples, shifted, formant_shift_semitones)


def _correct_formants(
    source: np.ndarray, shifted: np.ndarray, formant_shift_semitones: float
) -> np.ndarray:
    source_envelope = _spectral_envelope(source)
    shifted_envelope = _spectral_envelope(shifted)
    bins = np.arange(len(source_envelope), dtype=np.float64)
    ratio = 2.0 ** (formant_shift_semitones / 12.0)
    target_envelope = np.interp(
        bins / ratio,
        bins,
        source_envelope,
        left=source_envelope[0],
        right=source_envelope[-1],
    )
    gain = np.clip(
        np.exp(target_envelope - shifted_envelope),
        FORMANT_GAIN_MIN,
        FORMANT_GAIN_MAX,
    )
    spectrum = np.fft.rfft(shifted)
    corrected = np.fft.irfft(spectrum * gain, n=len(shifted)).astype(np.float32)
    source_rms = float(np.sqrt(np.mean(np.square(shifted))))
    corrected_rms = float(np.sqrt(np.mean(np.square(corrected))))
    if corrected_rms > 1e-8:
        corrected *= source_rms / corrected_rms
    return np.clip(corrected, -1.0, 1.0)


def _spectral_envelope(samples: np.ndarray) -> np.ndarray:
    windowed = samples * np.hanning(len(samples))
    log_magnitude = np.log(np.maximum(np.abs(np.fft.rfft(windowed)), 1e-7))
    cepstrum = np.fft.irfft(log_magnitude, n=len(samples))
    liftered = np.zeros_like(cepstrum)
    keep = min(FORMANT_ENVELOPE_LIFTER, max(1, len(cepstrum) // 2))
    liftered[:keep] = cepstrum[:keep]
    if keep > 1:
        liftered[-keep + 1 :] = cepstrum[-keep + 1 :]
    return np.fft.rfft(liftered).real


def _smooth(value: float) -> float:
    clamped = min(1.0, max(0.0, value))
    return clamped * clamped * (3.0 - 2.0 * clamped)
