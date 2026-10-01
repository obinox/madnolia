import filecmp
import json
import math
import re
import shutil
from dataclasses import replace
from datetime import datetime
from itertools import pairwise
from pathlib import Path
from uuid import uuid4

from madnolia.constants import (
    DEFAULT_COLLAGES_DIR,
    FORMANT_SHIFT_MAX_SEMITONES,
    FORMANT_SHIFT_MIN_SEMITONES,
    MAX_CROSSFADE_MS,
    MAX_STRETCH_PERCENT,
    MIN_STRETCH_PERCENT,
    PITCH_MAX_MIDI,
    PITCH_MIN_MIDI,
    PITCH_TRANSITION_CENTER_MAX_MS,
    PITCH_TRANSITION_CENTER_MIN_MS,
    PITCH_TRANSITION_MAX_MS,
    PROFESSIONAL_BEAT_DIVISION_DEFAULT,
    PROFESSIONAL_BEAT_DIVISIONS,
    PROFESSIONAL_BEATS_PER_BAR_DEFAULT,
    PROFESSIONAL_BEATS_PER_BAR_MAX,
    PROFESSIONAL_BEATS_PER_BAR_MIN,
    PROFESSIONAL_ENVELOPE_POSITION_MAX,
    PROFESSIONAL_ENVELOPE_POSITION_MIN,
    PROFESSIONAL_GAIN_MAX,
    PROFESSIONAL_GAIN_MIN,
    PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT,
    PROFESSIONAL_MAX_DURATION_PERCENT,
    PROFESSIONAL_MIN_DURATION_PERCENT,
    PROFESSIONAL_PITCH_MAX_CENTS,
    PROFESSIONAL_PITCH_MIN_CENTS,
    PROFESSIONAL_TEMPO_DEFAULT_BPM,
    PROFESSIONAL_TEMPO_MAX_BPM,
    PROFESSIONAL_TEMPO_MIN_BPM,
)
from madnolia.storage import write_json
from madnolia.types.common import (
    CompositionMode,
    CompositionProject,
    EditRegion,
    MatchStatus,
    PhoneAlignmentOperation,
    PhoneUnit,
    PitchEnvelopePoint,
    SaveCompositionRequest,
    TimelineSegment,
    VolumeEnvelopePoint,
)


def list_compositions(project_dir: Path) -> list[CompositionProject]:
    if not DEFAULT_COLLAGES_DIR.is_dir():
        return []
    return [
        collage
        for path in sorted(DEFAULT_COLLAGES_DIR.glob("*/collage.json"))
        if (collage := load_composition(path)).corpus_project_id == project_dir.name
    ]


def list_all_collages() -> list[CompositionProject]:
    if not DEFAULT_COLLAGES_DIR.is_dir():
        return []
    return [load_composition(path) for path in sorted(DEFAULT_COLLAGES_DIR.glob("*/collage.json"))]


def collage_dir(composition_id: str) -> Path:
    if not re.fullmatch(r"comp_[0-9a-f]{16}", composition_id):
        raise ValueError("잘못된 합성 ID입니다.")
    return DEFAULT_COLLAGES_DIR / composition_id


def migrate_legacy_collages(project_dir: Path, *legacy_roots: Path) -> None:
    for root in (*legacy_roots, project_dir):
        directory = root / "compositions"
        for source in directory.glob("comp_*.json"):
            collage = load_composition(source)
            if collage.corpus_project_id != project_dir.name:
                raise ValueError(f"합성 프로젝트 참조가 다릅니다: {source}")
            destination = collage_dir(collage.composition_id) / "collage.json"
            _move_verified(source, destination)
            exports = root / "exports" / collage.composition_id
            if exports.is_dir():
                for file in exports.rglob("*"):
                    if file.is_file():
                        _move_verified(
                            file, destination.parent / "exports" / file.relative_to(exports)
                        )
                for subdirectory in sorted(
                    (item for item in exports.rglob("*") if item.is_dir()), reverse=True
                ):
                    subdirectory.rmdir()
                exports.rmdir()
        if directory.is_dir() and not any(directory.iterdir()):
            directory.rmdir()
        exports_root = root / "exports"
        if exports_root.is_dir() and not any(exports_root.iterdir()):
            exports_root.rmdir()


