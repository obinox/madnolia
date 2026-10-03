import json
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

import numpy as np

from madnolia.constants import SCHEMA_VERSION
from madnolia.storage import load_analysis, publish_analysis_version
from madnolia.types.common import AlignmentMode, InferenceBackend


def finalize_project(
    project_dir: Path,
    model_name: str,
    backend: InferenceBackend,
    device: str,
    alignment_mode: AlignmentMode = AlignmentMode.ESTIMATED,
) -> Path:
    manifest_path = project_dir / "project.json"
    previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else None
    analysis_paths = _active_analysis_paths(project_dir, previous, "*.json")
    results = [load_analysis(path) for path in analysis_paths]
    centroids = _load_active_centroids(project_dir, previous)
    created_at = (
        previous.get("created_at")
        if previous is not None
        else datetime.fromtimestamp(project_dir.stat().st_ctime).astimezone().isoformat()
    )
    manifest = dict(previous or {})
    manifest.update(
        {
            "project_id": project_dir.name,
            "schema_version": SCHEMA_VERSION,
            "created_at": created_at,
            "model_name": model_name,
            "inference_backend": backend.value,
            "inference_device": device,
            "alignment_mode": alignment_mode.value,
            "language": "ko",
            "sources": [asdict(result.source) for result in results],
            "candidate_models": list(
                dict.fromkeys(
                    candidate.model_name
                    for result in results
                    for candidate in result.transcript_candidates
                    if candidate.model_name != model_name
                )
            ),
            "audio_files": dict((previous or {}).get("audio_files", {})),
        }
    )
    publish_analysis_version(project_dir, results, manifest, centroids)
    return project_dir


def _active_analysis_paths(
    project_dir: Path,
    manifest: dict[str, object] | None,
    legacy_pattern: str,
) -> list[Path]:
    if manifest is None:
        paths = sorted((project_dir / "analysis").glob(legacy_pattern))
    else:
        analysis_files = manifest.get("analysis_files")
        if not isinstance(analysis_files, list) or not analysis_files:
            raise ValueError(f"Active manifest has no analysis files: {project_dir}")
        paths = [project_dir / str(relative_path) for relative_path in analysis_files]
        missing = [path for path in paths if not path.is_file()]
        if missing:
            raise FileNotFoundError(missing[0])
    if not paths:
        raise ValueError(f"No analysis JSON files: {project_dir}")
    return paths


def _load_active_centroids(
    project_dir: Path,
    manifest: dict[str, object] | None,
) -> np.ndarray | None:
    if manifest is None:
        return None
    relative_path = manifest.get("acoustic_unit_centroids_file")
    if not relative_path:
        return None
    return np.load(project_dir / str(relative_path))
