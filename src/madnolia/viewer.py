import json
import wave
from contextlib import asynccontextmanager
from dataclasses import asdict
from functools import lru_cache
from pathlib import Path
from threading import Condition, Thread
from uuid import uuid4

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from madnolia.compositions import (
    collage_dir,
    create_composition,
    get_composition,
    list_all_collages,
    list_compositions,
    load_composition,
    update_composition,
    validate_preview_request,
)
from madnolia.constants import (
    ANALYSIS_MODEL_OPTIONS,
    DEFAULT_INPUT_DIR,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_PROJECTS_DIR,
    OPENVINO_MODEL_REPOSITORIES,
    SUPPORTED_VIDEO_EXTENSIONS,
    VIEWER_MAX_WAVEFORM_BINS,
    VIEWER_MIN_WAVEFORM_BINS,
)
from madnolia.exporters import export_composition, render_wav
from madnolia.models import ensure_analysis_models
from madnolia.pipeline import IngestionPipeline
from madnolia.projects import (
    audio_path,
    create_project,
    list_analyses,
    migrate_legacy_projects,
    project_analyses,
    project_dir,
)
from madnolia.search import search_candidates
from madnolia.types.common import (
    AlignmentMode,
    AnalysisCancelled,
    AnalysisJob,
    AnalysisJobStatus,
    AnalysisOverview,
    CreateAnalysisRequest,
    CreateCollageRequest,
    CreateProjectRequest,
    ExportTarget,
    InferenceBackend,
    ProjectSummary,
    SaveCompositionRequest,
    SearchRequest,
    TimelineSlice,
    WaveformData,
)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    migrate_legacy_projects()
    yield


app = FastAPI(title="Madnolia Viewer API", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["*"],
)

_analysis_jobs: dict[str, AnalysisJob] = {}
_analysis_lock = Condition()


@app.get("/api/videos")
def list_videos() -> list[str]:
    if not DEFAULT_INPUT_DIR.is_dir():
        return []
    return sorted(
        path.name
        for path in DEFAULT_INPUT_DIR.iterdir()
        if path.is_file() and path.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS
    )


@app.get("/api/analyses")
def get_analyses() -> list[dict[str, object]]:
    return list_analyses()


@app.post("/api/analyses")
def start_analysis(request: CreateAnalysisRequest) -> dict[str, str]:
    path = DEFAULT_INPUT_DIR / request.filename
    if (
        path.name != request.filename
        or not path.is_file()
        or path.suffix.lower() not in SUPPORTED_VIDEO_EXTENSIONS
    ):
        raise HTTPException(status_code=400, detail="Video must be in the input videos folder")
    if request.model_name not in ANALYSIS_MODEL_OPTIONS or (
        request.backend == InferenceBackend.OPENVINO
        and any(
            model not in OPENVINO_MODEL_REPOSITORIES
            for model in [request.model_name, *request.candidate_models]
        )
    ):
        raise HTTPException(status_code=400, detail="Unsupported model")
    if (
        request.device.upper() not in ("CPU", "GPU")
        or request.backend == InferenceBackend.FASTER_WHISPER
        and request.device.upper() != "CPU"
        or request.alignment_mode not in AlignmentMode
        or request.model_name in request.candidate_models
        or len(set(request.candidate_models)) != len(request.candidate_models)
    ):
        raise HTTPException(status_code=400, detail="Invalid analysis settings")
    with _analysis_lock:
        if any(
            job.status in ("running", "pausing", "paused", "stopping")
            for job in _analysis_jobs.values()
        ):
            raise HTTPException(status_code=409, detail="An analysis is already running")
        job_id = f"job_{uuid4().hex[:16]}"
        _analysis_jobs[job_id] = AnalysisJob(
            job_id=job_id, filename=path.name, status="running", percent=0, stage="대기 중"
        )
    Thread(target=_run_analysis, args=(job_id, path, request), daemon=True).start()
    return {"job_id": job_id}


def _checkpoint(job_id: str) -> None:
    with _analysis_lock:
        job = _analysis_jobs[job_id]
        while job.status in (AnalysisJobStatus.PAUSING, AnalysisJobStatus.PAUSED):
            job.status = AnalysisJobStatus.PAUSED
            _analysis_lock.wait()
        if job.status == AnalysisJobStatus.STOPPING:
            raise AnalysisCancelled()


