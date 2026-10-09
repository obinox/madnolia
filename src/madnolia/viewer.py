import json
import os
import re
import tempfile
from contextlib import asynccontextmanager
from dataclasses import asdict
from functools import lru_cache
from pathlib import Path
from threading import Condition, Lock, Thread
from typing import Annotated
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from madnolia.autotune import analyze_composition_pitch, generate_autotune_envelopes
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
    ANALYSIS_NICKNAME_MAX_LENGTH,
    APPLICATION_ID,
    AUTOTUNE_MAX_STRENGTH_PERCENT,
    AUTOTUNE_MIN_SPEED_MS,
    AUTOTUNE_MIN_STRENGTH_PERCENT,
    CUDA_DEVICE,
    DEFAULT_INPUT_DIR,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_PROJECTS_DIR,
    EXPORT_JOB_STAGE_COMPLETE,
    EXPORT_JOB_STAGE_FAILED,
    EXPORT_JOB_STAGE_QUEUED,
    OPENVINO_MODEL_REPOSITORIES,
    QWEN_ASR_MODEL_REPOSITORIES,
    SUPPORTED_VIDEO_EXTENSIONS,
    VIDEO_UPLOAD_CHUNK_SIZE,
    VIEWER_LOG_PATH,
    VIEWER_MAX_WAVEFORM_BINS,
    VIEWER_MIN_WAVEFORM_BINS,
    WINDOWS_RESERVED_FILENAME_PATTERN,
    XPU_DEVICE,
)
from madnolia.exporters import export_composition, render_wav
from madnolia.hardware import detect_analysis_hardware
from madnolia.models import ensure_analysis_models
from madnolia.pipeline import IngestionPipeline
from madnolia.portable import web_directory
from madnolia.projects import (
    audio_path,
    create_project,
    list_analyses,
    migrate_legacy_projects,
    project_analyses,
    project_dir,
    project_source_labels,
    rename_analysis,
)
from madnolia.runtime_logging import configure_viewer_logging, log_event
from madnolia.search import search_candidates
from madnolia.services.media_waveform import _waveform
from madnolia.types.common import (
    AlignmentMode,
    AnalysisCancelled,
    AnalysisJob,
    AnalysisJobStatus,
    AnalysisOverview,
    AutotuneRequest,
    AutotuneResponse,
    CompositionMode,
    CompositionPitchAnalysis,
    CreateAnalysisRequest,
    CreateCollageRequest,
    CreateProjectRequest,
    DetectedAnalysisHardware,
    ExportJob,
    ExportJobStatus,
    ExportTarget,
    InferenceBackend,
    ProjectSummary,
    RenameAnalysisRequest,
    SaveCompositionRequest,
    SearchCancelled,
    SearchJob,
    SearchJobStatus,
    SearchRequest,
    TimelineSlice,
)


def _log(scope: str, message: str, *args: object) -> None:
    log_event(scope, message, *args)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    configure_viewer_logging()
    _log("SYSTEM", "Logging to %s", VIEWER_LOG_PATH.resolve())
    _log("SYSTEM", "Preparing projects and compositions")
    migrate_legacy_projects()
    _log("SYSTEM", "Madnolia Viewer is ready")
    yield


app = FastAPI(title="Madnolia Viewer API", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)

_analysis_jobs: dict[str, AnalysisJob] = {}
_analysis_lock = Condition()
_search_jobs: dict[str, SearchJob] = {}
_search_lock = Lock()
_search_threads: dict[str, Thread] = {}
_export_jobs: dict[str, ExportJob] = {}
_export_threads: dict[str, Thread] = {}
_export_lock = Lock()
_WINDOWS_RESERVED_FILENAME = re.compile(WINDOWS_RESERVED_FILENAME_PATTERN, re.IGNORECASE)


@app.get("/api/analysis-hardware")
def get_analysis_hardware() -> DetectedAnalysisHardware:
    return detect_analysis_hardware()