def _move_verified(source: Path, destination: Path) -> None:
    if destination.is_file():
        if not filecmp.cmp(source, destination, shallow=False):
            raise ValueError(f"합성 이전 충돌: {destination}")
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        if not filecmp.cmp(source, destination, shallow=False):
            raise OSError(f"합성 복사 검증 실패: {destination}")
    source.unlink()


def create_composition(
    project_dir: Path,
    corpus_project_id: str,
    request: SaveCompositionRequest,
) -> CompositionProject:
    _validate_request(request)
    now = datetime.now().astimezone().isoformat()
    composition = CompositionProject(
        composition_id=f"comp_{uuid4().hex[:16]}",
        corpus_project_id=corpus_project_id,
        name=request.name.strip(),
        target_text=request.target_text.strip(),
        target_pronunciation=request.target_pronunciation.strip(),
        created_at=now,
        updated_at=now,
        crossfade_ms=request.crossfade_ms,
        segments=request.segments,
        mode=request.mode,
        schema_version=request.schema_version,
        parent_composition_id=request.parent_composition_id,
        parent_composition_updated_at=request.parent_composition_updated_at,
        tempo_bpm=request.tempo_bpm,
        beats_per_bar=request.beats_per_bar,
        beat_division=request.beat_division,
        grid_offset_units=request.grid_offset_units,
    )
    _validate_parent_dependency(project_dir, request)
    _validate_sources(project_dir, composition.segments)
    save_composition(project_dir, composition)
    return composition


def update_composition(
    project_dir: Path,
    composition_id: str,
    request: SaveCompositionRequest,
) -> CompositionProject:
    current = load_composition(_composition_path(project_dir, composition_id))
    if current.corpus_project_id != project_dir.name:
        raise FileNotFoundError(composition_id)
    _validate_request(request)
    composition = replace(
        current,
        name=request.name.strip(),
        target_text=request.target_text.strip(),
        target_pronunciation=request.target_pronunciation.strip(),
        updated_at=datetime.now().astimezone().isoformat(),
        crossfade_ms=request.crossfade_ms,
        segments=request.segments,
        mode=request.mode,
        schema_version=request.schema_version,
        parent_composition_id=request.parent_composition_id,
        parent_composition_updated_at=request.parent_composition_updated_at,
        tempo_bpm=request.tempo_bpm,
        beats_per_bar=request.beats_per_bar,
        beat_division=request.beat_division,
        grid_offset_units=request.grid_offset_units,
    )
    _validate_parent_dependency(project_dir, request, composition_id)
    _validate_sources(project_dir, composition.segments)
    save_composition(project_dir, composition)
    return composition


def save_composition(project_dir: Path, composition: CompositionProject) -> Path:
    path = _composition_path(project_dir, composition.composition_id)
    write_json(path, composition.to_dict())
    return path


def load_composition(path: Path) -> CompositionProject:
    data = json.loads(path.read_text(encoding="utf-8"))
    return CompositionProject(
        composition_id=data["composition_id"],
        corpus_project_id=data["corpus_project_id"],
        name=data["name"],
        target_text=data["target_text"],
        target_pronunciation=data["target_pronunciation"],
        created_at=data["created_at"],
        updated_at=data["updated_at"],
        crossfade_ms=data["crossfade_ms"],
        segments=[
            TimelineSegment(
                **{
                    **segment,
                    "match_status": MatchStatus(segment["match_status"]),
                    "gap_before_ms": segment.get(
                        "gap_before_ms",
                        segment["timeline_start_ms"]
                        - (data["segments"][index - 1]["timeline_end_ms"] if index else 0),
                    ),
                    "crossfade_ms": segment.get(
                        "crossfade_ms",
                        max(0, min(MAX_CROSSFADE_MS, -segment.get("gap_before_ms", 0))),
                    ),
                    "stretch_percent": segment.get("stretch_percent", MIN_STRETCH_PERCENT),
                    "lane": segment.get("lane", index % 2),
                    "phone_units": [
                        PhoneUnit(
                            **{
                                **unit,
                                "operation": PhoneAlignmentOperation(unit["operation"]),
                            }
                        )
                        for unit in segment.get("phone_units", [])
                    ],
                    "edit_regions": [EditRegion(**region) for region in segment.get("edit_regions", [])],
                    "volume_envelope": [VolumeEnvelopePoint(**point) for point in segment.get("volume_envelope", [])],
                    "pitch_envelope": [PitchEnvelopePoint(**point) for point in segment.get("pitch_envelope", [])],
                    "user_guide_source_ms": segment.get("user_guide_source_ms", []),
                }
            )
            for index, segment in enumerate(data["segments"])
        ],
        mode=CompositionMode(data.get("mode", CompositionMode.SIMPLE)),
        schema_version=data.get("schema_version", 1),
        parent_composition_id=data.get("parent_composition_id"),
        parent_composition_updated_at=data.get("parent_composition_updated_at"),
        tempo_bpm=data.get("tempo_bpm", PROFESSIONAL_TEMPO_DEFAULT_BPM),
        beats_per_bar=data.get("beats_per_bar", PROFESSIONAL_BEATS_PER_BAR_DEFAULT),
        beat_division=data.get("beat_division", PROFESSIONAL_BEAT_DIVISION_DEFAULT),
        grid_offset_units=data.get("grid_offset_units", PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT),
    )


