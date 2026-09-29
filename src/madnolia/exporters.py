import json
import shutil
import wave
from fractions import Fraction
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree

import numpy as np

from madnolia.compositions import collage_dir, save_composition
from madnolia.pitch_shift import render_pitched_audio
from madnolia.projects import audio_path
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
    total_ms = max(segment.timeline_end_ms for segment in composition.segments)
    output = np.zeros(round(total_ms * 16), dtype=np.float32)
    weights = np.zeros(len(output), dtype=np.float32)
    fade_samples = round(composition.crossfade_ms * 16)
    for segment_index, segment in enumerate(composition.segments):
        expected = round((segment.timeline_end_ms - segment.timeline_start_ms) * 16)
        previous_segment = composition.segments[segment_index - 1] if segment_index else None
        next_segment = (
            composition.segments[segment_index + 1]
            if segment_index + 1 < len(composition.segments)
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
            project_dir, segment, expected, previous_unit, next_unit
        )
        envelope = np.ones(len(clip), dtype=np.float32)
        fade = min(fade_samples, len(clip) // 2)
        if fade:
            envelope[:fade] = np.linspace(0, 1, fade, endpoint=False)
            envelope[-fade:] = np.linspace(1, 0, fade, endpoint=False)
        start = round(segment.timeline_start_ms * 16)
        end = min(len(output), start + len(clip))
        active = envelope[: end - start]
        output[start:end] += clip[: end - start] * active
        weights[start:end] += active
    active = weights > 1
    output[active] /= weights[active]
    return np.clip(output, -1, 1)


def _render_segment_audio(
    project_dir: Path,
    segment: TimelineSegment,
    expected: int,
    previous_unit: PhoneUnit | None = None,
    next_unit: PhoneUnit | None = None,
) -> np.ndarray:
    path = audio_path(project_dir, segment.source_id)
    if segment.phone_units:
        clips: list[np.ndarray] = []
        for index, unit in enumerate(segment.phone_units):
            if (
                unit.source_start_ms is None
                or unit.source_end_ms is None
                or unit.output_duration_ms <= 0
            ):
                continue
            start_pitch, start_ms, end_pitch, end_ms = _pitch_context(
                segment.phone_units, index, previous_unit, next_unit
            )
            clips.append(
                render_pitched_audio(
                    _read_audio_clip(path, unit.source_start_ms, unit.source_end_ms),
                    round(unit.output_duration_ms * 16),
                    unit.source_f0_hz,
                    unit.target_pitch_midi,
                    start_pitch,
                    round(start_ms * 16),
                    end_pitch,
                    round(end_ms * 16),
                    formant_shift_semitones=unit.formant_shift_semitones,
                )
            )
        clip = np.concatenate(clips) if clips else np.zeros(0, dtype=np.float32)
    else:
        clip = stretch_audio(
            _read_audio_clip(path, segment.source_start_ms, segment.source_end_ms), expected
        )
    if len(clip) < expected:
        return np.pad(clip, (0, expected - len(clip)))
    return clip[:expected]


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
    with wave.open(str(path), "rb") as audio:
        if audio.getframerate() != 16000 or audio.getnchannels() != 1:
            raise ValueError(f"16kHz mono WAV가 아닙니다: {path}")
        start = round(start_ms * 16)
        end = round(end_ms * 16)
        audio.setpos(start)
        raw = audio.readframes(end - start)
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768


def _edl(composition: CompositionProject, sources: dict[str, MediaSource]) -> str:
    lines = [f"TITLE: {composition.name}", "FCM: NON-DROP FRAME", ""]
    for index, segment in enumerate(sorted(composition.segments, key=_timeline_key), start=1):
        fps = round(sources[segment.source_id].video_fps or 30)
        source_name = Path(sources[segment.source_id].path).stem[:8].upper()
        lines.append(
            f"{index:03d}  {source_name:<8} V     C        "
            f"{_timecode(segment.source_start_ms, fps)} {_timecode(segment.source_end_ms, fps)} "
            f"{_timecode(segment.timeline_start_ms, fps)} {_timecode(segment.timeline_end_ms, fps)}"
        )
        lines.append(f"* FROM CLIP NAME: {Path(sources[segment.source_id].path).name}")
        lines.append("")
    return "\n".join(lines)


def _fcpxml(
    composition: CompositionProject,
    sources: dict[str, MediaSource],
) -> ElementTree.Element:
    root = ElementTree.Element("fcpxml", version="1.10")
    resources = ElementTree.SubElement(root, "resources")
    first_source = next(iter(sources.values()))
    fps = round(first_source.video_fps or 30)
    ElementTree.SubElement(
        resources,
        "format",
        id="f1",
        name="MadnoliaFormat",
        frameDuration=f"1/{fps}s",
        width=str(first_source.video_width or 1280),
        height=str(first_source.video_height or 720),
    )
    for index, source in enumerate(sources.values(), start=1):
        ElementTree.SubElement(
            resources,
            "asset",
            id=f"r{index + 1}",
            name=Path(source.path).name,
            src=Path(source.path).resolve().as_uri(),
            start="0s",
            duration=f"{source.duration_ms}/1000s",
            hasVideo="1",
            hasAudio="1",
        )
    source_refs = {source_id: f"r{index + 1}" for index, source_id in enumerate(sources, start=1)}
    library = ElementTree.SubElement(root, "library")
    event = ElementTree.SubElement(library, "event", name="Madnolia")
    project = ElementTree.SubElement(event, "project", name=composition.name)
    sequence = ElementTree.SubElement(project, "sequence", format="f1")
    spine = ElementTree.SubElement(sequence, "spine")
    for segment in sorted(composition.segments, key=_timeline_key):
        ElementTree.SubElement(
            spine,
            "asset-clip",
            ref=source_refs[segment.source_id],
            offset=f"{segment.timeline_start_ms}/1000s",
            start=f"{segment.source_start_ms}/1000s",
            duration=f"{segment.timeline_end_ms - segment.timeline_start_ms}/1000s",
            name=segment.segment_id,
        )
    return root


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
    overlap_start = current.timeline_start_ms
    overlap_end = min(current.timeline_end_ms, previous.timeline_end_ms)
    if overlap_end <= overlap_start:
        return 1.0
    timestamp_ms = frame_index * 1000 / fps
    return float(np.clip((timestamp_ms - overlap_start) / (overlap_end - overlap_start), 0, 1))


def _timecode(milliseconds: int, fps: int) -> str:
    total_frames = round(milliseconds * fps / 1000)
    frames = total_frames % fps
    seconds = total_frames // fps
    return f"{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}:{frames:02d}"


def _timeline_key(segment: TimelineSegment) -> tuple[int, str]:
    return segment.timeline_start_ms, segment.segment_id
