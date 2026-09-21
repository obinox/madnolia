import json
import wave
from dataclasses import asdict
from functools import lru_cache
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from madnolia.constants import (
    DEFAULT_OUTPUT_DIR,
    VIEWER_MAX_WAVEFORM_BINS,
    VIEWER_MIN_WAVEFORM_BINS,
)
from madnolia.storage import load_analysis
from madnolia.types.common import (
    AnalysisOverview,
    ProjectSummary,
    TimelineSlice,
    WaveformData,
)

app = FastAPI(title="Madnolia Viewer API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/projects")
def list_projects() -> list[dict[str, object]]:
    projects: list[ProjectSummary] = []
    if not DEFAULT_OUTPUT_DIR.is_dir():
        return []
    for manifest_path in sorted(DEFAULT_OUTPUT_DIR.glob("*/project.json"), reverse=True):
        manifest = _read_json(manifest_path)
        sources = manifest.get("sources", [])
        projects.append(
            ProjectSummary(
                project_id=manifest["project_id"],
                created_at=manifest["created_at"],
                model_name=manifest["model_name"],
                inference_backend=manifest["inference_backend"],
                inference_device=manifest["inference_device"],
                source_count=len(sources),
                total_duration_ms=sum(source["duration_ms"] for source in sources),
            )
        )
    return [asdict(project) for project in projects]


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> dict[str, object]:
    project_dir = _project_dir(project_id)
    manifest = _read_json(project_dir / "project.json")
    overviews: list[AnalysisOverview] = []
    for analysis_file in manifest["analysis_files"]:
        analysis = load_analysis(project_dir / analysis_file)
        overviews.append(
            AnalysisOverview(
                source_id=analysis.source.source_id,
                transcript=analysis.transcript,
                audio_regions=analysis.audio_regions,
                word_count=len(analysis.words),
                phone_count=len(analysis.phones),
            )
        )
    return {"manifest": manifest, "analyses": [asdict(overview) for overview in overviews]}


@app.get("/api/projects/{project_id}/timeline")
def get_timeline(
    project_id: str,
    source_id: str,
    start_ms: int = Query(ge=0),
    end_ms: int = Query(gt=0),
    include_words: bool = True,
    include_phones: bool = True,
) -> dict[str, object]:
    if end_ms <= start_ms:
        raise HTTPException(status_code=400, detail="end_ms must be greater than start_ms")
    analysis = _analysis_for_source(_project_dir(project_id), source_id)
    regions = [
        region
        for region in analysis.audio_regions
        if region.start_ms < end_ms and region.end_ms > start_ms
    ]
    words = (
        [word for word in analysis.words if word.start_ms < end_ms and word.end_ms > start_ms]
        if include_words
        else []
    )
    phones = (
        [phone for phone in analysis.phones if phone.start_ms < end_ms and phone.end_ms > start_ms]
        if include_phones
        else []
    )
    return asdict(
        TimelineSlice(
            start_ms=start_ms,
            end_ms=end_ms,
            audio_regions=regions,
            words=words,
            phones=phones,
        )
    )


@app.get("/api/projects/{project_id}/waveform")
def get_waveform(
    project_id: str,
    source_id: str,
    start_ms: int = Query(ge=0),
    end_ms: int = Query(gt=0),
    bins: int = Query(default=1200, ge=VIEWER_MIN_WAVEFORM_BINS, le=VIEWER_MAX_WAVEFORM_BINS),
) -> dict[str, object]:
    if end_ms <= start_ms:
        raise HTTPException(status_code=400, detail="end_ms must be greater than start_ms")
    audio_path = _project_dir(project_id) / "audio" / f"{source_id}.wav"
    if not audio_path.is_file():
        raise HTTPException(status_code=404, detail="Audio not found")
    return asdict(_waveform(audio_path, start_ms, end_ms, bins))


@app.get("/api/projects/{project_id}/media/{source_id}")
def get_media(project_id: str, source_id: str) -> FileResponse:
    project_dir = _project_dir(project_id)
    manifest = _read_json(project_dir / "project.json")
    source = next((item for item in manifest["sources"] if item["source_id"] == source_id), None)
    if source is None:
        raise HTTPException(status_code=404, detail="Source not found")
    media_path = Path(source["path"])
    if not media_path.is_file():
        raise HTTPException(status_code=404, detail="Media file not found")
    return FileResponse(media_path)


def _project_dir(project_id: str) -> Path:
    root = DEFAULT_OUTPUT_DIR.resolve()
    project_dir = (root / project_id).resolve()
    if project_dir.parent != root or not (project_dir / "project.json").is_file():
        raise HTTPException(status_code=404, detail="Project not found")
    return project_dir


def _analysis_for_source(project_dir: Path, source_id: str):
    manifest = _read_json(project_dir / "project.json")
    source_ids = {source["source_id"] for source in manifest["sources"]}
    if source_id not in source_ids:
        raise HTTPException(status_code=404, detail="Source not found")
    for analysis_file in manifest["analysis_files"]:
        analysis_path = project_dir / analysis_file
        analysis = _load_analysis_cached(str(analysis_path), analysis_path.stat().st_mtime_ns)
        if analysis.source.source_id == source_id:
            return analysis
    raise HTTPException(status_code=404, detail="Analysis not found")


def _read_json(path: Path) -> dict[str, object]:
    return _read_json_cached(str(path), path.stat().st_mtime_ns)


@lru_cache(maxsize=32)
def _read_json_cached(path: str, modified_ns: int) -> dict[str, object]:
    del modified_ns
    return json.loads(Path(path).read_text(encoding="utf-8"))


@lru_cache(maxsize=16)
def _load_analysis_cached(path: str, modified_ns: int):
    del modified_ns
    return load_analysis(Path(path))


@lru_cache(maxsize=64)
def _waveform(audio_path: Path, start_ms: int, end_ms: int, bins: int) -> WaveformData:
    with wave.open(str(audio_path), "rb") as audio:
        sample_rate = audio.getframerate()
        total_frames = audio.getnframes()
        start_frame = min(total_frames, round(start_ms * sample_rate / 1000))
        end_frame = min(total_frames, round(end_ms * sample_rate / 1000))
        frame_count = max(0, end_frame - start_frame)
        audio.setpos(start_frame)
        peaks: list[float] = []
        previous_boundary = 0
        for index in range(1, bins + 1):
            boundary = round(frame_count * index / bins)
            raw = audio.readframes(boundary - previous_boundary)
            samples = np.frombuffer(raw, dtype=np.int16)
            peak = float(np.max(np.abs(samples.astype(np.int32))) / 32768) if samples.size else 0.0
            peaks.append(peak)
            previous_boundary = boundary
    return WaveformData(start_ms=start_ms, end_ms=end_ms, peaks=peaks)


web_dist = Path("web/dist")
if web_dist.is_dir():
    app.mount("/assets", StaticFiles(directory=web_dist / "assets"), name="assets")

    @app.get("/")
    def frontend() -> FileResponse:
        return FileResponse(web_dist / "index.html")
