import hashlib
import json
import os
import re
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from uuid import uuid4

from madnolia.compositions import migrate_legacy_collages
from madnolia.constants import (
    ANALYSIS_NICKNAME_MAX_LENGTH,
    AUDIO_CACHE_DIR,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_PROJECTS_DIR,
    SCHEMA_VERSION,
)
from madnolia.storage import load_analysis, write_json
from madnolia.types.common import CreateProjectRequest


def analysis_dir(analysis_id: str) -> Path:
    if not re.fullmatch(r"proj_[0-9]{8}_[0-9]{6}(?:_[0-9a-f]{8})?", analysis_id):
        raise ValueError("Invalid analysis ID")
    directory = DEFAULT_OUTPUT_DIR / analysis_id
    if not (directory / "project.json").is_file():
        raise FileNotFoundError(analysis_id)
    manifest = json.loads((directory / "project.json").read_text(encoding="utf-8"))
    if len(manifest.get("sources", [])) != 1 or len(manifest.get("analysis_files", [])) != 1:
        raise ValueError("An analysis must contain exactly one video")
    return directory


def list_analyses() -> list[dict[str, object]]:
    results = []
    for path in sorted(DEFAULT_OUTPUT_DIR.glob("*/project.json"), reverse=True):
        try:
            directory = analysis_dir(path.parent.name)
        except (ValueError, FileNotFoundError):
            continue
        manifest = json.loads((directory / "project.json").read_text(encoding="utf-8"))
        source = manifest["sources"][0]
        results.append(
            {
                "analysis_id": path.parent.name,
                "created_at": manifest["created_at"],
                "model_name": manifest["model_name"],
                "nickname": manifest.get("nickname") or None,
                "source": source,
            }
        )
    return results


def rename_analysis(analysis_id: str, nickname: str) -> dict[str, object]:
    directory = analysis_dir(analysis_id)
    name = nickname.strip()
    if len(name) > ANALYSIS_NICKNAME_MAX_LENGTH:
        raise ValueError(f"Analysis nickname must be at most {ANALYSIS_NICKNAME_MAX_LENGTH} characters")
    path = directory / "project.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    manifest["nickname"] = name or None
    temporary = path.with_suffix(".json.tmp")
    try:
        write_json(temporary, manifest)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return {
        "analysis_id": analysis_id,
        "created_at": manifest["created_at"],
        "model_name": manifest["model_name"],
        "nickname": manifest["nickname"],
        "source": manifest["sources"][0],
    }


def project_source_labels(directory: Path) -> dict[str, str]:
    manifest = json.loads((directory / "project.json").read_text(encoding="utf-8"))
    labels = {}
    for source in manifest["sources"]:
        source_id = source["source_id"]
        analysis_id = manifest.get("source_analyses", {}).get(source_id)
        nickname = None
        if analysis_id:
            analysis = json.loads((analysis_dir(analysis_id) / "project.json").read_text(encoding="utf-8"))
            nickname = analysis.get("nickname")
        filename = Path(source["path"]).name
        labels[source_id] = f"{nickname} · {filename}" if nickname else filename
    return labels


def create_project(request: CreateProjectRequest) -> dict[str, object]:
    name = request.name.strip()
    ids = request.analysis_ids
    if not name or not ids or len(ids) != len(set(ids)):
        raise ValueError("Provide a name and unique analysis IDs")
    manifests = [
        json.loads((analysis_dir(item) / "project.json").read_text(encoding="utf-8"))
        for item in ids
    ]
    sources = [manifest["sources"][0] for manifest in manifests]
    source_ids = [source["source_id"] for source in sources]
    if len(source_ids) != len(set(source_ids)):
        raise ValueError("Selected analyses have duplicate source IDs")
    project_id = f"collection_{uuid4().hex[:16]}"
    data = {
        "project_id": project_id,
        "name": name,
        "created_at": datetime.now().astimezone().isoformat(),
        "analysis_ids": ids,
        "source_analyses": dict(zip(source_ids, ids, strict=True)),
        "sources": sources,
        "model_name": ", ".join(dict.fromkeys(item["model_name"] for item in manifests)),
        "inference_backend": ", ".join(
            dict.fromkeys(item["inference_backend"] for item in manifests)
        ),
        "inference_device": ", ".join(
            dict.fromkeys(item["inference_device"] for item in manifests)
        ),
    }
    write_json(DEFAULT_PROJECTS_DIR / project_id / "project.json", data)
    return data


