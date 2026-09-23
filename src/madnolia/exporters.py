import json
import shutil
import wave
from fractions import Fraction
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree

import numpy as np

from madnolia.compositions import save_composition
from madnolia.time_stretch import stretch_audio
from madnolia.types.common import (
    CompositionProject,
    ExportTarget,
    MediaSource,
    SaveCompositionRequest,
    TimelineSegment,
)


def export_composition(
    project_dir: Path,
    composition: CompositionProject,
    target: ExportTarget,
) -> Path:
    export_dir = project_dir / "exports" / composition.composition_id
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


def render_wav(project_dir: Path, composition: CompositionProject | SaveCompositionRequest) -> bytes:
    samples = _compose_audio(project_dir, composition)
    buffer = BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(np.clip(samples * 32767, -32768, 32767).astype(np.int16).tobytes())
    return buffer.getvalue()


def _compose_audio(
    project_dir: Path, composition: CompositionProject | SaveCompositionRequest,
) -> np.ndarray:
    if not composition.segments:
        return np.zeros(0, dtype=np.float32)
    total_ms = max(segment.timeline_end_ms for segment in composition.segments)
    output = np.zeros(round(total_ms * 16), dtype=np.float32)
    weights = np.zeros(len(output), dtype=np.float32)
    fade_samples = round(composition.crossfade_ms * 16)
    for segment in composition.segments:
        clip = _read_audio_clip(
            project_dir / "audio" / f"{segment.source_id}.wav",
            segment.source_start_ms,
            segment.source_end_ms,
        )
        expected = round((segment.timeline_end_ms - segment.timeline_start_ms) * 16)
        if segment.stretch_percent > 100:
            clip = stretch_audio(clip, expected)
        else:
            clip = clip[:expected]
            if len(clip) < expected:
                clip = np.pad(clip, (0, expected - len(clip)))
        envelope = np.ones(len(clip), dtype=np.float32)
        fade = min(fade_samples, len(clip) // 2)
        if fade:
            envelope[:fade] = np.linspace(0, 1, fade, endpoint=False)
            envelope[-fade:] = np.linspace(1, 0, fade, endpoint=False)
        start = round(segment.timeline_start_ms * 16)
        end = min(len(output), start + len(clip))
        active = envelope[:end - start]
        output[start:end] += clip[:end - start] * active
        weights[start:end] += active
    active = weights > 1
    output[active] /= weights[active]
    return np.clip(output, -1, 1)


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
    source_refs = {
        source_id: f"r{index + 1}" for index, source_id in enumerate(sources, start=1)
    }
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
    output = av.open(str(destination), "w")
    video_stream = output.add_stream("libx264", rate=fps)
    video_stream.width = width
    video_stream.height = height
    video_stream.pix_fmt = "yuv420p"
    audio_stream = output.add_stream("aac", rate=16000)
    audio_stream.layout = "mono"
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
                        + (timestamp_ms - segment.source_start_ms)
                        * segment.stretch_percent / 100
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
    for packet in video_stream.encode():
        output.mux(packet)
    audio = np.clip(_compose_audio(project_dir, composition) * 32767, -32768, 32767).astype(np.int16)
    audio_pts = 0
    for start in range(0, len(audio), 1024):
        chunk = audio[start:start + 1024]
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


def _timecode(milliseconds: int, fps: int) -> str:
    total_frames = round(milliseconds * fps / 1000)
    frames = total_frames % fps
    seconds = total_frames // fps
    return f"{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}:{frames:02d}"


def _timeline_key(segment: TimelineSegment) -> tuple[int, str]:
    return segment.timeline_start_ms, segment.segment_id
