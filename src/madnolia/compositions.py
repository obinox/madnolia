import filecmp
import json
import re
import shutil
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from madnolia.constants import (
    DEFAULT_COLLAGES_DIR,
    MAX_CROSSFADE_MS,
    MIN_STRETCH_PERCENT,
    PROFESSIONAL_BEAT_DIVISION_DEFAULT,
    PROFESSIONAL_BEATS_PER_BAR_DEFAULT,
    PROFESSIONAL_GRID_OFFSET_UNITS_DEFAULT,
    PROFESSIONAL_TEMPO_DEFAULT_BPM,
)
from madnolia.services.composition_validation import (
    _validate_request,
)
from madnolia.storage import write_json
from madnolia.types.common import (
    CompositionMode,
    CompositionProject,
    EditRegion,
    MatchStatus,
    PhoneAlignmentOperation,
    PhonePitchOwnerRef,
    PhonePitchPoint,
    PianoRollPitchNote,
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
        pitch_notes=request.pitch_notes,
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
        pitch_notes=request.pitch_notes,
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
                                "pitch_points": [
                                    PhonePitchPoint(**point)
                                    for point in unit.get("pitch_points", [])
                                ],
                                "pitch_owner_ref": (
                                    PhonePitchOwnerRef(**unit["pitch_owner_ref"])
                                    if unit.get("pitch_owner_ref")
                                    else None
                                ),
                            }
                        )
                        for unit in segment.get("phone_units", [])
                    ],
                    "edit_regions": [
                        EditRegion(
                            **{
                                **region,
                                "pitch_points": [
                                    PhonePitchPoint(**point)
                                    for point in region.get("pitch_points", [])
                                ],
                            }
                        )
                        for region in segment.get("edit_regions", [])
                    ],
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
        pitch_notes=[PianoRollPitchNote(note["note_id"], note["start_ms"], note["end_ms"], [PhonePitchPoint(**point) for point in note.get("pitch_points", [])]) for note in data.get("pitch_notes", [])],
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