@app.get("/api/videos")
def list_videos() -> list[str]:
    if not DEFAULT_INPUT_DIR.is_dir():
        return []
    return sorted(
        path.name
        for path in DEFAULT_INPUT_DIR.iterdir()
        if path.is_file() and path.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS
    )


@app.post("/api/videos")
async def upload_video(request: Request, file: Annotated[UploadFile, File()]) -> dict[str, str]:
    origin = request.headers.get("origin")
    if origin:
        allowed_origins = {
            f"{request.url.scheme}://{request.url.netloc}",
            "http://127.0.0.1:5173",
            "http://localhost:5173",
        }
        if origin not in allowed_origins or urlsplit(origin).scheme not in {"http", "https"}:
            raise HTTPException(status_code=403, detail="영상 업로드 요청을 허용하지 않는 주소입니다.")
    filename = file.filename or ""
    _log("UPLOAD", "Receiving video: %s", filename or "<unnamed>")
    path = Path(filename)
    if (
        not filename
        or filename in {".", ".."}
        or "/" in filename
        or "\\" in filename
        or any(ord(character) < 32 or character in '<>:"|?*' for character in filename)
        or filename.endswith((".", " "))
        or _WINDOWS_RESERVED_FILENAME.fullmatch(filename.split(".", 1)[0])
        or path.suffix.lower() not in SUPPORTED_VIDEO_EXTENSIONS
    ):
        raise HTTPException(status_code=400, detail="지원하지 않는 영상 파일 이름 또는 형식입니다.")

    DEFAULT_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", dir=DEFAULT_INPUT_DIR, prefix=".upload-", suffix=".part", delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
            while chunk := await file.read(VIDEO_UPLOAD_CHUNK_SIZE):
                temporary.write(chunk)

        candidate = DEFAULT_INPUT_DIR / filename
        while True:
            try:
                if os.name == "nt":
                    os.rename(temporary_path, candidate)
                else:
                    os.link(temporary_path, candidate)
                break
            except FileExistsError:
                candidate = DEFAULT_INPUT_DIR / f"{path.stem}_{uuid4().hex[:8]}{path.suffix}"
        _log("UPLOAD", "Saved %s (%.1f MB)", candidate.name, candidate.stat().st_size / 1_048_576)
        return {"filename": candidate.name}
    except HTTPException:
        raise
    except OSError as error:
        raise HTTPException(status_code=500, detail="영상 파일을 저장하지 못했습니다. 저장 공간을 확인해 주세요.") from error
    finally:
        try:
            await file.close()
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)


@app.get("/api/analyses")
def get_analyses() -> list[dict[str, object]]:
    return list_analyses()


@app.put("/api/analyses/{analysis_id}/nickname")
def put_analysis_nickname(
    analysis_id: str, request: RenameAnalysisRequest
) -> dict[str, object]:
    try:
        return rename_analysis(analysis_id, request.nickname)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Analysis not found") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/api/analyses")