def get_composition(project_dir: Path, composition_id: str) -> CompositionProject:
    path = _composition_path(project_dir, composition_id)
    if not path.is_file():
        raise FileNotFoundError(composition_id)
    composition = load_composition(path)
    if composition.corpus_project_id != project_dir.name:
        raise FileNotFoundError(composition_id)
    return composition


def _composition_path(project_dir: Path, composition_id: str) -> Path:
    return collage_dir(composition_id) / "collage.json"


def _validate_request(request: SaveCompositionRequest) -> None:
    if not request.name.strip():
        raise ValueError("프로젝트 이름이 비어 있습니다.")
    if not request.target_text.strip():
        raise ValueError("대상 문장이 비어 있습니다.")
    if not isinstance(request.crossfade_ms, int) or isinstance(request.crossfade_ms, bool) or not math.isfinite(request.crossfade_ms) or not 0 <= request.crossfade_ms <= MAX_CROSSFADE_MS:
        raise ValueError("크로스페이드는 0ms 이상 100ms 이하여야 합니다.")
    new_professional_schema = request.mode == CompositionMode.PROFESSIONAL and any(
        segment.edit_regions for segment in request.segments
    )
    if request.schema_version < 1:
        raise ValueError("합성 스키마 버전이 잘못됐습니다.")
    if not isinstance(request.tempo_bpm, int) or isinstance(request.tempo_bpm, bool) or not PROFESSIONAL_TEMPO_MIN_BPM <= request.tempo_bpm <= PROFESSIONAL_TEMPO_MAX_BPM:
        raise ValueError("Tempo must be an integer from 20 to 400 BPM.")
    if not isinstance(request.beats_per_bar, int) or isinstance(request.beats_per_bar, bool) or not PROFESSIONAL_BEATS_PER_BAR_MIN <= request.beats_per_bar <= PROFESSIONAL_BEATS_PER_BAR_MAX:
        raise ValueError("Beats per bar must be an integer from 1 to 16.")
    if not isinstance(request.beat_division, int) or isinstance(request.beat_division, bool) or request.beat_division not in PROFESSIONAL_BEAT_DIVISIONS:
        raise ValueError("Unsupported beat subdivision.")
    if not isinstance(request.grid_offset_units, int) or isinstance(request.grid_offset_units, bool):
        raise ValueError("Grid offset must be an integer number of 1/96 whole-note units.")  # noqa: TRY004
    previous: TimelineSegment | None = None
    two_back: TimelineSegment | None = None
    segment_ids: set[str] = set()
    region_ids: set[str] = set()
    for index, segment in enumerate(request.segments):
        if new_professional_schema and segment.segment_id in segment_ids:
            raise ValueError("Duplicate segment IDs are not allowed.")
        segment_ids.add(segment.segment_id)
        if segment.target_end_index <= segment.target_start_index:
            raise ValueError("대상 음소 범위가 잘못됐습니다.")
        if segment.source_end_ms <= segment.source_start_ms:
            raise ValueError("소스 구간이 잘못됐습니다.")
        if segment.timeline_end_ms <= segment.timeline_start_ms:
            raise ValueError("타임라인 구간이 잘못됐습니다.")
        if request.mode == CompositionMode.PROFESSIONAL:
            if new_professional_schema and segment.edit_regions and (
                not isinstance(segment.gap_before_ms, int) or isinstance(segment.gap_before_ms, bool)
            ):
                raise ValueError("Gap must be an integer number of milliseconds.")
            if new_professional_schema and any(not isinstance(value, int) or isinstance(value, bool) for value in (
                segment.source_start_ms, segment.source_end_ms,
                segment.timeline_start_ms, segment.timeline_end_ms,
            )):
                raise ValueError("Professional timeline bounds must be integer milliseconds.")
            _validate_professional_segment(segment, index, previous, two_back, region_ids, new_professional_schema)
            expected_ms = sum(region.output_duration_ms for region in segment.edit_regions) if segment.edit_regions else sum(unit.output_duration_ms for unit in segment.phone_units)
        else:
            if not MIN_STRETCH_PERCENT <= segment.stretch_percent <= MAX_STRETCH_PERCENT:
                raise ValueError("Stretch must be between 100% and 150%.")
            expected_ms = (
                (segment.source_end_ms - segment.source_start_ms) * segment.stretch_percent + 50
            ) // 100
        if segment.timeline_end_ms - segment.timeline_start_ms != expected_ms:
            raise ValueError("합성 조각의 출력 길이가 타임라인 길이와 다릅니다.")
        two_back, previous = previous, segment
    if new_professional_schema:
        lane_ends: list[int] = []
        for segment in sorted(request.segments, key=lambda item: (item.timeline_start_ms, item.segment_id)):
            lane = next((index for index, end in enumerate(lane_ends) if end <= segment.timeline_start_ms), len(lane_ends))
            if lane == len(lane_ends):
                lane_ends.append(segment.timeline_end_ms)
            else:
                lane_ends[lane] = segment.timeline_end_ms
            if segment.lane != lane:
                raise ValueError("Professional lanes must use deterministic lowest available lane assignment.")