@app.post("/api/analysis-jobs/{job_id}/{action}")
def control_analysis_job(job_id: str, action: str) -> dict[str, object]:
    with _analysis_lock:
        job = _analysis_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        transitions = {
            "pause": ({AnalysisJobStatus.RUNNING}, AnalysisJobStatus.PAUSING),
            "resume": (
                {AnalysisJobStatus.PAUSING, AnalysisJobStatus.PAUSED},
                AnalysisJobStatus.RUNNING,
            ),
            "stop": (
                {AnalysisJobStatus.RUNNING, AnalysisJobStatus.PAUSING, AnalysisJobStatus.PAUSED},
                AnalysisJobStatus.STOPPING,
            ),
        }
        if action not in transitions:
            raise HTTPException(status_code=404, detail="Unknown action")
        allowed, target = transitions[action]
        if job.status not in allowed:
            raise HTTPException(status_code=409, detail="Job cannot be controlled in this state")
        job.status = target
        _analysis_lock.notify_all()
        return asdict(job)


def _run_analysis(job_id: str, path: Path, request: CreateAnalysisRequest | None = None) -> None:
    request = request or CreateAnalysisRequest(filename=path.name)

    def update(stage: str, percent: float) -> None:
        _checkpoint(job_id)
        with _analysis_lock:
            job = _analysis_jobs[job_id]
            job.stage = stage
            job.percent = round(max(job.percent, min(percent, 99)), 2)

    try:
        _checkpoint(job_id)
        ensure_analysis_models(
            request.model_name,
            request.backend,
            request.candidate_models,
            request.alignment_mode,
            request.acoustic_units,
            on_download=lambda name, percent: _report_download(job_id, name, percent),
            checkpoint=lambda: _checkpoint(job_id),
        )
        with _analysis_lock:
            job = _analysis_jobs[job_id]
            job.download_model = None
            job.download_percent = None
        output = IngestionPipeline(
            request.model_name,
            request.backend,
            request.device.upper(),
            request.candidate_models,
            request.alignment_mode,
            request.acoustic_units,
        ).run(
            DEFAULT_INPUT_DIR,
            DEFAULT_OUTPUT_DIR,
            path,
            update,
        )
        with _analysis_lock:
            job = _analysis_jobs[job_id]
            job.status = "complete"
            job.percent = 100
            job.stage = "분석 완료"
            job.analysis_id = output.name
    except AnalysisCancelled:
        with _analysis_lock:
            job = _analysis_jobs[job_id]
            job.status = AnalysisJobStatus.STOPPED
            job.stage = "분석 중단"
    except Exception as error:  # noqa: BLE001
        with _analysis_lock:
            job = _analysis_jobs[job_id]
            job.status = "failed"
            job.stage = "분석 실패"
            job.error = str(error)


def _report_download(job_id: str, name: str, percent: float) -> None:
    _checkpoint(job_id)
    with _analysis_lock:
        job = _analysis_jobs[job_id]
        job.stage = "모델 다운로드" if not name.endswith("변환") else "모델 변환"
        job.download_model = name
        job.download_percent = max(0.0, min(percent, 100.0))


@app.get("/api/analysis-jobs/{job_id}")
def get_analysis_job(job_id: str) -> dict[str, object]:
    with _analysis_lock:
        job = _analysis_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return asdict(job)


