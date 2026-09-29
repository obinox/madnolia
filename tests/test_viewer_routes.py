from threading import Event
from time import sleep

from fastapi.testclient import TestClient

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


def test_search_job_can_be_cancelled(monkeypatch, tmp_path) -> None:
    from madnolia import viewer

    release = Event()

    def load_analyses(directory):
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
    job_id = started.json()["job_id"]
    try:
        cancelled = client.delete(f"/api/search-jobs/{job_id}")
        assert cancelled.json()["status"] == "cancelled"
        release.set()
        for _ in range(40):
            status = client.get(f"/api/search-jobs/{job_id}").json()
            if status["status"] == "cancelled":
                break
            sleep(0.01)
        assert status["status"] == "cancelled"
    finally:
        release.set()