def _validate_parent_dependency(
    project_dir: Path,
    request: SaveCompositionRequest,
    composition_id: str | None = None,
) -> None:
    if request.mode == CompositionMode.SIMPLE:
        if request.parent_composition_id is not None:
            raise ValueError("단순 합성은 부모 합성을 참조할 수 없습니다.")
        return
    if request.parent_composition_id is None:
        raise ValueError("전문 합성에는 원본 단순 합성이 필요합니다.")
    if request.parent_composition_id == composition_id:
        raise ValueError("전문 합성은 자기 자신을 부모로 참조할 수 없습니다.")
    try:
        parent = get_composition(project_dir, request.parent_composition_id)
    except FileNotFoundError as error:
        raise ValueError("원본 단순 합성을 찾을 수 없습니다.") from error
    if parent.mode != CompositionMode.SIMPLE:
        raise ValueError("전문 합성의 부모는 단순 합성이어야 합니다.")
    if request.parent_composition_updated_at != parent.updated_at:
        raise ValueError("원본 단순 합성이 변경되었습니다. 원본에서 다시 불러오세요.")
    if request.target_text.strip() != parent.target_text:
        raise ValueError("전문 합성의 대상 문장이 원본 단순 합성과 다릅니다.")
    if request.target_pronunciation.strip() != parent.target_pronunciation:
        raise ValueError("전문 합성의 발음형이 원본 단순 합성과 다릅니다.")


