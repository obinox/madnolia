from threading import Event
from time import sleep

from fastapi.testclient import TestClient

from madnolia import viewer
from madnolia.types.common import CandidateSearchResult, InputLanguage
from madnolia.viewer import app


def test_alignment_experiment_endpoints_are_removed() -> None:
    client = TestClient(app)

    for path in (
        "/api/alignment-test",
        "/api/alignment-test/audio",
        "/api/alignment-test/waveform?start_ms=0&end_ms=1000",
    ):
        assert client.get(path).status_code == 404


def test_analysis_api_remains_available() -> None:
    paths = {route.path for route in app.routes}

    assert "/api/analyses" in paths
    assert "/api/alignment-test" not in paths


def test_project_audio_endpoint_serves_cached_wav(monkeypatch, tmp_path) -> None:
    audio = tmp_path / "source.wav"
    audio.write_bytes(b"RIFF cached audio")
    monkeypatch.setattr(viewer, "_project_dir", lambda project_id: tmp_path)
    monkeypatch.setattr(viewer, "audio_path", lambda directory, source_id: audio)

    response = TestClient(app).get("/api/projects/project/audio/source")

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.content == b"RIFF cached audio"


def test_search_job_can_be_cancelled(monkeypatch, tmp_path) -> None:
    release = Event()
    loader_entered = Event()
    monkeypatch.setattr(viewer, "_search_jobs", {})
    monkeypatch.setattr(viewer, "_search_threads", {})

    def load_analyses(directory):
        loader_entered.set()
        release.wait(2)
        return []

    monkeypatch.setattr(viewer, "_project_dir", lambda project_id: tmp_path)
    monkeypatch.setattr(viewer, "_project_analyses", load_analyses)

    client = TestClient(app)
    started = client.post(
        "/api/projects/test-project/search-jobs",
        json={"text": "hello", "input_language": "EN"},
    )
    assert started.status_code == 200
    assert loader_entered.wait(2)
    duplicate = client.post(
        "/api/projects/test-project/search-jobs",
        json={"text": "hello", "input_language": "EN"},
    )
    assert duplicate.status_code == 409
    job_id = started.json()["job_id"]
    try:
        cancelled = client.delete(f"/api/search-jobs/{job_id}")
        assert cancelled.json()["status"] == "cancelling"
        assert client.post(
            "/api/projects/test-project/search-jobs",
            json={"text": "hello", "input_language": "EN"},
        ).status_code == 409
        release.set()
        for _ in range(40):
            status = client.get(f"/api/search-jobs/{job_id}").json()
            if status["status"] == "cancelled":
                break
            sleep(0.01)
        assert status["status"] == "cancelled"
        assert client.delete(f"/api/search-jobs/{job_id}").json()["status"] == "cancelled"
        duplicate = None
        for _ in range(40):
            duplicate = client.post(
                "/api/projects/test-project/search-jobs",
                json={"text": "hello", "input_language": "EN"},
            )
            if duplicate.status_code == 200:
                break
            sleep(0.01)
        assert duplicate is not None
        assert duplicate.status_code == 200
    finally:
        release.set()
        for worker in viewer._search_threads.values():
            worker.join(2)


def test_search_snapshot_and_duplicate_guard_wait_for_live_worker(monkeypatch, tmp_path) -> None:
    log_entered = Event()
    release_log = Event()
    monkeypatch.setattr(viewer, "_search_jobs", {})
    monkeypatch.setattr(viewer, "_search_threads", {})
    monkeypatch.setattr(viewer, "_project_dir", lambda _project_id: tmp_path)
    monkeypatch.setattr(viewer, "_project_analyses", lambda _directory: [])
    monkeypatch.setattr(viewer, "project_source_labels", lambda _directory: {})
    monkeypatch.setattr(viewer, "search_candidates", lambda *args, **kwargs: CandidateSearchResult("hello", "həloʊ", InputLanguage.EN, [], []))
    original_log = viewer._log

    def block_completion_log(category, message, *args):
        if category == "SEARCH" and message.startswith("Completed"):
            log_entered.set()
            release_log.wait(2)
        else:
            original_log(category, message, *args)

    monkeypatch.setattr(viewer, "_log", block_completion_log)
    client = TestClient(viewer.app)
    started = client.post("/api/projects/test-project/search-jobs", json={"text": "hello", "input_language": "EN"})
    assert started.status_code == 200
    job_id = started.json()["job_id"]
    try:
        assert log_entered.wait(2)
        assert viewer._search_jobs[job_id].status.value == "complete"
        assert client.get(f"/api/search-jobs/{job_id}").json()["status"] == "running"
        assert client.delete(f"/api/search-jobs/{job_id}").json()["status"] == "running"
        duplicate = client.post("/api/projects/test-project/search-jobs", json={"text": "hello", "input_language": "EN"})
        assert duplicate.status_code == 409
    finally:
        release_log.set()
        for worker in viewer._search_threads.values():
            worker.join(2)
    assert client.get(f"/api/search-jobs/{job_id}").json()["status"] == "complete"


def test_search_cancellation_wins_over_loader_value_error(monkeypatch, tmp_path) -> None:
    release = Event()
    loader_entered = Event()
    monkeypatch.setattr(viewer, "_search_jobs", {})
    monkeypatch.setattr(viewer, "_search_threads", {})

    def fail_after_cancel(_directory):
        loader_entered.set()
        release.wait(2)
        raise ValueError("isolated loader failure")

    monkeypatch.setattr(viewer, "_project_dir", lambda _project_id: tmp_path)
    monkeypatch.setattr(viewer, "_project_analyses", fail_after_cancel)
    client = TestClient(viewer.app)
    started = client.post("/api/projects/test-project/search-jobs", json={"text": "hello", "input_language": "EN"})
    assert started.status_code == 200
    job_id = started.json()["job_id"]
    try:
        assert loader_entered.wait(2)
        assert client.delete(f"/api/search-jobs/{job_id}").json()["status"] == "cancelling"
        assert client.get(f"/api/search-jobs/{job_id}").json()["status"] == "cancelling"
        assert client.post("/api/projects/test-project/search-jobs", json={"text": "hello", "input_language": "EN"}).status_code == 409
        release.set()
        worker = viewer._search_threads[job_id]
        worker.join(2)
        assert not worker.is_alive()
        assert client.get(f"/api/search-jobs/{job_id}").json()["status"] == "cancelled"
    finally:
        release.set()
        for worker in viewer._search_threads.values():
            worker.join(2)
