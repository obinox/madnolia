import filecmp
import json
import re
import shutil
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from madnolia.constants import DEFAULT_COLLAGES_DIR, MAX_STRETCH_PERCENT, MIN_STRETCH_PERCENT
from madnolia.storage import write_json
from madnolia.types.common import (
    CompositionProject,
    MatchStatus,
    SaveCompositionRequest,
    TimelineSegment,
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
        raise ValueError("잘못된 콜라주 ID입니다.")
    return DEFAULT_COLLAGES_DIR / composition_id


def migrate_legacy_collages(project_dir: Path, *legacy_roots: Path) -> None:
    for root in (*legacy_roots, project_dir):
        directory = root / "compositions"
        for source in directory.glob("comp_*.json"):
            collage = load_composition(source)
            if collage.corpus_project_id != project_dir.name:
                raise ValueError(f"콜라주 프로젝트 참조가 다릅니다: {source}")
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
            raise ValueError(f"콜라주 이전 충돌: {destination}")
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        if not filecmp.cmp(source, destination, shallow=False):
            raise OSError(f"콜라주 복사 검증 실패: {destination}")
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
    )
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
    )
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
                    "stretch_percent": segment.get("stretch_percent", MIN_STRETCH_PERCENT),
                }
            )
            for index, segment in enumerate(data["segments"])
        ],
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
    if not 0 <= request.crossfade_ms <= 100:
        raise ValueError("크로스페이드는 0ms 이상 100ms 이하여야 합니다.")
    for segment in request.segments:
        if segment.target_end_index <= segment.target_start_index:
            raise ValueError("대상 음소 범위가 잘못됐습니다.")
        if segment.source_end_ms <= segment.source_start_ms:
            raise ValueError("소스 구간이 잘못됐습니다.")
        if segment.timeline_end_ms <= segment.timeline_start_ms:
            raise ValueError("타임라인 구간이 잘못됐습니다.")

        if not MIN_STRETCH_PERCENT <= segment.stretch_percent <= MAX_STRETCH_PERCENT:
            raise ValueError("Stretch must be between 100% and 150%.")
        expected_ms = (
            (segment.source_end_ms - segment.source_start_ms) * segment.stretch_percent + 50
        ) // 100
        if segment.timeline_end_ms - segment.timeline_start_ms != expected_ms:
            raise ValueError("Stretched segment duration does not match its timeline duration.")


def validate_preview_request(project_dir: Path, request: SaveCompositionRequest) -> None:
    _validate_request(request)
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
