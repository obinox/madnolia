import math
import wave
from dataclasses import replace
from itertools import pairwise
from pathlib import Path

import numpy as np

from madnolia.constants import (
    AUTOTUNE_CURVE_TOLERANCE_CENTS,
    AUTOTUNE_FRAME_MS,
    AUTOTUNE_MAX_F0_HZ,
    AUTOTUNE_MIN_F0_HZ,
    AUTOTUNE_MIN_PERIODICITY,
    AUTOTUNE_MIN_RMS,
    AUTOTUNE_PEAK_CORRELATION_TOLERANCE,
    AUTOTUNE_WINDOW_MS,
    WORLD_PITCH_FRAME_PERIOD_MS,
)
from madnolia.pitch_shift import hz_to_midi, midi_to_hz
from madnolia.projects import audio_path
from madnolia.types.common import (
    AutotuneSegmentResult,
    CompositionPitchAnalysis,
    EditRegion,
    PhonePitchContour,
    PhonePitchOwnerRef,
    PhonePitchPoint,
    PhoneUnit,
    PitchCurvePoint,
    PitchEnvelopePoint,
    RegionPitchContour,
    SegmentPitchContour,
    TimelineSegment,
)
from madnolia.world_pitch import analyze_world_path


def generate_autotune_envelopes(
    project_dir: Path,
    segments: list[TimelineSegment],
    strength_percent: int,
    speed_ms: int,
) -> list[AutotuneSegmentResult]:
    tuned = {}
    for segment in segments:
        path = audio_path(project_dir, segment.source_id)
        source, sample_rate = _read_source(path, segment.source_start_ms, segment.source_end_ms)
        f0, voiced, frame_times = _estimate_f0(source, sample_rate)
        if segment.edit_regions:
            if strength_percent <= 0:
                tuned[segment.segment_id] = (
                    [],
                    [replace(region, source_f0_hz=None, pitch_points=[]) for region in segment.edit_regions],
                )
                continue
            world_analysis = analyze_world_path(
                path, segment.source_start_ms, segment.source_end_ms
            )
            regions = []
            previous_correction = 0.0
            previous_output_ms = None
            output_offset_ms = 0.0
            for region in segment.edit_regions:
                selected = (
                    (world_analysis.times_ms >= region.source_start_ms)
                    & (world_analysis.times_ms < region.source_end_ms)
                    & (world_analysis.f0 > 0)
                )
                region_f0 = world_analysis.f0[selected]
                source_f0 = float(np.median(region_f0)) if len(region_f0) else None
                points = []
                if source_f0 is not None:
                    for frequency, source_time_ms in zip(
                        world_analysis.f0[selected],
                        world_analysis.times_ms[selected],
                        strict=True,
                    ):
                        source_midi = hz_to_midi(float(frequency))
                        correction = (
                            round(source_midi + region.relative_pitch_cents / 100)
                            - region.relative_pitch_cents / 100
                            - source_midi
                        ) * strength_percent / 100
                        output_ms = output_offset_ms + (
                            source_time_ms - region.source_start_ms
                        ) * region.output_duration_ms / max(
                            1, region.source_end_ms - region.source_start_ms
                        )
                        elapsed_ms = (
                            output_ms - previous_output_ms
                            if previous_output_ms is not None
                            else WORLD_PITCH_FRAME_PERIOD_MS
                        )
                        alpha = (
                            1.0
                            if speed_ms <= 0
                            else 1.0 - math.exp(-max(0.0, elapsed_ms) / speed_ms)
                        )
                        previous_correction += alpha * (correction - previous_correction)
                        position = min(
                            1.0,
                            max(
                                0.0,
                                (source_time_ms - region.source_start_ms)
                                / max(1, region.source_end_ms - region.source_start_ms),
                            ),
                        )
                        points.append(
                            PhonePitchPoint(position, source_midi + previous_correction)
                        )
                        previous_output_ms = output_ms
                if len(points) == 1:
                    points = [
                        PhonePitchPoint(0.0, points[0].midi),
                        PhonePitchPoint(1.0, points[0].midi),
                    ]
                elif len(points) > 1:
                    points[0] = PhonePitchPoint(0.0, points[0].midi)
                    points[-1] = PhonePitchPoint(1.0, points[-1].midi)
                regions.append(
                    replace(region, source_f0_hz=source_f0, pitch_points=points)
                )
                output_offset_ms += region.output_duration_ms
            tuned[segment.segment_id] = ([], regions)
            continue
        previous_correction = 0.0
        units = []
        for unit in segment.phone_units:
            source_f0_hz = _unit_median_hz(unit, segment, f0, voiced, frame_times)
            if source_f0_hz is None:
                units.append(replace(unit, pitch_points=[], pitch_owner_ref=None))
                previous_correction = 0.0
                continue
            source_midi = hz_to_midi(source_f0_hz)
            if unit.target_pitch_midi is not None:
                strength = unit.target_pitch_strength_percent / 100
                midi = source_midi + (unit.target_pitch_midi - source_midi) * strength
            else:
                correction = (round(source_midi) - source_midi) * strength_percent / 100
                output_ms = _unit_output_duration(segment, unit)
                alpha = 1.0 if speed_ms == 0 else 1.0 - math.exp(-output_ms / speed_ms)
                previous_correction += alpha * (correction - previous_correction)
                midi = source_midi + previous_correction
            points = [PhonePitchPoint(position=0.0, midi=midi), PhonePitchPoint(position=1.0, midi=midi)]
            units.append(replace(unit, source_f0_hz=source_f0_hz, pitch_points=points, pitch_owner_ref=None))
        tuned[segment.segment_id] = (units, [])

    lane_segments = {}
    for segment in segments:
        if segment.edit_regions:
            lane_segments.setdefault(segment.lane, []).append(segment)
    for lane in lane_segments.values():
        lane.sort(key=lambda item: (item.timeline_start_ms, item.segment_id))
        components = []
        for segment in lane:
            if not components or components[-1][-1].timeline_end_ms != segment.timeline_start_ms:
                components.append([segment])
            else:
                components[-1].append(segment)
        for component in components:
            entries = [
                (segment, index, region)
                for segment in component
                for index, region in enumerate(tuned[segment.segment_id][1])
            ]
            targets = [region.pitch_points[0].midi if region.pitch_points else None for _, _, region in entries]
            for index, target in enumerate(targets):
                if target is not None:
                    continue
                inherited = next((value for value in targets[index + 1 :] if value is not None), None)
                if inherited is None:
                    inherited = next((value for value in reversed(targets[:index]) if value is not None), None)
                if inherited is not None:
                    segment, region_index, region = entries[index]
                    regions = list(tuned[segment.segment_id][1])
                    regions[region_index] = replace(
                        region,
                        pitch_points=[PhonePitchPoint(0.0, inherited), PhonePitchPoint(1.0, inherited)],
                    )
                    tuned[segment.segment_id] = (tuned[segment.segment_id][0], regions)

    legacy_segments = [segment for segment in segments if not segment.edit_regions]
    owner_refs = _autotune_owner_refs(legacy_segments, {segment.segment_id: tuned[segment.segment_id][0] for segment in legacy_segments})
    results = []
    for segment in segments:
        if segment.edit_regions:
            results.append(AutotuneSegmentResult(
                segment_id=segment.segment_id,
                phone_units=[replace(unit, pitch_points=[], pitch_owner_ref=None) for unit in segment.phone_units],
                pitch_envelope=[],
                edit_regions=tuned[segment.segment_id][1],
            ))
            continue
        units = [
            replace(
                unit,
                pitch_owner_ref=owner_refs.get((segment.segment_id, unit.phone_unit_id)),
                pitch_points=(
                    unit.pitch_points
                    if owner_refs.get((segment.segment_id, unit.phone_unit_id))
                    == PhonePitchOwnerRef(segment.segment_id, unit.phone_unit_id)
                    else []
                ),
            )
            for unit in tuned[segment.segment_id][0]
        ]
        results.append(AutotuneSegmentResult(segment_id=segment.segment_id, phone_units=units))
    return results