def migrate_legacy_projects() -> None:
    migrate_analysis_audio()
    for item in list_analyses():
        analysis_id = item["analysis_id"]
        destination = DEFAULT_PROJECTS_DIR / analysis_id
        if not (destination / "project.json").exists():
            name = Path(item["source"]["path"]).name
            manifest = create_project(CreateProjectRequest(name=name, analysis_ids=[analysis_id]))
            created_dir = DEFAULT_PROJECTS_DIR / manifest["project_id"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            created_dir.rename(destination)
            manifest["project_id"] = analysis_id
            manifest["created_at"] = item["created_at"]
            write_json(destination / "project.json", manifest)
        migrate_legacy_collages(destination, analysis_dir(analysis_id))
    for manifest in DEFAULT_PROJECTS_DIR.glob("*/project.json"):
        migrate_legacy_collages(manifest.parent)


def migrate_analysis_audio() -> None:
    cached: dict[int, list[Path]] = {}
    cache_digests: dict[Path, bytes] = {}
    for path in AUDIO_CACHE_DIR.glob("*.wav"):
        cached.setdefault(path.stat().st_size, []).append(path)
    for item in list_analyses():
        directory = analysis_dir(item["analysis_id"])
        manifest_path = directory / "project.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        source_id = item["source"]["source_id"]
        legacy = directory / "audio" / f"{source_id}.wav"
        if not legacy.is_file():
            continue
        original = legacy.stat()
        original_digest = _file_digest(legacy)
        matching = None
        for path in cached.get(original.st_size, []):
            if path not in cache_digests:
                cache_digests[path] = _file_digest(path)
            if cache_digests[path] == original_digest:
                matching = path
                break
        if matching is None:
            continue
        reference = Path(os.path.relpath(matching.resolve(), directory.resolve())).as_posix()
        audio_files = manifest.setdefault("audio_files", {})
        if audio_files.get(source_id) and audio_files[source_id] != reference:
            continue
        if audio_files.get(source_id) != reference:
            audio_files[source_id] = reference
            manifest["schema_version"] = SCHEMA_VERSION
            temporary = manifest_path.with_suffix(".json.tmp")
            try:
                write_json(temporary, manifest)
                os.replace(temporary, manifest_path)
            finally:
                temporary.unlink(missing_ok=True)
        current = legacy.stat()
        if (
            (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns)
            == (original.st_dev, original.st_ino, original.st_size, original.st_mtime_ns)
            and _file_digest(legacy) == original_digest
            and _file_digest(matching) == original_digest
        ):
            legacy.unlink()
            try:
                legacy.parent.rmdir()
            except OSError:
                pass


def _file_digest(path: Path) -> bytes:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.digest()


def project_dir(project_id: str) -> Path:
    if not re.fullmatch(
        r"(?:collection_[0-9a-f]{16}|proj_[0-9]{8}_[0-9]{6}(?:_[0-9a-f]{8})?)", project_id
    ):
        raise FileNotFoundError(project_id)
    directory = DEFAULT_PROJECTS_DIR / project_id
    if not (directory / "project.json").is_file():
        raise FileNotFoundError(project_id)
    return directory


def project_analyses(directory: Path):
    manifest = json.loads((directory / "project.json").read_text(encoding="utf-8"))
    paths = []
    for item in manifest["analysis_ids"]:
        root = analysis_dir(item)
        analysis_manifest = json.loads((root / "project.json").read_text(encoding="utf-8"))
        paths.append(root / analysis_manifest["analysis_files"][0])
    return [_load_analysis(str(path), path.stat().st_mtime_ns) for path in paths]


@lru_cache(maxsize=8)
def _load_analysis(path: str, modified_ns: int):
    del modified_ns
    return load_analysis(Path(path))


def audio_path(directory: Path, source_id: str) -> Path:
    manifest = json.loads((directory / "project.json").read_text(encoding="utf-8"))
    if "source_analyses" not in manifest:
        return analysis_audio_path(directory, source_id)
    analysis_id = manifest["source_analyses"].get(source_id)
    if analysis_id is None:
        raise FileNotFoundError(source_id)
    return analysis_audio_path(analysis_dir(analysis_id), source_id)


def analysis_audio_path(directory: Path, source_id: str) -> Path:
    manifest = json.loads((directory / "project.json").read_text(encoding="utf-8"))
    if source_id not in {source["source_id"] for source in manifest["sources"]}:
        raise FileNotFoundError(source_id)
    saved = manifest.get("audio_files", {}).get(source_id)
    return directory / saved if saved else directory / "audio" / f"{source_id}.wav"
