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