def start_analysis(request: CreateAnalysisRequest) -> dict[str, str]:
    if len(request.nickname.strip()) > ANALYSIS_NICKNAME_MAX_LENGTH:
        raise HTTPException(status_code=400, detail="Analysis nickname is too long")
    path = DEFAULT_INPUT_DIR / request.filename
    if (
        path.name != request.filename
        or not path.is_file()
        or path.suffix.lower() not in SUPPORTED_VIDEO_EXTENSIONS
    ):
        raise HTTPException(status_code=400, detail="Video must be in the input videos folder")
    if request.model_name not in (
        QWEN_ASR_MODEL_REPOSITORIES if request.backend == InferenceBackend.QWEN_ASR
        else ANALYSIS_MODEL_OPTIONS
    ) or (
        request.backend == InferenceBackend.OPENVINO
        and any(
            model not in OPENVINO_MODEL_REPOSITORIES
            for model in [request.model_name, *request.candidate_models]
        )
    ):
        raise HTTPException(status_code=400, detail="Unsupported model")
    if request.backend == InferenceBackend.QWEN_ASR and any(
        model not in QWEN_ASR_MODEL_REPOSITORIES for model in request.candidate_models
    ):
        raise HTTPException(status_code=400, detail="Unsupported model")
    if (
        request.backend == InferenceBackend.OPENVINO
        and request.device.upper() not in ("CPU", "GPU")
        or request.backend == InferenceBackend.FASTER_WHISPER
        and request.device.upper() not in ("CPU", CUDA_DEVICE)
        or request.backend == InferenceBackend.QWEN_ASR
        and request.device.upper() not in ("CPU", CUDA_DEVICE, XPU_DEVICE)
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
    _log(
        "ANALYSIS",
        "Queued %s with %s/%s on %s (%s)",
        path.name,
        request.backend,
        request.model_name,
        request.device.upper(),
        job_id,
    )
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
        _log("ANALYSIS", "%s requested for %s", action.capitalize(), job_id)
        return asdict(job)


def _run_analysis(job_id: str, path: Path, request: CreateAnalysisRequest | None = None) -> None:
    request = request or CreateAnalysisRequest(filename=path.name)
    last_stage = ""
    last_percent_bucket = -1

    def update(stage: str, percent: float) -> None:
        nonlocal last_percent_bucket, last_stage
        _checkpoint(job_id)
        with _analysis_lock:
            job = _analysis_jobs[job_id]
            job.stage = stage
            job.percent = round(max(job.percent, min(percent, 99)), 2)
            percent_bucket = int(job.percent // 10)
            if stage != last_stage or percent_bucket != last_percent_bucket:
                _log("ANALYSIS", "%s: %s (%.0f%%)", path.name, stage, job.percent)
                last_stage = stage
                last_percent_bucket = percent_bucket

    try:
        _log("ANALYSIS", "Started %s (%s)", path.name, job_id)
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
        if request.nickname.strip():
            rename_analysis(output.name, request.nickname)
        with _analysis_lock:
            job = _analysis_jobs[job_id]
            job.status = "complete"
            job.percent = 100
            job.stage = "분석 완료"
            job.analysis_id = output.name
        _log("ANALYSIS", "Completed %s -> %s", path.name, output.name)
    except AnalysisCancelled:
        with _analysis_lock:
            job = _analysis_jobs[job_id]
            job.status = AnalysisJobStatus.STOPPED
            job.stage = "분석 중단"
        _log("ANALYSIS", "Stopped %s (%s)", path.name, job_id)
    except Exception as error:  # noqa: BLE001
        with _analysis_lock:
            job = _analysis_jobs[job_id]
            job.status = "failed"
            job.stage = "분석 실패"
            job.error = str(error)
        _log("ANALYSIS", "Failed %s: %s", path.name, error)


def _report_download(job_id: str, name: str, percent: float) -> None:
    _checkpoint(job_id)
    with _analysis_lock:
        job = _analysis_jobs[job_id]
        previous_percent = job.download_percent
        job.stage = "모델 다운로드" if not name.endswith("변환") else "모델 변환"
        job.download_model = name
        job.download_percent = max(0.0, min(percent, 100.0))
        if previous_percent is None or int(previous_percent // 10) != int(job.download_percent // 10):
            _log("ANALYSIS", "%s: %s (%.0f%%)", name, job.stage, job.download_percent)


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
        project = create_project(request)
        _log(
            "PROJECT",
            "Created %s with %d source(s): %s",
            project["project_id"],
            len(request.analysis_ids),
            request.name,
        )
        return project
    except (ValueError, FileNotFoundError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "app": APPLICATION_ID, "data_root": str(Path.cwd().resolve())}


@app.post("/api/projects/{project_id}/search")
def search_project(project_id: str, request: SearchRequest) -> dict[str, object]:
    project_dir = _project_dir(project_id)
    try:
        result = search_candidates(
            request.text,
            _project_analyses(project_dir),
            request.max_candidates_per_start,
            request.input_language,
            request.include_exact,
            request.include_approximate,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {**asdict(result), "source_labels": project_source_labels(project_dir)}


def _run_search_job(job_id: str, project_id: str, request: SearchRequest) -> None:
    last_stage = ""

    def checkpoint() -> None:
        with _search_lock:
            job = _search_jobs[job_id]
            if job.status == SearchJobStatus.CANCELLING:
                raise SearchCancelled()

    def report(stage: str, stage_percent: float) -> None:
        nonlocal last_stage
        ranges = {"corpus": (0, 8), "phonetic": (8, 15), "exact": (15, 42), "approximate": (42, 90), "sorting": (90, 100)}
        start, end = ranges[stage]
        with _search_lock:
            job = _search_jobs[job_id]
            if job.status == SearchJobStatus.RUNNING:
                job.stage = stage
                job.percent = max(job.percent, start + (end - start) * stage_percent / 100)
                if stage != last_stage:
                    _log("SEARCH", "%s: %s", job_id, stage)
                    last_stage = stage

    try:
        _log(
            "SEARCH",
            "Started %s for project %s: %r (%s, exact=%s, similar=%s)",
            job_id,
            project_id,
            request.text,
            request.input_language,
            request.include_exact,
            request.include_approximate,
        )
        directory = _project_dir(project_id)
        report("corpus", 0)
        checkpoint()
        analyses = _project_analyses(directory)
        report("corpus", 100)
        result = search_candidates(
            request.text,
            analyses,
            request.max_candidates_per_start,
            request.input_language,
            request.include_exact,
            request.include_approximate,
            progress_callback=report,
            checkpoint=checkpoint,
        )
        payload = {**asdict(result), "source_labels": project_source_labels(directory)}
        with _search_lock:
            job = _search_jobs[job_id]
            if job.status == SearchJobStatus.RUNNING:
                job.status = SearchJobStatus.COMPLETE
                job.stage = "complete"
                job.percent = 100
                job.result = payload
        _log(
            "SEARCH",
            "Completed %s: %d phone(s), %d candidate(s)",
            job_id,
            len(result.target_phones),
            len(result.candidates),
        )
    except SearchCancelled:
        pass
    except (ValueError, FileNotFoundError) as error:
        with _search_lock:
            job = _search_jobs[job_id]
            if job.status == SearchJobStatus.CANCELLING:
                return
            failed_stage = job.stage
            job.status = SearchJobStatus.FAILED
            job.stage = "failed"
            job.error = f"{failed_stage} 단계에서 검색하지 못했습니다: {error}"
        _log("SEARCH", "Failed %s during %s: %s", job_id, failed_stage, error)
    except Exception as error:  # noqa: BLE001
        with _search_lock:
            job = _search_jobs[job_id]
            if job.status == SearchJobStatus.CANCELLING:
                return
            failed_stage = job.stage
            job.status = SearchJobStatus.FAILED
            job.stage = "failed"
            job.error = f"{failed_stage} 단계에서 오류가 발생했습니다: {error}"
        _log("SEARCH", "Failed %s during %s: %s", job_id, failed_stage, error)
    finally:
        with _search_lock:
            job = _search_jobs[job_id]
            if job.status == SearchJobStatus.CANCELLING:
                job.status = SearchJobStatus.CANCELLED
                job.stage = "cancelled"
                job.percent = 100


@app.post("/api/projects/{project_id}/search-jobs")
def start_search_job(project_id: str, request: SearchRequest) -> dict[str, object]:
    _project_dir(project_id)
    with _search_lock:
        if any(
            job.project_id == project_id and (
                job.status in {SearchJobStatus.RUNNING, SearchJobStatus.CANCELLING}
                or (_search_threads.get(job.job_id) is not None and _search_threads[job.job_id].is_alive())
            )
            for job in _search_jobs.values()
        ):
            raise HTTPException(status_code=409, detail="A search is already running")
        job_id = f"search_{uuid4().hex}"
        _search_jobs[job_id] = SearchJob(
            job_id=job_id,
            project_id=project_id,
            status=SearchJobStatus.RUNNING,
            percent=0,
            stage="queued",
        )
        worker = Thread(target=_run_search_job, args=(job_id, project_id, request), daemon=True)
        _search_threads[job_id] = worker
    worker.start()
    _log("SEARCH", "Queued %s", job_id)
    return {"job_id": job_id}


def _search_job_payload_locked(job: SearchJob) -> dict[str, object]:
    payload = asdict(job)
    worker = _search_threads.get(job.job_id)
    if worker is not None and worker.is_alive() and job.status in {
        SearchJobStatus.COMPLETE,
        SearchJobStatus.CANCELLED,
        SearchJobStatus.FAILED,
    }:
        if job.status == SearchJobStatus.CANCELLED:
            payload["status"] = SearchJobStatus.CANCELLING
            payload["stage"] = "중단 마무리 중"
        else:
            payload["status"] = SearchJobStatus.RUNNING
            payload["stage"] = "작업 마무리 중"
    return payload


@app.get("/api/search-jobs/{job_id}")
def get_search_job(job_id: str) -> dict[str, object]:
    with _search_lock:
        job = _search_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Search job not found")
        return _search_job_payload_locked(job)


@app.delete("/api/search-jobs/{job_id}")
def cancel_search_job(job_id: str) -> dict[str, object]:
    with _search_lock:
        job = _search_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Search job not found")
        if job.status == SearchJobStatus.RUNNING:
            job.status = SearchJobStatus.CANCELLING
            job.stage = "cancelling"
            _log("SEARCH", "Cancellation requested for %s", job_id)
        return _search_job_payload_locked(job)


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
        composition = create_composition(directory, request.project_id, request.composition)
        _log(
            "COMPOSITION",
            "Created %s with %d segment(s): %s",
            composition.composition_id,
            len(composition.segments),
            composition.name,
        )
        return asdict(composition)
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
        raise HTTPException(status_code=404, detail="합성을 찾을 수 없습니다.") from error


@app.put("/api/collages/{composition_id}")
def put_collage(composition_id: str, request: SaveCompositionRequest) -> dict[str, object]:
    project_id = get_collage(composition_id)["corpus_project_id"]
    try:
        composition = update_composition(_project_dir(project_id), composition_id, request)
        _log("COMPOSITION", "Updated %s with %d segment(s)", composition_id, len(composition.segments))
        return asdict(composition)
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/api/collages/{composition_id}/export/{target}")
def export_collage(composition_id: str, target: ExportTarget) -> FileResponse:
    project_id = get_collage(composition_id)["corpus_project_id"]
    return export_saved_composition(project_id, composition_id, target)


@app.post("/api/collages/{composition_id}/export-jobs/{target}")
def start_export_job(composition_id: str, target: ExportTarget) -> dict[str, str]:
    collage = get_collage(composition_id)
    project_id = str(collage["corpus_project_id"])
    with _export_lock:
        if any(
            job.composition_id == composition_id
            and job.target == target
            and (
                job.status == ExportJobStatus.RUNNING
                or (_export_threads.get(job.job_id) is not None and _export_threads[job.job_id].is_alive())
            )
            for job in _export_jobs.values()
        ):
            raise HTTPException(status_code=409, detail="This export is already running")
        job_id = f"export_{uuid4().hex}"
        filename = f"{composition_id}.{target.value.lower()}"
        _export_jobs[job_id] = ExportJob(
            job_id=job_id,
            composition_id=composition_id,
            target=target,
            status=ExportJobStatus.RUNNING,
            percent=0,
            stage=EXPORT_JOB_STAGE_QUEUED,
            filename=filename,
        )
        worker = Thread(
            target=_run_export_job,
            args=(job_id, project_id, composition_id),
            daemon=True,
        )
        _export_threads[job_id] = worker
    worker.start()
    _log("COMPOSITION", "Queued export %s as %s", job_id, target)
    return {"job_id": job_id}


def _run_export_job(job_id: str, project_id: str, composition_id: str) -> None:
    try:
        directory = _project_dir(project_id)
        composition = get_composition(directory, composition_id)

        def report(stage: str, percent: float) -> None:
            with _export_lock:
                job = _export_jobs[job_id]
                if job.status == ExportJobStatus.RUNNING:
                    job.stage = stage
                    job.percent = min(99, max(job.percent, percent))

        with _export_lock:
            target = _export_jobs[job_id].target
        path = export_composition(directory, composition, target, progress_callback=report)
        with _export_lock:
            job = _export_jobs[job_id]
            job.filename = path.name
            job.status = ExportJobStatus.COMPLETE
            job.percent = 100
            job.stage = EXPORT_JOB_STAGE_COMPLETE
        _log("COMPOSITION", "Export job complete: %s", job_id)
    except Exception as error:  # noqa: BLE001
        with _export_lock:
            job = _export_jobs[job_id]
            job.status = ExportJobStatus.FAILED
            job.stage = EXPORT_JOB_STAGE_FAILED
            job.error = str(error)
        _log("COMPOSITION", "Export job failed %s: %s", job_id, error)


def _export_job_payload_locked(job: ExportJob) -> dict[str, object]:
    payload = asdict(job)
    worker = _export_threads.get(job.job_id)
    if worker is not None and worker.is_alive() and job.status in {
        ExportJobStatus.COMPLETE,
        ExportJobStatus.FAILED,
    }:
        payload["status"] = ExportJobStatus.RUNNING
        payload["stage"] = "작업 마무리 중"
    return payload


@app.get("/api/export-jobs/{job_id}")
def get_export_job(job_id: str) -> dict[str, object]:
    with _export_lock:
        job = _export_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Export job not found")
        return _export_job_payload_locked(job)


@app.get("/api/export-jobs/{job_id}/download")
def download_export_job(job_id: str) -> FileResponse:
    with _export_lock:
        job = _export_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Export job not found")
        worker = _export_threads.get(job_id)
        if job.status == ExportJobStatus.RUNNING or (worker is not None and worker.is_alive()):
            raise HTTPException(status_code=409, detail="Export is still running")
        if job.status == ExportJobStatus.FAILED:
            raise HTTPException(status_code=400, detail=job.error or "Export failed")
        path = collage_dir(job.composition_id) / "exports" / job.filename
        filename = job.filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Export file not found")
    return FileResponse(path, filename=filename)


@app.post("/api/projects/{project_id}/compositions/preview")
def preview_composition(project_id: str, request: SaveCompositionRequest) -> Response:
    project_dir = _project_dir(project_id)
    try:
        _log("COMPOSITION", "Rendering preview with %d segment(s)", len(request.segments))
        validate_preview_request(project_dir, request)
        content = render_wav(project_dir, request)
        _log("COMPOSITION", "Preview ready (%.1f MB)", len(content) / 1_048_576)
        return Response(content=content, media_type="audio/wav")
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/api/projects/{project_id}/compositions/autotune")
def autotune_composition(project_id: str, request: AutotuneRequest) -> AutotuneResponse:
    project_dir = _project_dir(project_id)
    if not AUTOTUNE_MIN_STRENGTH_PERCENT <= request.strength_percent <= AUTOTUNE_MAX_STRENGTH_PERCENT:
        raise HTTPException(status_code=400, detail="strength_percent must be between 0 and 100")
    if request.speed_ms < AUTOTUNE_MIN_SPEED_MS:
        raise HTTPException(status_code=400, detail="speed_ms must be nonnegative")
    if request.composition.mode != CompositionMode.PROFESSIONAL or any(
        not segment.edit_regions for segment in request.composition.segments
    ):
        raise HTTPException(
            status_code=400,
            detail="Autotune requires professional composition segments with edit regions",
        )
    try:
        validate_preview_request(project_dir, request.composition)
        segments = generate_autotune_envelopes(
            project_dir,
            request.composition.segments,
            request.strength_percent,
            request.speed_ms,
        )
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return AutotuneResponse(
        segments=[
            segment
            for segment in segments
        ]
    )


@app.get("/api/projects/{project_id}/compositions/{composition_id}")
def get_saved_composition(project_id: str, composition_id: str) -> dict[str, object]:
    try:
        return asdict(get_composition(_project_dir(project_id), composition_id))
    except (FileNotFoundError, ValueError) as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/api/projects/{project_id}/compositions/pitch-analysis")
def analyze_composition_pitch_route(
    project_id: str,
    request: SaveCompositionRequest,
) -> CompositionPitchAnalysis:
    directory = _project_dir(project_id)
    try:
        validate_preview_request(directory, request)
        return analyze_composition_pitch(directory, request.segments, request.pitch_notes)
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


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
    _log(
        "COMPOSITION",
        "Created %s with %d segment(s): %s",
        composition.composition_id,
        len(composition.segments),
        composition.name,
    )
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
    _log("COMPOSITION", "Updated %s with %d segment(s)", composition_id, len(composition.segments))
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
        _log("COMPOSITION", "Exporting %s as %s", composition_id, target)
        path = export_composition(project_dir, composition, target)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    _log("COMPOSITION", "Export ready: %s", path)
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
    _log("PROJECT", "Opened %s with %d source(s): %s", project_id, len(overviews), manifest["name"])
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


@app.get("/api/projects/{project_id}/audio/{source_id}")
def get_audio(project_id: str, source_id: str) -> FileResponse:
    try:
        path = audio_path(_project_dir(project_id), source_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Audio not found")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Audio not found")
    size_bytes = path.stat().st_size
    _log("CACHE", "Serving audio for browser cache: %s (%.1f MB)", path.name, size_bytes / 1_048_576)
    return FileResponse(path, media_type="audio/wav", filename=path.name)


def _media_cache_ready(filename: str, size_bytes: int) -> None:
    _log("CACHE", "RAM copy ready: %s (%.1f MB)", filename, size_bytes / 1_048_576)


@app.get("/api/projects/{project_id}/media/{source_id}")
def get_media(project_id: str, source_id: str, request: Request) -> Response:
    project_dir = _project_dir(project_id)
    manifest = _read_json(project_dir / "project.json")
    source = next((item for item in manifest["sources"] if item["source_id"] == source_id), None)
    if source is None:
        raise HTTPException(status_code=404, detail="Source not found")
    media_path = Path(source["path"])
    if not media_path.is_file():
        raise HTTPException(status_code=404, detail="Media file not found")
    if request.headers.get("range") is not None:
        return FileResponse(media_path)
    size_bytes = media_path.stat().st_size
    cache_limit = request.headers.get("x-madnolia-cache-limit")
    if cache_limit is not None:
        try:
            maximum_bytes = max(0, int(cache_limit))
        except ValueError as error:
            raise HTTPException(status_code=400, detail="Invalid media cache limit") from error
        if size_bytes > maximum_bytes:
            _log(
                "CACHE",
                "Streaming without RAM copy: %s (%.1f MB)",
                media_path.name,
                size_bytes / 1_048_576,
            )
            return Response(status_code=204, headers={"X-Madnolia-Media-Size": str(size_bytes)})
    _log("CACHE", "Loading into browser RAM: %s (%.1f MB)", media_path.name, size_bytes / 1_048_576)
    return FileResponse(
        media_path,
        background=BackgroundTask(_media_cache_ready, media_path.name, size_bytes),
    )


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

web_dist = web_directory()
if web_dist.is_dir():
    app.mount("/assets", StaticFiles(directory=web_dist / "assets"), name="assets")

    @app.get("/")
    def frontend() -> FileResponse:
        return FileResponse(web_dist / "index.html")
