from pathlib import Path
from xml.etree import ElementTree

from madnolia.types.common import CompositionProject, MediaSource, TimelineSegment


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


def _timecode(milliseconds: int, fps: int) -> str:
    total_frames = round(milliseconds * fps / 1000)
    frames = total_frames % fps
    seconds = total_frames // fps
    return f"{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}:{frames:02d}"


def _timeline_key(segment: TimelineSegment) -> tuple[int, str]:
    return segment.timeline_start_ms, segment.segment_id