def _unit_median_hz(unit, segment, f0, voiced, frame_times):
    if unit.source_start_ms is not None and unit.source_end_ms is not None and len(frame_times):
        local_times = frame_times + segment.source_start_ms
        half_window = AUTOTUNE_WINDOW_MS / 2
        selected = (
            voiced
            & (local_times - half_window >= unit.source_start_ms)
            & (local_times + half_window <= unit.source_end_ms)
        )
        if np.any(selected):
            return float(np.median(f0[selected]))
    if unit.source_f0_hz is not None and unit.source_f0_hz > 0:
        return unit.source_f0_hz
    return None


def _unit_output_duration(segment, unit):
    if segment.edit_regions and unit.source_start_ms is not None and unit.source_end_ms is not None:
        start = _source_to_output_ms(segment, unit.source_start_ms)
        end = _source_to_output_ms(segment, unit.source_end_ms)
        return max(0.0, end - start)
    return float(unit.output_duration_ms)


def _autotune_owner_refs(segments, tuned_units):
    references = {}
    lanes = {}
    for segment in sorted(segments, key=lambda item: (item.lane, item.timeline_start_ms, item.segment_id)):
        lanes.setdefault(segment.lane, []).append(segment)
    for lane_segments in lanes.values():
        components = []
        for segment in lane_segments:
            if not components or components[-1][-1].timeline_end_ms != segment.timeline_start_ms:
                components.append([segment])
            else:
                components[-1].append(segment)
        for component in components:
            entries = [
                (segment, unit, tuned)
                for segment in component
                for unit, tuned in zip(segment.phone_units, tuned_units[segment.segment_id], strict=True)
            ]
            vowel_indices = [
                index
                for index, (_, unit, tuned) in enumerate(entries)
                if _is_vowel(unit) and tuned.pitch_points
            ]
            for index, (segment, unit, tuned) in enumerate(entries):
                key = (segment.segment_id, unit.phone_unit_id)
                if tuned.pitch_points:
                    references[key] = PhonePitchOwnerRef(segment.segment_id, unit.phone_unit_id)
                    continue
                next_vowels = [vowel for vowel in vowel_indices if vowel > index]
                previous_vowels = [vowel for vowel in vowel_indices if vowel < index]
                owner_index = next_vowels[0] if next_vowels else previous_vowels[-1] if previous_vowels else None
                if owner_index is not None:
                    owner_segment, owner, _ = entries[owner_index]
                    references[key] = PhonePitchOwnerRef(owner_segment.segment_id, owner.phone_unit_id)
    return references


