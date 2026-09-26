import wave
from threading import Event, Thread
from time import monotonic, sleep
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from madnolia import pipeline, viewer
from madnolia.cli import build_parser
from madnolia.transcription import LocalWhisperTranscriber
from madnolia.types.common import (
    AnalysisCancelled,
    AnalysisJob,
    CreateAnalysisRequest,
    InferenceBackend,
)


def test_transcription_reports_completed_video_duration(tmp_path):
    audio_path = tmp_path / "sample.wav"
    with wave.open(str(audio_path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\x00\x00" * 32000)
    segments = [
        SimpleNamespace(start=0, end=0.5, text="a", words=[]),
        SimpleNamespace(start=0.5, end=1.5, text="b", words=[]),
    ]
    transcriber = LocalWhisperTranscriber.__new__(LocalWhisperTranscriber)
    transcriber._model = SimpleNamespace(
        transcribe=lambda *args, **kwargs: (segments, SimpleNamespace(language_probability=1.0))
    )
    progress = []
    transcriber.transcribe(audio_path, progress_callback=progress.append)
    assert progress == [0.25, 0.75, 1.0]


def test_analysis_job_keeps_last_percent_on_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(viewer, "ensure_analysis_models", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        viewer,
        "_analysis_jobs",
        {"job_test": AnalysisJob("job_test", "sample.mp4", "running", 0, "대기 중")},
    )

    def fail(self, input_dir, output_root, selected_file, report):
        report("음성 전사", 45.375)
        raise RuntimeError("inference failed")

    monkeypatch.setattr(viewer.IngestionPipeline, "run", fail)
    viewer._run_analysis("job_test", tmp_path / "sample.mp4")
    result = viewer.get_analysis_job("job_test")
    assert result["status"] == "failed"
    assert result["percent"] == 45.38
    assert result["error"] == "inference failed"
    assert TestClient(viewer.app).get("/api/analysis-jobs/job_test").json()["percent"] == 45.38


def test_analysis_can_pause_resume_and_stop(tmp_path, monkeypatch):
    monkeypatch.setattr(viewer, "ensure_analysis_models", lambda *args, **kwargs: None)
    started = Event()
    proceed = Event()
    monkeypatch.setattr(
        viewer,
        "_analysis_jobs",
        {
            "job_pause": AnalysisJob("job_pause", "sample.mp4", "running", 0, "대기 중"),
        },
    )

    def work(self, input_dir, output_root, selected_file, report):
        report("음성 전사", 35)
        started.set()
        assert proceed.wait(3)
        report("음성 전사", 50)
        return tmp_path / "completed"

    monkeypatch.setattr(viewer.IngestionPipeline, "run", work)
    worker = Thread(target=viewer._run_analysis, args=("job_pause", tmp_path / "sample.mp4"))
    worker.start()
    assert started.wait(3)
    viewer.control_analysis_job("job_pause", "pause")
    proceed.set()
    deadline = monotonic() + 3
    while viewer.get_analysis_job("job_pause")["status"] != "paused" and monotonic() < deadline:
        sleep(0.01)
    assert viewer.get_analysis_job("job_pause")["status"] == "paused"
    assert viewer.get_analysis_job("job_pause")["percent"] == 35
    viewer.control_analysis_job("job_pause", "resume")
    worker.join(timeout=3)
    assert not worker.is_alive()
    assert viewer.get_analysis_job("job_pause")["status"] == "complete"

    started.clear()
    proceed.clear()
    viewer._analysis_jobs["job_stop"] = AnalysisJob(
        "job_stop", "sample.mp4", "running", 0, "대기 중"
    )
    worker = Thread(target=viewer._run_analysis, args=("job_stop", tmp_path / "sample.mp4"))
    worker.start()
    assert started.wait(3)
    viewer.control_analysis_job("job_stop", "pause")
    proceed.set()
    deadline = monotonic() + 3
    while viewer.get_analysis_job("job_stop")["status"] != "paused" and monotonic() < deadline:
        sleep(0.01)
    assert viewer.get_analysis_job("job_stop")["status"] == "paused"
    viewer.control_analysis_job("job_stop", "stop")
    worker.join(timeout=3)
    assert not worker.is_alive()
    assert viewer.get_analysis_job("job_stop")["status"] == "stopped"
    assert viewer.get_analysis_job("job_stop")["analysis_id"] is None


def test_analysis_settings_reach_pipeline(tmp_path, monkeypatch):
    monkeypatch.setattr(viewer, "ensure_analysis_models", lambda *args, **kwargs: None)
    received = []
    renamed = []
    monkeypatch.setattr(viewer, "rename_analysis", lambda analysis_id, nickname: renamed.append((analysis_id, nickname)))
    monkeypatch.setattr(
        viewer,
        "_analysis_jobs",
        {
            "job_options": AnalysisJob("job_options", "sample.mp4", "running", 0, "대기 중"),
        },
    )

    def initialize(self, *args):
        received.extend(args)

    def run(self, input_dir, output_root, selected_file, report):
        return tmp_path / "complete"

    monkeypatch.setattr(viewer.IngestionPipeline, "__init__", initialize)
    monkeypatch.setattr(viewer.IngestionPipeline, "run", run)
    options = CreateAnalysisRequest(
        "sample.mp4",
        "large-v3",
        candidate_models=["large-v3-turbo"],
        acoustic_units=True,
        nickname="  summer show  ",
    )
    viewer._run_analysis("job_options", tmp_path / "sample.mp4", options)
    assert received == [
        "large-v3",
        options.backend,
        "GPU",
        ["large-v3-turbo"],
        options.alignment_mode,
        True,
    ]
    assert viewer.get_analysis_job("job_options")["status"] == "complete"
    assert renamed == [("complete", "  summer show  ")]


def test_cancellation_removes_partial_analysis_but_keeps_cache(tmp_path, monkeypatch):
    video = tmp_path / "sample.mp4"
    video.touch()
    cache = tmp_path / "cache.wav"
    cache.write_bytes(b"shared")
    monkeypatch.setattr(pipeline, "KoreanPhonetics", lambda: object())

    def cancel(source_id, path):
        raise AnalysisCancelled()

    monkeypatch.setattr(pipeline, "inspect_media", cancel)
    with pytest.raises(AnalysisCancelled):
        pipeline.IngestionPipeline("large-v3", InferenceBackend.OPENVINO, "GPU").run(
            tmp_path,
            tmp_path / "output",
            video,
        )
    assert list((tmp_path / "output").iterdir()) == []
    assert cache.read_bytes() == b"shared"


def test_quality_defaults_and_unsupported_model(tmp_path, monkeypatch):
    options = build_parser().parse_args(["ingest"])
    assert (
        options.model,
        options.backend,
        options.device,
        options.alignment,
        options.acoustic_units,
    ) == (
        "large-v3",
        InferenceBackend.OPENVINO,
        "GPU",
        "ctc",
        True,
    )
    video = tmp_path / "sample.mp4"
    video.touch()
    monkeypatch.setattr(viewer, "DEFAULT_INPUT_DIR", tmp_path)
    with pytest.raises(HTTPException) as error:
        viewer.start_analysis(CreateAnalysisRequest(filename="sample.mp4", model_name="missing"))
    assert error.value.status_code == 400


def test_http_analysis_settings_and_stop(tmp_path, monkeypatch):
    monkeypatch.setattr(viewer, "ensure_analysis_models", lambda *args, **kwargs: None)
    started = Event()
    proceed = Event()
    video = tmp_path / "sample.mp4"
    video.touch()
    monkeypatch.setattr(viewer, "DEFAULT_INPUT_DIR", tmp_path)
    monkeypatch.setattr(viewer, "_analysis_jobs", {})

    def run(self, input_dir, output_root, selected_file, report):
        started.set()
        assert proceed.wait(3)
        report("음성 전사", 20)
        return tmp_path / "unexpected"

    monkeypatch.setattr(viewer.IngestionPipeline, "run", run)
    client = TestClient(viewer.app)
    response = client.post(
        "/api/analyses",
        json={
            "filename": video.name,
            "model_name": "large-v3",
            "backend": "openvino",
            "device": "GPU",
            "alignment_mode": "ctc",
            "candidate_models": ["large-v3-turbo"],
            "acoustic_units": True,
        },
    )
    assert response.status_code == 200
    assert started.wait(3)
    job_id = response.json()["job_id"]
    assert client.post(f"/api/analysis-jobs/{job_id}/stop").json()["status"] == "stopping"
    proceed.set()
    deadline = monotonic() + 3
    while (
        client.get(f"/api/analysis-jobs/{job_id}").json()["status"] != "stopped"
        and monotonic() < deadline
    ):
        sleep(0.01)
    assert client.get(f"/api/analysis-jobs/{job_id}").json()["status"] == "stopped"


def test_download_progress_is_separate_and_can_be_stopped(tmp_path, monkeypatch):
    downloading = Event()
    proceed = Event()
    monkeypatch.setattr(
        viewer,
        "_analysis_jobs",
        {
            "job_download": AnalysisJob("job_download", "sample.mp4", "running", 0, "대기 중"),
        },
    )

    def download(*args, on_download, checkpoint):
        on_download("large-v3", 42.5)
        downloading.set()
        assert proceed.wait(3)
        checkpoint()

    monkeypatch.setattr(viewer, "ensure_analysis_models", download)
    worker = Thread(target=viewer._run_analysis, args=("job_download", tmp_path / "sample.mp4"))
    worker.start()
    assert downloading.wait(3)
    job = viewer.get_analysis_job("job_download")
    assert (job["download_model"], job["download_percent"], job["percent"]) == (
        "large-v3",
        42.5,
        0,
    )
    viewer.control_analysis_job("job_download", "stop")
    proceed.set()
    worker.join(timeout=3)
    assert not worker.is_alive()
    assert viewer.get_analysis_job("job_download")["status"] == "stopped"
