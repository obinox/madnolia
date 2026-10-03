import json
import shutil
import wave
from fractions import Fraction
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree

import numpy as np

from madnolia.compositions import collage_dir, save_composition
from madnolia.constants import (
    MAX_CROSSFADE_MS,
    PROFESSIONAL_PHONE_BOUNDARY_BLEND_MS,
    PROFESSIONAL_PHONE_CONTEXT_MAX_MS,
)
from madnolia.pitch_shift import (
    render_pitched_audio,
    render_relative_pitch_curve,
    render_relative_pitched_audio,
)
from madnolia.projects import audio_path
from madnolia.services import export_formats
from madnolia.services.export_formats import _edl, _fcpxml, _timeline_key
from madnolia.time_stretch import stretch_audio
from madnolia.types.common import (
    CompositionMode,
    CompositionProject,
    ExportTarget,
    MediaSource,
    PhoneUnit,
    SaveCompositionRequest,
    TimelineSegment,
)

_timecode = export_formats._timecode


def export_composition(
    project_dir: Path,
    composition: CompositionProject,
    target: ExportTarget,
) -> Path:
    if composition.corpus_project_id != project_dir.name:
        raise ValueError("합성이 연결된 프로젝트와 다릅니다.")
    export_dir = collage_dir(composition.composition_id) / "exports"
    export_dir.mkdir(parents=True, exist_ok=True)
    if target == ExportTarget.JSON:
        source = save_composition(project_dir, composition)
        destination = export_dir / f"{composition.composition_id}.json"
        shutil.copy2(source, destination)
        return destination
    manifest = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    sources = {item["source_id"]: MediaSource(**item) for item in manifest["sources"]}
    if target == ExportTarget.WAV:
        destination = export_dir / f"{composition.composition_id}.wav"
        _export_wav(project_dir, composition, destination)
        return destination
    if target == ExportTarget.EDL:
        destination = export_dir / f"{composition.composition_id}.edl"
        destination.write_text(_edl(composition, sources), encoding="utf-8")
        return destination
    if target == ExportTarget.FCPXML:
        destination = export_dir / f"{composition.composition_id}.fcpxml"
        ElementTree.ElementTree(_fcpxml(composition, sources)).write(
            destination,
            encoding="utf-8",
            xml_declaration=True,
        )
        return destination
    destination = export_dir / f"{composition.composition_id}.mp4"
    _export_mp4(project_dir, composition, sources, destination)
    return destination


def _export_wav(project_dir: Path, composition: CompositionProject, destination: Path) -> None:
    destination.write_bytes(render_wav(project_dir, composition))


def render_wav(
    project_dir: Path, composition: CompositionProject | SaveCompositionRequest
) -> bytes:
    samples = _compose_audio(project_dir, composition)
    buffer = BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(np.clip(samples * 32767, -32768, 32767).astype(np.int16).tobytes())
    return buffer.getvalue()