@app.post("/api/projects")
def post_project(request: CreateProjectRequest) -> dict[str, object]:
    try:
        return create_project(request)
    except (ValueError, FileNotFoundError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/projects/{project_id}/search")
def search_project(project_id: str, request: SearchRequest) -> dict[str, object]:
    project_dir = _project_dir(project_id)
    try:
        result = search_candidates(
            request.text,
            _project_analyses(project_dir),
            request.max_candidates_per_start,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return asdict(result)


@app.get("/api/projects/{project_id}/compositions")
def get_compositions(project_id: str) -> list[dict[str, object]]:
    return [asdict(item) for item in list_compositions(_project_dir(project_id))]


@app.get("/api/collages")
def get_all_collages() -> list[dict[str, object]]:
    return [asdict(item) for item in list_all_collages()]


@app.post("/api/collages")
def post_collage(request: CreateCollageRequest) -> dict[str, object]:
    directory = _project_dir(request.project_id)
    try:
        return asdict(create_composition(directory, request.project_id, request.composition))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get("/api/collages/{composition_id}")
def get_collage(composition_id: str) -> dict[str, object]:
    try:
        path = collage_dir(composition_id) / "collage.json"
        if not path.is_file():
            raise FileNotFoundError(composition_id)
        return asdict(load_composition(path))
    except (ValueError, FileNotFoundError) as error:
        raise HTTPException(status_code=404, detail="Collage not found") from error


@app.put("/api/collages/{composition_id}")
def put_collage(composition_id: str, request: SaveCompositionRequest) -> dict[str, object]:
    project_id = get_collage(composition_id)["corpus_project_id"]
    try:
        return asdict(update_composition(_project_dir(project_id), composition_id, request))
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/api/collages/{composition_id}/export/{target}")
def export_collage(composition_id: str, target: ExportTarget) -> FileResponse:
    project_id = get_collage(composition_id)["corpus_project_id"]
    return export_saved_composition(project_id, composition_id, target)


@app.post("/api/projects/{project_id}/compositions/preview")
def preview_composition(project_id: str, request: SaveCompositionRequest) -> Response:
    project_dir = _project_dir(project_id)
    try:
        validate_preview_request(project_dir, request)
        return Response(content=render_wav(project_dir, request), media_type="audio/wav")
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get("/api/projects/{project_id}/compositions/{composition_id}")
def get_saved_composition(project_id: str, composition_id: str) -> dict[str, object]:
    try:
        return asdict(get_composition(_project_dir(project_id), composition_id))
    except (FileNotFoundError, ValueError) as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/api/projects/{project_id}/compositions")
def post_composition(
    project_id: str,
    request: SaveCompositionRequest,
) -> dict[str, object]:
    try:
        composition = create_composition(
            _project_dir(project_id),
            project_id,
            request,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return asdict(composition)


@app.put("/api/projects/{project_id}/compositions/{composition_id}")
def put_composition(
    project_id: str,
    composition_id: str,
    request: SaveCompositionRequest,
) -> dict[str, object]:
    try:
        composition = update_composition(
            _project_dir(project_id),
            composition_id,
            request,
        )
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return asdict(composition)


@app.post("/api/projects/{project_id}/compositions/{composition_id}/export/{target}")
def export_saved_composition(
    project_id: str,
    composition_id: str,
    target: ExportTarget,
) -> FileResponse:
    project_dir = _project_dir(project_id)
    try:
        composition = get_composition(project_dir, composition_id)
        path = export_composition(project_dir, composition, target)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return FileResponse(path, filename=path.name)


@app.get("/api/projects")
def list_projects() -> list[dict[str, object]]:
    projects: list[ProjectSummary] = []
    if not DEFAULT_PROJECTS_DIR.is_dir():
        return []
    for manifest_path in DEFAULT_PROJECTS_DIR.glob("*/project.json"):
        manifest = _read_json(manifest_path)
        sources = manifest.get("sources", [])
        projects.append(
            ProjectSummary(
                project_id=manifest["project_id"],
                name=manifest["name"],
                created_at=manifest["created_at"],
                model_name=manifest["model_name"],
                inference_backend=manifest["inference_backend"],
                inference_device=manifest["inference_device"],
                source_count=len(sources),
                total_duration_ms=sum(source["duration_ms"] for source in sources),
            )
        )
    return [
        asdict(project)
        for project in sorted(
            projects,
            key=lambda project: project.created_at,
            reverse=True,
        )
    ]


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> dict[str, object]:
    project_dir = _project_dir(project_id)
    manifest = _read_json(project_dir / "project.json")
    overviews: list[AnalysisOverview] = []
    for analysis in project_analyses(project_dir):
        overviews.append(
            AnalysisOverview(
                source_id=analysis.source.source_id,
                transcript=" ".join(word.text for word in analysis.words),
                audio_regions=analysis.audio_regions,
                sentences=analysis.sentences,
                words=analysis.words,
                transcript_candidates=analysis.transcript_candidates,
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
    phone_ids = {phone.occurrence_id for phone in phones}
    acoustic_features = [
        feature for feature in analysis.acoustic_features if feature.occurrence_id in phone_ids
    ]
    return asdict(
        TimelineSlice(
            start_ms=start_ms,
            end_ms=end_ms,
            audio_regions=regions,
            words=words,
            phones=phones,
            acoustic_features=acoustic_features,
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
    try:
        path = audio_path(_project_dir(project_id), source_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Audio not found")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Audio not found")
    return asdict(_waveform(path, start_ms, end_ms, bins))


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
    try:
        return project_dir(project_id)
    except FileNotFoundError as error:
        legacy = (DEFAULT_OUTPUT_DIR / project_id).resolve()
        if legacy.parent == DEFAULT_OUTPUT_DIR.resolve() and (legacy / "project.json").is_file():
            return legacy
        raise HTTPException(status_code=404, detail="Project not found") from error


def _analysis_for_source(project_dir: Path, source_id: str):
    manifest = _read_json(project_dir / "project.json")
    source_ids = {source["source_id"] for source in manifest["sources"]}
    if source_id not in source_ids:
        raise HTTPException(status_code=404, detail="Source not found")
    for analysis in project_analyses(project_dir):
        if analysis.source.source_id == source_id:
            return analysis
    raise HTTPException(status_code=404, detail="Analysis not found")


def _project_analyses(project_dir: Path):
    return project_analyses(project_dir)


def _read_json(path: Path) -> dict[str, object]:
    return _read_json_cached(str(path), path.stat().st_mtime_ns)


@lru_cache(maxsize=32)
def _read_json_cached(path: str, modified_ns: int) -> dict[str, object]:
    del modified_ns
    return json.loads(Path(path).read_text(encoding="utf-8"))


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