def _is_vowel(unit: PhoneUnit) -> bool:
    return any(
        value and ".vowel." in value.lower()
        for value in (unit.target_phone_id, unit.source_phone_id)
    )


def build_phone_pitch_groups(segments):
    members = {}
    owners = {}
    for segment in segments:
        cursor = 0.0
        for unit in segment.phone_units:
            if segment.edit_regions and unit.source_start_ms is not None and unit.source_end_ms is not None:
                start = _source_to_output_ms(segment, unit.source_start_ms)
                end = _source_to_output_ms(segment, unit.source_end_ms)
            else:
                start = cursor
                end = cursor + unit.output_duration_ms
            cursor = end
            key = _pitch_owner_key(segment.segment_id, unit)
            if key is None:
                continue
            members.setdefault(key, []).append((segment.timeline_start_ms + start, segment.timeline_start_ms + end))
            if unit.pitch_points:
                owners[key] = unit.pitch_points
    return {
        key: (points, min(start for start, _ in members[key]), max(end for _, end in members[key]))
        for key, points in owners.items()
    }


def _pitch_owner_key(segment_id, unit):
    if unit.pitch_owner_ref is not None:
        return unit.pitch_owner_ref.segment_id, unit.pitch_owner_ref.phone_unit_id
    if unit.pitch_points:
        return segment_id, unit.phone_unit_id
    return None


def analyze_composition_pitch(
    project_dir: Path,
    segments: list[TimelineSegment],
    pitch_notes=(),
) -> CompositionPitchAnalysis:
    pitch_groups = build_phone_pitch_groups(segments)
    ordered = sorted(segments, key=lambda item: (item.timeline_start_ms, item.segment_id))
    analyzed = {}
    for index, segment in enumerate(ordered):
        previous = ordered[index - 1] if index else None
        following = ordered[index + 1] if index + 1 < len(ordered) else None
        previous_unit = (
            previous.phone_units[-1]
            if previous and previous.phone_units and segment.timeline_start_ms == previous.timeline_end_ms
            else None
        )
        next_unit = (
            following.phone_units[0]
            if following and following.phone_units and segment.timeline_end_ms == following.timeline_start_ms
            else None
        )
        contour = _analyze_segment_pitch(
            project_dir, segment, True, previous_unit, next_unit, pitch_groups
        )
        if pitch_notes:
            contour = _apply_pitch_notes_to_contour(contour, segment, pitch_notes)
        analyzed[segment.segment_id] = contour
    return CompositionPitchAnalysis(segments=[analyzed[segment.segment_id] for segment in segments])


def _apply_pitch_notes_to_contour(contour, segment: TimelineSegment, pitch_notes):
    duration = max(1, segment.timeline_end_ms - segment.timeline_start_ms)

    def apply(points):
        updated = []
        for point in points:
            if point.hz is None:
                updated.append(point)
                continue
            time_ms = segment.timeline_start_ms + point.position * duration
            note = next((item for item in reversed(pitch_notes) if item.start_ms <= time_ms < item.end_ms), None)
            if note is None:
                updated.append(point)
                continue
            position = (time_ms - note.start_ms) / max(1, note.end_ms - note.start_ms)
            midi = np.interp(position, [item.position for item in note.pitch_points], [item.midi for item in note.pitch_points])
            updated.append(replace(point, hz=float(midi_to_hz(midi))))
        return updated

    phones = [replace(phone, corrected=apply(phone.corrected)) for phone in contour.phones]
    regions = [replace(region, corrected=apply(region.corrected)) for region in contour.regions]
    return replace(contour, phones=phones, regions=regions)


