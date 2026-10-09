import math
import wave
from pathlib import Path

import numpy as np

from madnolia.constants import (
    WORLD_PITCH_CONTEXT_MS,
    WORLD_PITCH_FRAME_PERIOD_MS,
    WORLD_PITCH_PEAK_LIMIT,
)
from madnolia.pitch_shift import midi_to_hz
from madnolia.types.common import EditRegion, TimelineSegment, WorldPitchAnalysis


def read_world_context(path: Path, start_ms: int, end_ms: int) -> tuple[np.ndarray, int, int]:
    with wave.open(str(path), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError(f"WORLD pitch requires mono 16-bit WAV: {path}")
        sample_rate = audio.getframerate()
        if sample_rate != 16000:
            raise ValueError(f"WORLD pitch requires 16 kHz WAV: {path}")
        context_start_ms = max(0, start_ms - WORLD_PITCH_CONTEXT_MS)
        context_end_ms = min(
            round(audio.getnframes() * 1000 / sample_rate),
            end_ms + WORLD_PITCH_CONTEXT_MS,
        )
        start = round(context_start_ms * sample_rate / 1000)
        end = round(context_end_ms * sample_rate / 1000)
        audio.setpos(start)
        samples = np.frombuffer(audio.readframes(end - start), dtype="<i2").astype(np.float64)
    return samples / 32768.0, sample_rate, context_start_ms


def analyze_world(samples: np.ndarray, sample_rate: int, source_start_ms: int = 0) -> WorldPitchAnalysis:
    import pyworld

    samples64 = np.asarray(samples, dtype=np.float64)
    f0, times = pyworld.dio(
        samples64,
        sample_rate,
        frame_period=WORLD_PITCH_FRAME_PERIOD_MS,
    )
    f0 = pyworld.stonemask(samples64, f0, times, sample_rate)
    spectrum = pyworld.cheaptrick(samples64, f0, times, sample_rate)
    aperiodicity = pyworld.d4c(samples64, f0, times, sample_rate)
    return WorldPitchAnalysis(
        samples=samples64,
        sample_rate=sample_rate,
        source_start_ms=source_start_ms,
        f0=f0,
        times_ms=times * 1000 + source_start_ms,
        spectrum=spectrum,
        aperiodicity=aperiodicity,
    )


def analyze_world_path(path: Path, start_ms: int, end_ms: int) -> WorldPitchAnalysis:
    samples, sample_rate, context_start_ms = read_world_context(path, start_ms, end_ms)
    return analyze_world(samples, sample_rate, context_start_ms)


def analyze_region_curve(path: Path, segment: TimelineSegment) -> WorldPitchAnalysis:
    start_ms = min(region.source_start_ms for region in segment.edit_regions)
    end_ms = max(region.source_end_ms for region in segment.edit_regions)
    return analyze_world_path(path, start_ms, end_ms)


def render_world_regions(
    path: Path,
    segment: TimelineSegment,
    regions: list[EditRegion] | None = None,
    pitch_notes=(),
) -> np.ndarray:
    import pyworld

    regions = regions if regions is not None else segment.edit_regions
    if not regions:
        return np.zeros(0, dtype=np.float32)
    output_durations = [max(0, region.output_duration_ms) for region in regions]
    total_duration_ms = sum(output_durations)
    target_length = round(total_duration_ms * 16)
    if target_length <= 0:
        return np.zeros(0, dtype=np.float32)
    if (
        total_duration_ms == sum(region.source_end_ms - region.source_start_ms for region in regions)
        and not segment.pitch_envelope
        and all(region.relative_pitch_cents == 0 and not region.pitch_points for region in regions)
        and not any(unit.vibrato_depth_cents > 0 for unit in segment.phone_units)
        and not any(note.start_ms < segment.timeline_end_ms and note.end_ms > segment.timeline_start_ms for note in pitch_notes)
    ):
        return read_exact_region_audio(path, regions)
    source_start_ms = min(region.source_start_ms for region in regions)
    source_end_ms = max(region.source_end_ms for region in regions)
    analysis = analyze_world_path(path, source_start_ms, source_end_ms)
    frame_count = max(2, math.ceil(total_duration_ms / WORLD_PITCH_FRAME_PERIOD_MS) + 1)
    output_times_ms = np.arange(frame_count, dtype=np.float64) * WORLD_PITCH_FRAME_PERIOD_MS
    source_times_ms, region_ids, normalized_positions = _map_output_to_source(
        output_times_ms, regions, output_durations
    )
    world_times = analysis.times_ms
    spectra = _interpolate_matrix(world_times, analysis.spectrum, source_times_ms)
    aperiodicity = _interpolate_matrix(world_times, analysis.aperiodicity, source_times_ms)
    f0_indices = np.searchsorted(world_times, source_times_ms).clip(0, len(world_times) - 1)
    previous_indices = np.maximum(0, f0_indices - 1)
    choose_previous = np.abs(world_times[previous_indices] - source_times_ms) < np.abs(
        world_times[f0_indices] - source_times_ms
    )
    f0_indices[choose_previous] = previous_indices[choose_previous]
    source_f0 = analysis.f0[f0_indices].copy()
    targets = source_f0.copy()
    absolute_times_ms = segment.timeline_start_ms + output_times_ms
    for index, region in enumerate(regions):
        active = region_ids == index
        if not np.any(active):
            continue
        local_positions = normalized_positions[active]
        local_source_times = source_times_ms[active]
        local_source_f0 = source_f0[active]
        region_target = local_source_f0.copy()
        if region.pitch_points:
            positions = np.asarray([point.position for point in region.pitch_points], dtype=np.float64)
            midis = np.asarray([point.midi for point in region.pitch_points], dtype=np.float64)
            target_midi = np.interp(local_positions, positions, midis)
            region_target[local_source_f0 > 0] = midi_to_hz(target_midi[local_source_f0 > 0])
        region_target *= 2 ** (region.relative_pitch_cents / 1200)
        if segment.pitch_envelope:
            output_positions = output_times_ms[active] / total_duration_ms
            offsets = np.interp(
                output_positions,
                [point.position for point in segment.pitch_envelope],
                [point.cents for point in segment.pitch_envelope],
            )
            region_target *= 2 ** (offsets / 1200)
        for unit in segment.phone_units:
            if (
                unit.source_start_ms is None
                or unit.source_end_ms is None
                or unit.vibrato_depth_cents <= 0
                or unit.vibrato_rate_hz <= 0
            ):
                continue
            active_unit = (local_source_times >= unit.source_start_ms) & (
                local_source_times < unit.source_end_ms
            )
            output_unit_ms = _map_source_to_output(
                local_source_times, regions, output_durations
            )
            unit_start_output_ms = _map_source_to_output(
                np.asarray([unit.source_start_ms], dtype=np.float64), regions, output_durations
            )[0]
            elapsed = output_unit_ms - unit_start_output_ms - unit.vibrato_start_ms
            vibrato_active = active_unit & (elapsed >= 0) & (local_source_f0 > 0)
            vibrato_cents = unit.vibrato_depth_cents * np.sin(
                2 * np.pi * unit.vibrato_rate_hz * elapsed[vibrato_active] / 1000
            )
            region_target[vibrato_active] *= 2 ** (vibrato_cents / 1200)
        voiced = local_source_f0 > 0
        targets[active] = np.where(voiced, region_target, 0.0)
    for note in pitch_notes:
        active = (absolute_times_ms >= note.start_ms) & (absolute_times_ms < note.end_ms)
        voiced = active & (source_f0 > 0)
        if not np.any(voiced):
            continue
        positions = np.clip((absolute_times_ms[voiced] - note.start_ms) / (note.end_ms - note.start_ms), 0, 1)
        note_midi = np.interp(
            positions,
            [point.position for point in note.pitch_points],
            [point.midi for point in note.pitch_points],
        )
        targets[voiced] = midi_to_hz(note_midi)
    synthesis = pyworld.synthesize(
        targets,
        spectra,
        aperiodicity,
        analysis.sample_rate,
        WORLD_PITCH_FRAME_PERIOD_MS,
    ).astype(np.float32)
    if len(synthesis) < target_length:
        synthesis = np.pad(synthesis, (0, target_length - len(synthesis)))
    else:
        synthesis = synthesis[:target_length]
    peak = float(np.max(np.abs(synthesis))) if len(synthesis) else 0.0
    if peak > WORLD_PITCH_PEAK_LIMIT:
        synthesis *= WORLD_PITCH_PEAK_LIMIT / peak
    return synthesis


def read_exact_region_audio(path: Path, regions: list[EditRegion]) -> np.ndarray:
    pieces = []
    with wave.open(str(path), "rb") as audio:
        rate = audio.getframerate()
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or rate != 16000:
            raise ValueError(f"Expected 16 kHz mono 16-bit WAV: {path}")
        for region in regions:
            start = round(region.source_start_ms * rate / 1000)
            end = round(region.source_end_ms * rate / 1000)
            start = min(audio.getnframes(), max(0, start))
            end = min(audio.getnframes(), max(start, end))
            audio.setpos(start)
            pieces.append(np.frombuffer(audio.readframes(end - start), dtype="<i2"))
    if not pieces:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(pieces).astype(np.float32) / 32768.0


def _map_output_to_source(output_times_ms, regions, output_durations):
    source_times = np.empty(len(output_times_ms), dtype=np.float64)
    region_ids = np.zeros(len(output_times_ms), dtype=np.int64)
    normalized = np.zeros(len(output_times_ms), dtype=np.float64)
    edges = np.cumsum([0, *output_durations])
    indices = np.searchsorted(edges[1:], output_times_ms, side="right").clip(0, len(regions) - 1)
    for index, region in enumerate(regions):
        active = indices == index
        duration = max(1, output_durations[index])
        position = np.clip((output_times_ms[active] - edges[index]) / duration, 0, 1)
        normalized[active] = position
        source_times[active] = region.source_start_ms + position * (
            region.source_end_ms - region.source_start_ms
        )
        region_ids[active] = index
    return source_times, region_ids, normalized


def _map_source_to_output(source_times_ms, regions, output_durations):
    output_times = np.zeros(len(source_times_ms), dtype=np.float64)
    edges = np.cumsum([0, *output_durations])
    for region_index, region in enumerate(regions):
        active = (source_times_ms >= region.source_start_ms) & (
            source_times_ms < region.source_end_ms
        )
        source_duration = max(1, region.source_end_ms - region.source_start_ms)
        output_times[active] = edges[region_index] + (
            source_times_ms[active] - region.source_start_ms
        ) * output_durations[region_index] / source_duration
    return output_times


def _interpolate_matrix(frame_times, values, target_times):
    indices = np.searchsorted(frame_times, target_times).clip(0, len(frame_times) - 1)
    previous = np.maximum(indices - 1, 0)
    left_times = frame_times[previous]
    right_times = frame_times[indices]
    mix = np.divide(
        target_times - left_times,
        right_times - left_times,
        out=np.zeros_like(target_times),
        where=right_times > left_times,
    )
    mix = np.clip(mix, 0, 1)[:, None]
    return values[previous] * (1 - mix) + values[indices] * mix