def _validate_professional_segment(
    segment: TimelineSegment,
    index: int,
    previous: TimelineSegment | None,
    two_back: TimelineSegment | None,
    region_ids: set[str],
    independent_timeline: bool = False,
) -> None:
    if independent_timeline:
        if segment.timeline_start_ms < 0 or not isinstance(segment.lane, int) or isinstance(segment.lane, bool) or segment.lane < 0:
            raise ValueError("Professional starts and lanes must be nonnegative integers.")
        if segment.crossfade_ms is not None and (not isinstance(segment.crossfade_ms, int) or isinstance(segment.crossfade_ms, bool) or not 0 <= segment.crossfade_ms <= MAX_CROSSFADE_MS):
            raise ValueError("Crossfade must be an integer from 0 to 100 milliseconds.")
    if not independent_timeline and segment.edit_regions and segment.gap_before_ms < 0 and (previous is None or -segment.gap_before_ms > min(
        segment.timeline_end_ms - segment.timeline_start_ms,
        previous.timeline_end_ms - previous.timeline_start_ms,
    )):
        raise ValueError("Overlap cannot exceed either neighboring fragment.")
    if not independent_timeline and segment.edit_regions and segment.gap_before_ms < -MAX_CROSSFADE_MS:
        raise ValueError("Overlap cannot exceed 100 milliseconds.")
    if not independent_timeline and segment.edit_regions and previous is None and segment.gap_before_ms < 0:
        raise ValueError("The first fragment cannot overlap a preceding fragment.")
    expected_start = segment.timeline_start_ms if independent_timeline else segment.gap_before_ms if previous is None else previous.timeline_end_ms + segment.gap_before_ms
    if segment.timeline_start_ms != expected_start:
        raise ValueError("전문 합성 조각의 상대 위치가 잘못됐습니다.")
    if not independent_timeline and two_back is not None and segment.timeline_start_ms < two_back.timeline_end_ms:
        raise ValueError("동시에 세 개 이상의 합성 조각을 재생할 수 없습니다.")
    if segment.edit_regions:
        cursor = segment.source_start_ms
        for region in segment.edit_regions:
            if not region.region_id or region.region_id in region_ids:
                raise ValueError("Edit region IDs must be unique.")
            region_ids.add(region.region_id)
            if any(not isinstance(value, int) or isinstance(value, bool) for value in (
                region.source_start_ms, region.source_end_ms, region.output_duration_ms,
                region.relative_pitch_cents,
            )):
                raise ValueError("Edit region times and cents must be integers.")
            source_duration = region.source_end_ms - region.source_start_ms
            if region.source_start_ms != cursor or source_duration <= 0:
                raise ValueError("Edit regions must continuously cover source bounds.")
            if not isinstance(region.output_duration_ms, int) or isinstance(region.output_duration_ms, bool):
                raise ValueError("Edit region duration must be integer milliseconds.")  # noqa: TRY004
            if not isinstance(region.relative_pitch_cents, int) or isinstance(region.relative_pitch_cents, bool):
                raise ValueError("Relative pitch cents must be an integer.")  # noqa: TRY004
            if not math.isfinite(region.output_duration_ms) or not PROFESSIONAL_MIN_DURATION_PERCENT * source_duration / 100 <= region.output_duration_ms <= PROFESSIONAL_MAX_DURATION_PERCENT * source_duration / 100:
                raise ValueError("Edit region duration is outside the allowed range.")
            if not PROFESSIONAL_PITCH_MIN_CENTS <= region.relative_pitch_cents <= PROFESSIONAL_PITCH_MAX_CENTS:
                raise ValueError("Relative pitch cents is outside the allowed range.")
            cursor = region.source_end_ms
        if cursor != segment.source_end_ms:
            raise ValueError("Edit regions must cover the whole source fragment.")
        internal_boundaries = {region.source_start_ms for region in segment.edit_regions[1:]}
        guides = segment.user_guide_source_ms
        if any(not isinstance(point, int) or isinstance(point, bool) or point not in internal_boundaries for point in guides) or len(guides) != len(set(guides)):
            raise ValueError("User length markers must reference unique internal edit boundaries.")
    elif segment.user_guide_source_ms:
        raise ValueError("User length markers require professional edit regions.")
    if segment.volume_envelope:
        points = segment.volume_envelope
        if len(points) < 2 or points[0].position != PROFESSIONAL_ENVELOPE_POSITION_MIN or points[-1].position != PROFESSIONAL_ENVELOPE_POSITION_MAX:
            raise ValueError("Volume envelope must start at 0 and end at 1.")
        if any(isinstance(point.position, bool) or isinstance(point.gain, bool) or not isinstance(point.position, (int, float)) or not isinstance(point.gain, (int, float)) or not math.isfinite(point.position) or not math.isfinite(point.gain) or not PROFESSIONAL_ENVELOPE_POSITION_MIN <= point.position <= PROFESSIONAL_ENVELOPE_POSITION_MAX or not PROFESSIONAL_GAIN_MIN <= point.gain <= PROFESSIONAL_GAIN_MAX for point in points):
            raise ValueError("Volume envelope values are outside the allowed range.")
        if any(left.position >= right.position for left, right in pairwise(points)):
            raise ValueError("Volume envelope positions must increase.")
    if segment.pitch_envelope:
        points = segment.pitch_envelope
        if len(points) < 2 or points[0].position != 0 or points[-1].position != 1:
            raise ValueError("Pitch envelope must start at 0 and end at 1.")
        if any(isinstance(point.position, bool) or not isinstance(point.position, (int, float)) or not math.isfinite(point.position) or not 0 <= point.position <= 1 or not isinstance(point.cents, int) or isinstance(point.cents, bool) or not PROFESSIONAL_PITCH_MIN_CENTS <= point.cents <= PROFESSIONAL_PITCH_MAX_CENTS for point in points):
            raise ValueError("Pitch envelope values are outside the allowed range.")
        if any(left.position >= right.position for left, right in pairwise(points)):
            raise ValueError("Pitch envelope positions must increase.")
    for unit in (() if segment.edit_regions else segment.phone_units):
        if unit.output_duration_ms < 0:
            raise ValueError("음소 출력 길이는 음수가 될 수 없습니다.")
        if unit.source_f0_hz is not None and unit.source_f0_hz <= 0:
            raise ValueError("원본 피치는 0보다 커야 합니다.")
        if unit.target_pitch_midi is not None and not (
            PITCH_MIN_MIDI <= unit.target_pitch_midi <= PITCH_MAX_MIDI
        ):
            raise ValueError("목표 피치가 허용 범위를 벗어났습니다.")
        if not (
            FORMANT_SHIFT_MIN_SEMITONES
            <= unit.formant_shift_semitones
            <= FORMANT_SHIFT_MAX_SEMITONES
        ):
            raise ValueError("포먼트 이동량이 허용 범위를 벗어났습니다.")
        if not 0 <= unit.transition_to_next_ms <= PITCH_TRANSITION_MAX_MS:
            raise ValueError("피치 전환 시간이 허용 범위를 벗어났습니다.")
        if not 0 <= unit.transition_strength_percent <= 100:
            raise ValueError("피치 전환 강도가 허용 범위를 벗어났습니다.")
        if not (
            PITCH_TRANSITION_CENTER_MIN_MS
            <= unit.transition_center_ms
            <= PITCH_TRANSITION_CENTER_MAX_MS
        ):
            raise ValueError("피치 전환 중심이 허용 범위를 벗어났습니다.")
        has_source = unit.source_start_ms is not None and unit.source_end_ms is not None
        if has_source:
            if unit.source_end_ms <= unit.source_start_ms:
                raise ValueError("음소 원본 구간이 잘못됐습니다.")
            if (
                unit.source_start_ms < segment.source_start_ms
                or unit.source_end_ms > segment.source_end_ms
            ):
                raise ValueError("음소 원본 구간이 합성 조각을 벗어났습니다.")
            source_duration = unit.source_end_ms - unit.source_start_ms
            minimum = max(1, round(source_duration * PROFESSIONAL_MIN_DURATION_PERCENT / 100))
            maximum = round(source_duration * PROFESSIONAL_MAX_DURATION_PERCENT / 100)
            if not minimum <= unit.output_duration_ms <= maximum:
                raise ValueError("음소 출력 길이가 허용 범위를 벗어났습니다.")
        elif unit.operation != PhoneAlignmentOperation.DELETE:
            raise ValueError("원본 음소가 없는 편집 단위는 누락 연산이어야 합니다.")


def validate_preview_request(project_dir: Path, request: SaveCompositionRequest) -> None:
    _validate_request(request)
    _validate_parent_dependency(project_dir, request)
    _validate_sources(project_dir, request.segments)


def _validate_sources(project_dir: Path, segments: list[TimelineSegment]) -> None:
    manifest = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    durations = {source["source_id"]: source["duration_ms"] for source in manifest["sources"]}
    for segment in segments:
        duration = durations.get(segment.source_id)
        if duration is None:
            raise ValueError(f"없는 소스입니다: {segment.source_id}")
        if segment.source_start_ms < 0 or segment.source_end_ms > duration:
            raise ValueError(f"소스 범위를 벗어났습니다: {segment.segment_id}")