def build_segment_pitch_curve(
    project_dir: Path,
    segment: TimelineSegment,
    previous_unit: PhoneUnit | None = None,
    next_unit: PhoneUnit | None = None,
) -> list[PitchEnvelopePoint]:
    contour = _analyze_segment_pitch(
        project_dir, segment, False, previous_unit, next_unit
    )
    base_points: dict[float, list[float]] = {}
    if contour.regions:
        for region in contour.regions:
            for original, corrected in zip(region.original, region.corrected, strict=True):
                offset_cents = 0.0
                if original.hz and corrected.hz:
                    offset_cents = 1200 * np.log2(corrected.hz / original.hz)
                base_points.setdefault(original.position, []).append(float(offset_cents))
        return [
            PitchEnvelopePoint(position=position, cents=round(sum(values) / len(values)))
            for position, values in sorted(base_points.items())
        ]
    for phone in contour.phones:
        for original, corrected in zip(phone.original, phone.corrected, strict=True):
            offset_cents = 0.0
            if original.hz and corrected.hz:
                offset_cents = 1200 * np.log2(corrected.hz / original.hz)
            base_points.setdefault(original.position, []).append(float(offset_cents))
    return [
        PitchEnvelopePoint(position=position, cents=round(sum(values) / len(values)))
        for position, values in sorted(base_points.items())
    ]