def _compose_audio(
    project_dir: Path,
    composition: CompositionProject | SaveCompositionRequest,
) -> np.ndarray:
    if not composition.segments:
        return np.zeros(0, dtype=np.float32)
    independent_professional = composition.mode == CompositionMode.PROFESSIONAL and any(
        segment.edit_regions for segment in composition.segments
    )
    segments = sorted(composition.segments, key=_timeline_key) if independent_professional else composition.segments
    total_ms = max(segment.timeline_end_ms for segment in segments)
    output = np.zeros(round(total_ms * 16), dtype=np.float32)
    legacy_mix = composition.mode == CompositionMode.SIMPLE or not any(
        segment.edit_regions for segment in segments
    )
    weights = np.zeros(len(output), dtype=np.float32) if legacy_mix else None
    fade_samples = round(composition.crossfade_ms * 16) if legacy_mix else 0
    for segment_index, segment in enumerate(segments):
        expected = round((segment.timeline_end_ms - segment.timeline_start_ms) * 16)
        previous_segment = segments[segment_index - 1] if segment_index else None
        next_segment = (
            segments[segment_index + 1]
            if segment_index + 1 < len(segments)
            else None
        )
        previous_unit = (
            previous_segment.phone_units[-1]
            if previous_segment
            and previous_segment.phone_units
            and segment.timeline_start_ms == previous_segment.timeline_end_ms
            else None
        )
        next_unit = (
            next_segment.phone_units[0]
            if next_segment
            and next_segment.phone_units
            and next_segment.timeline_start_ms == segment.timeline_end_ms
            else None
        )
        clip = _render_segment_audio(
            project_dir,
            composition.mode,
            segment,
            expected,
            previous_unit,
            next_unit,
        )
        clip = _apply_volume_envelope(clip, segment)
        envelope = np.ones(len(clip), dtype=np.float32)
        if fade_samples:
            fade = min(fade_samples, len(clip) // 2)
            if fade:
                envelope[:fade] = np.linspace(0, 1, fade, endpoint=False)
                envelope[-fade:] = np.linspace(1, 0, fade, endpoint=False)
        left_overlap = (
            max(0, min(segment.crossfade_ms if segment.crossfade_ms is not None else min(MAX_CROSSFADE_MS, -segment.gap_before_ms), previous_segment.timeline_end_ms - segment.timeline_start_ms)) * 16
            if previous_segment is not None
            else 0
        )
        right_overlap = (
            max(0, min(next_segment.crossfade_ms if next_segment.crossfade_ms is not None else min(MAX_CROSSFADE_MS, -next_segment.gap_before_ms), segment.timeline_end_ms - next_segment.timeline_start_ms)) * 16
            if next_segment is not None
            else 0
        )
        fade_in = min(left_overlap, len(clip))
        fade_out = min(right_overlap, len(clip))
        if fade_in:
            envelope[:fade_in] = np.linspace(0, 1, fade_in, endpoint=False)
        if fade_out:
            envelope[-fade_out:] = np.linspace(1, 0, fade_out, endpoint=False)
        start = round(segment.timeline_start_ms * 16)
        end = min(len(output), start + len(clip))
        active = envelope[: end - start]
        output[start:end] += clip[: end - start] * active
        if weights is not None:
            weights[start:end] += active
    if weights is not None:
        active = weights > 1
        output[active] /= weights[active]
    return np.clip(output, -1, 1)


def _render_segment_audio(
    project_dir: Path,
    mode: CompositionMode,
    segment: TimelineSegment,
    expected: int,
    previous_unit: PhoneUnit | None = None,
    next_unit: PhoneUnit | None = None,
) -> np.ndarray:
    path = audio_path(project_dir, segment.source_id)
    if mode == CompositionMode.SIMPLE or (not segment.phone_units and not segment.edit_regions):
        clip = stretch_audio(
            _read_audio_clip(path, segment.source_start_ms, segment.source_end_ms), expected
        )
    elif segment.edit_regions:
        clip = _render_edit_regions(path, segment)
    else:
        clip = _render_professional_phone_audio(
            path,
            segment.phone_units,
            expected,
            previous_unit,
            next_unit,
        )
    if len(clip) < expected:
        return np.pad(clip, (0, expected - len(clip)))
    return clip[:expected]


def _render_edit_regions(path: Path, segment: TimelineSegment) -> np.ndarray:
    if not segment.pitch_envelope:
        merged: list[list[int]] = []
        for region in segment.edit_regions:
            previous_source_length = merged[-1][1] - merged[-1][0] if merged else 0
            source_length = region.source_end_ms - region.source_start_ms
            stretch_delta = abs(merged[-1][3] * source_length - region.output_duration_ms * previous_source_length) if merged else 0
            rounding_tolerance = (previous_source_length + source_length) / 2 if merged else 0
            if merged and merged[-1][2] == region.relative_pitch_cents and stretch_delta <= rounding_tolerance:
                merged[-1][1] = region.source_end_ms
                merged[-1][3] += region.output_duration_ms
            else:
                merged.append([region.source_start_ms, region.source_end_ms, region.relative_pitch_cents, region.output_duration_ms])
        pieces = [render_relative_pitched_audio(_read_audio_clip(path, start, end), duration * 16, cents) for start, end, cents, duration in merged]
        return np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
    pieces = []
    base_cents = []
    for region in segment.edit_regions:
        source = _read_audio_clip(path, region.source_start_ms, region.source_end_ms)
        count = max(1, region.output_duration_ms * 16)
        pieces.append(stretch_audio(source, count))
        base_cents.extend([region.relative_pitch_cents] * count)
    clip = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
    curve = segment.pitch_envelope
    return render_relative_pitch_curve(clip, curve, np.asarray(base_cents, dtype=np.float32) if segment.pitch_envelope else None)


def _apply_volume_envelope(clip: np.ndarray, segment: TimelineSegment) -> np.ndarray:
    if not segment.volume_envelope or not len(clip):
        return clip
    positions = np.array([point.position for point in segment.volume_envelope], dtype=np.float32)
    gains = np.array([point.gain for point in segment.volume_envelope], dtype=np.float32)
    timeline_positions = np.linspace(0, 1, len(clip), endpoint=False, dtype=np.float32)
    return clip * np.interp(timeline_positions, positions, gains).astype(np.float32)


def _render_professional_phone_audio(
    path: Path,
    units: list[PhoneUnit],
    expected: int,
    previous_unit: PhoneUnit | None,
    next_unit: PhoneUnit | None,
) -> np.ndarray:
    output = np.zeros(expected, dtype=np.float32)
    weights = np.zeros(expected, dtype=np.float32)
    cursor = 0
    for index, unit in enumerate(units):
        duration = round(unit.output_duration_ms * 16)
        if duration <= 0:
            continue
        if unit.source_start_ms is None or unit.source_end_ms is None:
            cursor += duration
            continue
        samples, left_context, right_context = _read_phone_with_context(
            path,
            unit.source_start_ms,
            unit.source_end_ms,
            duration,
        )
        start_pitch, start_ms, end_pitch, end_ms = _pitch_context(
            units, index, previous_unit, next_unit
        )
        rendered = render_pitched_audio(
            samples,
            left_context + duration + right_context,
            unit.source_f0_hz,
            unit.target_pitch_midi,
            start_pitch,
            round(start_ms * 16),
            end_pitch,
            round(end_ms * 16),
            formant_shift_semitones=unit.formant_shift_semitones,
        )
        envelope = np.ones(len(rendered), dtype=np.float32)
        if left_context:
            envelope[:left_context] = np.linspace(0, 1, left_context, endpoint=False)
        if right_context:
            envelope[-right_context:] = np.linspace(1, 0, right_context, endpoint=False)
        placement = cursor - left_context
        source_start = max(0, -placement)
        output_start = max(0, placement)
        count = min(len(rendered) - source_start, expected - output_start)
        if count > 0:
            active = envelope[source_start:source_start + count]
            output[output_start:output_start + count] += (
                rendered[source_start:source_start + count] * active
            )
            weights[output_start:output_start + count] += active
        cursor += duration
    active = weights > np.finfo(np.float32).eps
    output[active] /= weights[active]
    return output


def _read_phone_with_context(
    path: Path,
    start_ms: int,
    end_ms: int,
    output_samples: int,
) -> tuple[np.ndarray, int, int]:
    core_samples = max(1, round((end_ms - start_ms) * 16))
    stretch_ratio = output_samples / core_samples
    desired_output_context = round(PROFESSIONAL_PHONE_BOUNDARY_BLEND_MS * 16)
    maximum_source_context = round(PROFESSIONAL_PHONE_CONTEXT_MAX_MS * 16)
    source_context = min(
        maximum_source_context,
        max(1, round(desired_output_context / max(stretch_ratio, 1e-6))),
    )
    source_start = max(0, round(start_ms * 16) - source_context)
    core_start = round(start_ms * 16)
    core_end = round(end_ms * 16)
    requested_end = core_end + source_context
    samples = _read_audio_samples(path, source_start, requested_end)
    actual_left = min(core_start - source_start, len(samples))
    actual_right = max(0, len(samples) - actual_left - core_samples)
    left_output = min(desired_output_context, round(actual_left * stretch_ratio))
    right_output = min(desired_output_context, round(actual_right * stretch_ratio))
    return samples, left_output, right_output


def _pitch_context(
    units: list[PhoneUnit],
    index: int,
    previous_unit: PhoneUnit | None = None,
    next_unit: PhoneUnit | None = None,
) -> tuple[float | None, float, float | None, float]:
    start_pitch: float | None = None
    start_ms = 0.0
    end_pitch: float | None = None
    end_ms = 0.0
    left = units[index - 1] if index > 0 else previous_unit
    right = units[index + 1] if index + 1 < len(units) else next_unit
    if left is not None:
        _, _, start_pitch, start_ms = _transition(left, units[index])
    if right is not None:
        end_pitch, end_ms, _, _ = _transition(units[index], right)
    return start_pitch, start_ms, end_pitch, end_ms


def _transition(
    left: PhoneUnit, right: PhoneUnit
) -> tuple[float | None, float, float | None, float]:
    if (
        left.target_pitch_midi is None
        or right.target_pitch_midi is None
        or left.transition_to_next_ms <= 0
        or left.transition_strength_percent <= 0
    ):
        return None, 0.0, None, 0.0
    duration = float(left.transition_to_next_ms)
    before = min(duration, max(0.0, duration / 2 - left.transition_center_ms))
    after = duration - before
    boundary = left.target_pitch_midi + (
        right.target_pitch_midi - left.target_pitch_midi
    ) * before / duration
    strength = left.transition_strength_percent / 100
    left_pitch = left.target_pitch_midi + (boundary - left.target_pitch_midi) * strength
    right_pitch = right.target_pitch_midi + (boundary - right.target_pitch_midi) * strength
    return left_pitch, before, right_pitch, after


def _read_audio_clip(path: Path, start_ms: int, end_ms: int) -> np.ndarray:
    return _read_audio_samples(path, round(start_ms * 16), round(end_ms * 16))


def _read_audio_samples(path: Path, start: int, end: int) -> np.ndarray:
    with wave.open(str(path), "rb") as audio:
        if audio.getframerate() != 16000 or audio.getnchannels() != 1:
            raise ValueError(f"16kHz mono WAV가 아닙니다: {path}")
        safe_start = max(0, min(start, audio.getnframes()))
        safe_end = max(safe_start, min(end, audio.getnframes()))
        audio.setpos(safe_start)
        raw = audio.readframes(safe_end - safe_start)
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768


def _export_mp4(
    project_dir: Path,
    composition: CompositionProject,
    sources: dict[str, MediaSource],
    destination: Path,
) -> None:
    import av

    if not composition.segments:
        raise ValueError("MP4로 내보낼 구간이 없습니다.")
    first = sources[composition.segments[0].source_id]
    width = first.video_width or 1280
    height = first.video_height or 720
    fps = round(first.video_fps or 30)
    for source_id in {segment.source_id for segment in composition.segments}:
        with av.open(sources[source_id].path) as container:
            if not container.streams.video:
                raise ValueError("MP4 export requires a video track in each selected source.")
    output = av.open(str(destination), "w")
    video_stream = output.add_stream("libx264", rate=fps)
    video_stream.width = width
    video_stream.height = height
    video_stream.pix_fmt = "yuv420p"
    audio_stream = output.add_stream("aac", rate=16000)
    audio_stream.layout = "mono"
    if composition.mode == CompositionMode.PROFESSIONAL:
        _encode_professional_video(
            av, output, video_stream, composition, sources, width, height, fps
        )
    else:
        _encode_simple_video(
            av, output, video_stream, composition, sources, width, height, fps
        )
    for packet in video_stream.encode():
        output.mux(packet)
    audio = np.clip(_compose_audio(project_dir, composition) * 32767, -32768, 32767).astype(
        np.int16
    )
    audio_pts = 0
    for start in range(0, len(audio), 1024):
        chunk = audio[start : start + 1024]
        frame = av.AudioFrame.from_ndarray(chunk[np.newaxis, :], format="s16", layout="mono")
        frame.sample_rate = 16000
        frame.pts = audio_pts
        frame.time_base = Fraction(1, 16000)
        audio_pts += len(chunk)
        for packet in audio_stream.encode(frame):
            output.mux(packet)
    for packet in audio_stream.encode():
        output.mux(packet)
    output.close()


def _encode_simple_video(
    av,
    output,
    video_stream,
    composition: CompositionProject,
    sources: dict[str, MediaSource],
    width: int,
    height: int,
    fps: int,
) -> None:
    last_frame_index = -1
    for segment in sorted(composition.segments, key=_timeline_key):
        source = sources[segment.source_id]
        with av.open(source.path) as container:
            stream = container.streams.video[0]
            container.seek(segment.source_start_ms * 1000, backward=True)
            for frame in container.decode(stream):
                timestamp_ms = float(frame.time or 0) * 1000
                if timestamp_ms < segment.source_start_ms:
                    continue
                if timestamp_ms >= segment.source_end_ms:
                    break
                frame_index = round(
                    (
                        segment.timeline_start_ms
                        + (timestamp_ms - segment.source_start_ms) * segment.stretch_percent / 100
                    )
                    * fps
                    / 1000
                )
                if frame_index <= last_frame_index:
                    continue
                frame = frame.reformat(width=width, height=height, format="yuv420p")
                frame.pts = frame_index
                frame.time_base = Fraction(1, fps)
                last_frame_index = frame_index
                for packet in video_stream.encode(frame):
                    output.mux(packet)


def _encode_professional_video(
    av,
    output,
    video_stream,
    composition: CompositionProject,
    sources: dict[str, MediaSource],
    width: int,
    height: int,
    fps: int,
) -> None:
    segments = sorted(composition.segments, key=_timeline_key)
    pending: dict[int, np.ndarray] = {}
    last_encoded = -1
    for segment_index, segment in enumerate(segments):
        mapped = _professional_segment_frames(
            av, segment, sources[segment.source_id], width, height, fps
        )
        previous = segments[segment_index - 1] if segment_index else None
        for frame_index, pixels in mapped.items():
            existing = pending.get(frame_index)
            if existing is not None and previous is not None:
                alpha = _video_overlap_alpha(segment, previous, frame_index, fps)
                pixels = np.clip(
                    existing.astype(np.float32) * (1.0 - alpha)
                    + pixels.astype(np.float32) * alpha,
                    0,
                    255,
                ).astype(np.uint8)
            pending[frame_index] = pixels
        next_start = (
            round(segments[segment_index + 1].timeline_start_ms * fps / 1000)
            if segment_index + 1 < len(segments)
            else None
        )
        flush_indices = sorted(
            index for index in pending if next_start is None or index < next_start
        )
        for frame_index in flush_indices:
            if frame_index <= last_encoded:
                pending.pop(frame_index)
                continue
            frame = av.VideoFrame.from_ndarray(pending.pop(frame_index), format="rgb24")
            frame = frame.reformat(width=width, height=height, format="yuv420p")
            frame.pts = frame_index
            frame.time_base = Fraction(1, fps)
            last_encoded = frame_index
            for packet in video_stream.encode(frame):
                output.mux(packet)


def _professional_segment_frames(
    av,
    segment: TimelineSegment,
    source: MediaSource,
    width: int,
    height: int,
    fps: int,
) -> dict[int, np.ndarray]:
    mapped: dict[int, np.ndarray] = {}
    output_cursor_ms = float(segment.timeline_start_ms)
    if segment.edit_regions:
        for region in segment.edit_regions:
            output_end_ms = output_cursor_ms + region.output_duration_ms
            source_frames = _decode_video_range(
                av, source.path, region.source_start_ms, region.source_end_ms, width, height
            )
            if source_frames:
                start_frame = round(output_cursor_ms * fps / 1000)
                end_frame = max(start_frame + 1, round(output_end_ms * fps / 1000))
                timestamps = np.array([item[0] for item in source_frames])
                for frame_index in range(start_frame, end_frame):
                    progress = np.clip((frame_index * 1000 / fps - output_cursor_ms) / region.output_duration_ms, 0, 1)
                    source_ms = region.source_start_ms + progress * (region.source_end_ms - region.source_start_ms)
                    nearest = int(np.argmin(np.abs(timestamps - source_ms)))
                    mapped[frame_index] = source_frames[nearest][1]
            output_cursor_ms = output_end_ms
        return mapped
    for unit in segment.phone_units:
        output_end_ms = output_cursor_ms + unit.output_duration_ms
        if (
            unit.source_start_ms is not None
            and unit.source_end_ms is not None
            and unit.output_duration_ms > 0
        ):
            source_frames = _decode_video_range(
                av,
                source.path,
                unit.source_start_ms,
                unit.source_end_ms,
                width,
                height,
            )
            if source_frames:
                start_frame = round(output_cursor_ms * fps / 1000)
                end_frame = max(start_frame + 1, round(output_end_ms * fps / 1000))
                timestamps = np.array([item[0] for item in source_frames])
                for frame_index in range(start_frame, end_frame):
                    output_ms = frame_index * 1000 / fps
                    progress = np.clip(
                        (output_ms - output_cursor_ms) / unit.output_duration_ms, 0.0, 1.0
                    )
                    source_ms = unit.source_start_ms + progress * (
                        unit.source_end_ms - unit.source_start_ms
                    )
                    nearest = int(np.argmin(np.abs(timestamps - source_ms)))
                    mapped[frame_index] = source_frames[nearest][1]
        output_cursor_ms = output_end_ms
    return mapped


def _decode_video_range(
    av,
    path: str,
    start_ms: int,
    end_ms: int,
    width: int,
    height: int,
) -> list[tuple[float, np.ndarray]]:
    decoded: list[tuple[float, np.ndarray]] = []
    previous: tuple[float, np.ndarray] | None = None
    with av.open(path) as container:
        stream = container.streams.video[0]
        container.seek(max(0, start_ms - 1000) * 1000, backward=True)
        for frame in container.decode(stream):
            timestamp_ms = float(frame.time or 0) * 1000
            pixels = frame.reformat(width=width, height=height, format="rgb24").to_ndarray()
            if timestamp_ms < start_ms:
                previous = (timestamp_ms, pixels)
                continue
            if previous is not None and not decoded:
                decoded.append(previous)
            decoded.append((timestamp_ms, pixels))
            if timestamp_ms >= end_ms:
                break
    if not decoded and previous is not None:
        decoded.append(previous)
    return decoded


def _video_overlap_alpha(
    current: TimelineSegment,
    previous: TimelineSegment,
    frame_index: int,
    fps: int,
) -> float:
    """Later timeline segments dissolve over the immediately preceding segment."""
    overlap_start = current.timeline_start_ms
    overlap_end = min(current.timeline_end_ms, previous.timeline_end_ms)
    if overlap_end <= overlap_start:
        return 1.0
    timestamp_ms = frame_index * 1000 / fps
    return float(np.clip((timestamp_ms - overlap_start) / (overlap_end - overlap_start), 0, 1))