def _analyze_segment_pitch(
    project_dir: Path,
    segment: TimelineSegment,
    include_layer_offsets: bool = True,
    previous_unit: PhoneUnit | None = None,
    next_unit: PhoneUnit | None = None,
    pitch_groups=None,
) -> SegmentPitchContour:
    if segment.edit_regions and any(region.pitch_points for region in segment.edit_regions):
        legacy_segment = replace(
            segment,
            edit_regions=[replace(region, pitch_points=[]) for region in segment.edit_regions],
        )
        legacy = _analyze_segment_pitch(
            project_dir,
            legacy_segment,
            include_layer_offsets,
            previous_unit,
            next_unit,
            pitch_groups,
        )
        world_analysis = analyze_world_path(
            audio_path(project_dir, segment.source_id),
            min(region.source_start_ms for region in segment.edit_regions),
            max(region.source_end_ms for region in segment.edit_regions),
        )
        total_duration = max(1, sum(region.output_duration_ms for region in segment.edit_regions))
        output_offset = 0
        regions = []
        for region in segment.edit_regions:
            if not region.pitch_points:
                legacy_region = next(
                    contour for contour in legacy.regions if contour.region_id == region.region_id
                )
                regions.append(legacy_region)
                output_offset += region.output_duration_ms
                continue
            original = []
            corrected = []
            target_points = region.pitch_points
            selected = (
                (world_analysis.times_ms >= region.source_start_ms)
                & (world_analysis.times_ms < region.source_end_ms)
            )
            frequencies = world_analysis.f0[selected]
            source_times = world_analysis.times_ms[selected]
            for frequency, source_ms in zip(frequencies, source_times, strict=True):
                time_ms = source_ms - region.source_start_ms
                output_ms = output_offset + time_ms * region.output_duration_ms / max(1, region.source_end_ms - region.source_start_ms)
                position = min(1.0, max(0.0, output_ms / total_duration))
                original_hz = float(frequency) if frequency > 0 else None
                corrected_hz = None
                if frequency > 0:
                    region_position = min(1.0, max(0.0, time_ms / max(1, region.source_end_ms - region.source_start_ms)))
                    target_midi = (
                        float(np.interp(
                            region_position,
                            [point.position for point in target_points],
                            [point.midi for point in target_points],
                        ))
                        if target_points
                        else hz_to_midi(float(frequency))
                    )
                    if include_layer_offsets:
                        target_midi += region.relative_pitch_cents / 100
                        if segment.pitch_envelope:
                            target_midi += float(np.interp(
                                position,
                                [point.position for point in segment.pitch_envelope],
                                [point.cents for point in segment.pitch_envelope],
                            )) / 100
                        source_ms = region.source_start_ms + time_ms
                        for unit in segment.phone_units:
                            if unit.source_start_ms is not None and unit.source_start_ms <= source_ms <= (unit.source_end_ms or unit.source_start_ms):
                                unit_start = _source_to_output_ms(segment, unit.source_start_ms)
                                target_midi += _vibrato_cents(unit, output_ms - unit_start) / 100
                                break
                    corrected_hz = midi_to_hz(target_midi)
                original.append(PitchCurvePoint(position=position, hz=original_hz))
                corrected.append(PitchCurvePoint(position=position, hz=corrected_hz))
            regions.append(RegionPitchContour(
                region_id=region.region_id,
                source_start_ms=region.source_start_ms,
                source_end_ms=region.source_end_ms,
                output_start_ms=output_offset,
                output_end_ms=output_offset + region.output_duration_ms,
                original=original,
                corrected=corrected,
            ))
            output_offset += region.output_duration_ms
        return replace(legacy, regions=regions)
    duration = max(1, sum(region.output_duration_ms for region in segment.edit_regions) if segment.edit_regions else segment.timeline_end_ms - segment.timeline_start_ms)
    context_units = ([previous_unit] if previous_unit else []) + segment.phone_units + ([next_unit] if next_unit else [])
    context_offset = 1 if previous_unit else 0
    phone_bounds = []
    cursor = 0
    for index, unit in enumerate(segment.phone_units):
        if segment.edit_regions and unit.source_start_ms is not None and unit.source_end_ms is not None:
            output_start = _source_to_output_ms(segment, unit.source_start_ms)
            output_end = _source_to_output_ms(segment, unit.source_end_ms)
        else:
            output_start = cursor
            output_end = cursor + unit.output_duration_ms
        phone_bounds.append((output_start, output_end))
        cursor = output_end
    measured = []
    if previous_unit:
        measured.append(_measure_unit_pitch(previous_unit))
    for unit in segment.phone_units:
        if unit.source_start_ms is None or unit.source_end_ms is None:
            measured.append((np.zeros(0), np.zeros(0, dtype=bool), np.zeros(0)))
            continue
        source, sample_rate = _read_source(
            audio_path(project_dir, segment.source_id),
            unit.source_start_ms,
            unit.source_end_ms,
        )
        measured.append(_estimate_f0(source, sample_rate))
    if next_unit:
        measured.append(_measure_unit_pitch(next_unit))

    median_pitches = []
    for f0, voiced, _ in measured:
        median_pitches.append(
            hz_to_midi(float(np.median(f0[voiced]))) if np.any(voiced) else None
        )

    phones = []
    local_measured = measured[context_offset : context_offset + len(segment.phone_units)]
    for index, (unit, bounds, measurements) in enumerate(zip(segment.phone_units, phone_bounds, local_measured, strict=True)):
        if unit.source_start_ms is None or unit.source_end_ms is None:
            continue
        f0, voiced, frame_times = measurements
        original = []
        corrected = []
        output_start, output_end = bounds
        for frequency, is_voiced, time_ms in zip(f0, voiced, frame_times, strict=True):
            source_ms = unit.source_start_ms + time_ms
            output_ms = _source_to_output_ms(segment, source_ms) if segment.edit_regions else output_start + time_ms / max(1, unit.source_end_ms - unit.source_start_ms) * (output_end - output_start)
            position = min(1.0, max(0.0, output_ms / duration))
            original_hz = float(frequency) if is_voiced else None
            corrected_hz = None
            if is_voiced:
                measured_midi = hz_to_midi(float(frequency))
                owner_key = _pitch_owner_key(segment.segment_id, unit)
                group = pitch_groups.get(owner_key) if pitch_groups and owner_key else None
                if group:
                    if unit.source_f0_hz is not None or unit.pitch_points:
                        points, group_start, group_end = group
                        group_position = (segment.timeline_start_ms + output_ms - group_start) / max(1e-9, group_end - group_start)
                        target_midi = float(np.interp(
                            group_position,
                            [point.position for point in points],
                            [point.midi for point in points],
                        ))
                        correction_cents = _vibrato_cents(unit, output_ms - output_start)
                        if include_layer_offsets:
                            correction_cents += _region_pitch_cents_at_source(segment, source_ms)
                        corrected_hz = midi_to_hz(target_midi + correction_cents / 100)
                    else:
                        corrected_hz = original_hz
                else:
                    correction_cents = _phone_correction_cents(
                        context_units,
                        median_pitches,
                        index + context_offset,
                        measured_midi,
                        output_ms - output_start,
                        output_end - output_start,
                    )
                    if include_layer_offsets:
                        correction_cents += _region_pitch_cents_at_source(segment, source_ms)
                    if include_layer_offsets and segment.pitch_envelope:
                        correction_cents += float(np.interp(
                            position,
                            [point.position for point in segment.pitch_envelope],
                            [point.cents for point in segment.pitch_envelope],
                        ))
                    corrected_hz = float(frequency * 2 ** (correction_cents / 1200))
            original.append(PitchCurvePoint(position=position, hz=original_hz))
            corrected.append(PitchCurvePoint(position=position, hz=corrected_hz))
        phones.append(
            PhonePitchContour(
                phone_unit_id=unit.phone_unit_id,
                source_start_ms=unit.source_start_ms,
                source_end_ms=unit.source_end_ms,
                output_start_ms=round(output_start),
                output_end_ms=round(output_end),
                original=original,
                corrected=corrected,
            )
        )
    region_contours = []
    if segment.edit_regions:
        phone_positions = np.asarray([
            point.position
            for phone in phones
            for point in phone.corrected
            if point.hz is not None
        ], dtype=np.float64)
        phone_hz = np.asarray([
            point.hz
            for phone in phones
            for point in phone.corrected
            if point.hz is not None
        ], dtype=np.float64)
        phone_order = np.argsort(phone_positions)
        output_offset = 0
        for region in segment.edit_regions:
            frequencies, voiced, frame_times = _estimate_f0(
                *_read_source(audio_path(project_dir, segment.source_id), region.source_start_ms, region.source_end_ms)
            )
            original = []
            corrected = []
            for frequency, is_voiced, time_ms in zip(frequencies, voiced, frame_times, strict=True):
                output_ms = output_offset + time_ms * region.output_duration_ms / max(1, region.source_end_ms - region.source_start_ms)
                position = min(1.0, max(0.0, output_ms / duration))
                original_hz = float(frequency) if is_voiced else None
                corrected_hz = original_hz
                if is_voiced and len(phone_positions):
                    corrected_hz = float(np.interp(position, phone_positions[phone_order], phone_hz[phone_order]))
                elif is_voiced and include_layer_offsets:
                    offset_cents = float(region.relative_pitch_cents)
                    if segment.pitch_envelope:
                        offset_cents += float(np.interp(
                            position,
                            [point.position for point in segment.pitch_envelope],
                            [point.cents for point in segment.pitch_envelope],
                        ))
                    source_ms = region.source_start_ms + time_ms
                    for unit in segment.phone_units:
                        if unit.source_start_ms is not None and unit.source_start_ms <= source_ms <= (unit.source_end_ms or unit.source_start_ms):
                            offset_cents += _vibrato_cents(unit, output_ms - _source_to_output_ms(segment, unit.source_start_ms))
                            break
                    corrected_hz = float(frequency * 2 ** (offset_cents / 1200))
                original.append(PitchCurvePoint(position=position, hz=original_hz))
                corrected.append(PitchCurvePoint(position=position, hz=corrected_hz))
            region_contours.append(RegionPitchContour(
                region_id=region.region_id,
                source_start_ms=region.source_start_ms,
                source_end_ms=region.source_end_ms,
                output_start_ms=output_offset,
                output_end_ms=output_offset + region.output_duration_ms,
                original=original,
                corrected=corrected,
            ))
            output_offset += region.output_duration_ms
    return SegmentPitchContour(segment_id=segment.segment_id, phones=phones, regions=region_contours)


def _measure_unit_pitch(unit: PhoneUnit):
    if (
        unit.source_start_ms is None
        or unit.source_end_ms is None
        or unit.source_f0_hz is None
        or unit.source_f0_hz <= 0
    ):
        return np.zeros(0), np.zeros(0, dtype=bool), np.zeros(0)
    return np.asarray([unit.source_f0_hz]), np.asarray([True]), np.asarray([0.0])


def _phone_correction_cents(units, median_pitches, index, measured_midi, local_output_ms, output_duration_ms):
    unit = units[index]
    if unit.target_pitch_midi is None or unit.target_pitch_strength_percent <= 0:
        return _vibrato_cents(unit, local_output_ms)
    strength = unit.target_pitch_strength_percent / 100
    current_target = measured_midi + (unit.target_pitch_midi - measured_midi) * strength
    left = units[index - 1] if index else None
    right = units[index + 1] if index + 1 < len(units) else None
    start_pitch = start_ms = end_pitch = end_ms = None
    if left:
        start_pitch, start_ms = _transition_edge(left, unit, median_pitches[index - 1], median_pitches[index], False)
    if right:
        end_pitch, end_ms = _transition_edge(unit, right, median_pitches[index], median_pitches[index + 1], True)
    if start_pitch is not None and start_ms and local_output_ms < start_ms:
        current_target = start_pitch + (current_target - start_pitch) * _smooth(local_output_ms / start_ms)
    if end_pitch is not None and end_ms and local_output_ms > max(0, output_duration_ms - end_ms):
        current_target += (end_pitch - current_target) * _smooth((local_output_ms - (output_duration_ms - end_ms)) / end_ms)
    return (current_target - measured_midi) * 100 + _vibrato_cents(unit, local_output_ms)


def _transition_edge(left, right, left_midi, right_midi, right_edge):
    if (
        left.target_pitch_midi is None or right.target_pitch_midi is None
        or left.transition_to_next_ms <= 0 or left.transition_strength_percent <= 0
        or left_midi is None or right_midi is None
    ):
        return None, None
    left_target = left_midi + (left.target_pitch_midi - left_midi) * left.target_pitch_strength_percent / 100
    right_target = right_midi + (right.target_pitch_midi - right_midi) * right.target_pitch_strength_percent / 100
    duration = left.transition_to_next_ms
    before = min(duration, max(0.0, duration / 2 - left.transition_center_ms))
    after = duration - before
    boundary = left_target + (right_target - left_target) * before / duration
    strength = left.transition_strength_percent / 100
    left_pitch = left_target + (boundary - left_target) * strength
    right_pitch = right_target + (boundary - right_target) * strength
    return (left_pitch, before) if right_edge else (right_pitch, after)


def _vibrato_cents(unit: PhoneUnit, output_ms: float) -> float:
    elapsed_ms = output_ms - unit.vibrato_start_ms
    if unit.vibrato_depth_cents <= 0 or elapsed_ms < 0:
        return 0.0
    return unit.vibrato_depth_cents * np.sin(2 * np.pi * unit.vibrato_rate_hz * elapsed_ms / 1000)


def _region_pitch_cents_at_source(segment: TimelineSegment, source_ms: float) -> float:
    for region in segment.edit_regions:
        if region.source_start_ms <= source_ms <= region.source_end_ms:
            return float(region.relative_pitch_cents)
    return 0.0


def _source_to_output_ms(segment: TimelineSegment, source_ms: float) -> float:
    offset = 0.0
    for region in segment.edit_regions:
        if source_ms <= region.source_end_ms:
            source_duration = max(1, region.source_end_ms - region.source_start_ms)
            local = min(source_duration, max(0.0, source_ms - region.source_start_ms))
            return offset + local * region.output_duration_ms / source_duration
        offset += region.output_duration_ms
    return offset


def _smooth(value: float) -> float:
    clamped = min(1.0, max(0.0, value))
    return clamped * clamped * (3 - 2 * clamped)


def _read_source(path: Path, start_ms: int, end_ms: int) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as audio:
        sample_rate = audio.getframerate()
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError(f"Autotune requires mono 16-bit WAV audio: {path}")
        start = min(audio.getnframes(), max(0, round(start_ms * sample_rate / 1000)))
        end = min(audio.getnframes(), max(start, round(end_ms * sample_rate / 1000)))
        audio.setpos(start)
        samples = np.frombuffer(audio.readframes(end - start), dtype="<i2")
    return samples.astype(np.float32) / 32768.0, sample_rate


def _estimate_f0(samples: np.ndarray, sample_rate: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    hop = max(1, round(sample_rate * AUTOTUNE_FRAME_MS / 1000))
    frame_size = max(2, round(sample_rate * AUTOTUNE_WINDOW_MS / 1000))
    min_lag = max(2, math.floor(sample_rate / AUTOTUNE_MAX_F0_HZ))
    max_lag = min(frame_size - 2, math.ceil(sample_rate / AUTOTUNE_MIN_F0_HZ))
    fft_size = 1 << (2 * frame_size - 1).bit_length()
    if len(samples) < frame_size or max_lag <= min_lag:
        empty = np.zeros(0, dtype=np.float64)
        return empty, np.zeros(0, dtype=bool), empty
    final_start = len(samples) - frame_size
    starts = list(range(0, final_start + 1, hop))
    if starts[-1] != final_start:
        starts.append(final_start)
    frequencies = []
    voiced = []
    times = []
    for start in starts:
        frame = samples[start : start + frame_size].astype(np.float64)
        frame -= np.mean(frame)
        rms = float(np.sqrt(np.mean(frame * frame)))
        times.append((start + frame_size / 2) * 1000 / sample_rate)
        if rms < AUTOTUNE_MIN_RMS:
            frequencies.append(0.0)
            voiced.append(False)
            continue
        spectrum = np.fft.rfft(frame, fft_size)
        correlation = np.fft.irfft(spectrum * np.conjugate(spectrum), fft_size)[: max_lag + 2]
        energy_prefix = np.concatenate(([0.0], np.cumsum(frame * frame)))
        lags = np.arange(max_lag + 2)
        overlap_energy = np.sqrt(
            energy_prefix[frame_size - lags] * (energy_prefix[-1] - energy_prefix[lags])
        )
        correlation /= np.maximum(overlap_energy, np.finfo(np.float64).eps)
        peaks = [
            lag
            for lag in range(min_lag, max_lag + 1)
            if correlation[lag] >= correlation[lag - 1]
            and correlation[lag] >= correlation[lag + 1]
        ]
        if peaks:
            best_periodicity = max(correlation[candidate] for candidate in peaks)
            likely_periods = [
                candidate
                for candidate in peaks
                if correlation[candidate] >= best_periodicity - AUTOTUNE_PEAK_CORRELATION_TOLERANCE
            ]
            lag = min(likely_periods)
        else:
            lag = min_lag + int(np.argmax(correlation[min_lag : max_lag + 1]))
        periodicity = float(correlation[lag])
        if periodicity < AUTOTUNE_MIN_PERIODICITY:
            frequencies.append(0.0)
            voiced.append(False)
            continue
        adjustment = 0.0
        if min_lag < lag < max_lag:
            left, center, right = correlation[lag - 1 : lag + 2]
            denominator = left - 2 * center + right
            if abs(denominator) > 1e-12:
                adjustment = float(np.clip(0.5 * (left - right) / denominator, -0.5, 0.5))
        frequencies.append(sample_rate / (lag + adjustment))
        voiced.append(True)
    return np.asarray(frequencies), np.asarray(voiced), np.asarray(times)


def _region_envelope(
    regions: list[EditRegion],
    output_duration_ms: int,
    source_start_ms: int,
    f0: np.ndarray,
    voiced: np.ndarray,
    frame_times: np.ndarray,
    strength_percent: int,
    speed_ms: int,
    excluded_source_intervals: list[tuple[int, int]] | None = None,
) -> list[PitchEnvelopePoint]:
    frame_positions = []
    frame_cents = []
    total_output = 0
    previous_correction = 0.0
    hop_ms = AUTOTUNE_FRAME_MS
    for region in regions:
        frame_count = max(1, math.ceil(region.output_duration_ms / hop_ms))
        actual_hop_ms = region.output_duration_ms / frame_count
        alpha = 1.0 if speed_ms == 0 else 1.0 - math.exp(-actual_hop_ms / speed_ms)
        for index in range(frame_count):
            local_output_ms = (index + 0.5) * region.output_duration_ms / frame_count
            source_time_ms = region.source_start_ms - source_start_ms + (
                local_output_ms * (region.source_end_ms - region.source_start_ms)
                / region.output_duration_ms
            )
            absolute_source_ms = source_time_ms + source_start_ms
            correction = 0.0
            excluded = any(
                start <= absolute_source_ms < end
                for start, end in (excluded_source_intervals or [])
            )
            if len(f0) and not excluded:
                nearest = int(np.searchsorted(frame_times, source_time_ms).clip(0, len(frame_times) - 1))
                if nearest and abs(frame_times[nearest - 1] - source_time_ms) < abs(frame_times[nearest] - source_time_ms):
                    nearest -= 1
                if voiced[nearest] and abs(frame_times[nearest] - source_time_ms) <= AUTOTUNE_WINDOW_MS / 2:
                    current_midi = hz_to_midi(f0[nearest]) + region.relative_pitch_cents / 100.0
                    target_midi = round(current_midi)
                    correction = (target_midi - current_midi) * 100 * strength_percent / 100
            if excluded or correction == 0.0 and (not len(f0) or not voiced[nearest]):
                previous_correction = 0.0
            else:
                previous_correction = (
                    correction if speed_ms == 0 else previous_correction + alpha * (correction - previous_correction)
                )
            frame_positions.append(
                (total_output + local_output_ms) / output_duration_ms
            )
            frame_cents.append(round(previous_correction))
        total_output += region.output_duration_ms
    points = [
        PitchEnvelopePoint(position=float(position), cents=int(cents))
        for position, cents in zip(frame_positions, frame_cents, strict=True)
    ]
    if not points:
        return [PitchEnvelopePoint(position=0.0, cents=0), PitchEnvelopePoint(position=1.0, cents=0)]
    if len(points) == 1:
        return [
            PitchEnvelopePoint(position=0.0, cents=points[0].cents),
            PitchEnvelopePoint(position=1.0, cents=points[0].cents),
        ]
    points[0] = PitchEnvelopePoint(position=0.0, cents=points[0].cents)
    points[-1] = PitchEnvelopePoint(position=1.0, cents=points[-1].cents)
    return _simplify_curve(points)


def _simplify_curve(points: list[PitchEnvelopePoint]) -> list[PitchEnvelopePoint]:
    if len(points) <= 2:
        return points
    positions = np.asarray([point.position for point in points], dtype=np.float64)
    cents = np.asarray([point.cents for point in points], dtype=np.float64)
    keep = np.zeros(len(points), dtype=bool)
    keep[[0, -1]] = True
    zero_edges = np.flatnonzero((cents[:-1] == 0) != (cents[1:] == 0))
    keep[zero_edges] = True
    keep[zero_edges + 1] = True
    anchors = np.flatnonzero(keep)
    stack = list(pairwise(anchors))
    while stack:
        left, right = stack.pop()
        if right - left < 2:
            continue
        expected = np.interp(positions[left + 1 : right], positions[[left, right]], cents[[left, right]])
        errors = np.abs(cents[left + 1 : right] - expected)
        offset = int(np.argmax(errors))
        if errors[offset] > AUTOTUNE_CURVE_TOLERANCE_CENTS:
            middle = left + offset + 1
            keep[middle] = True
            stack.append((left, middle))
            stack.append((middle, right))
    return [points[index] for index in np.flatnonzero(keep)]
