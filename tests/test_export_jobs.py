from dataclasses import replace
from types import SimpleNamespace

import numpy as np
from fastapi.testclient import TestClient

from madnolia import viewer
from madnolia.exporters import _compose_audio
from madnolia.types.common import (
    CompositionMode,
    CompositionProject,
    MatchStatus,
    TimelineSegment,
)


def _segment(segment_id: str, start: int) -> TimelineSegment:
    return TimelineSegment(
        segment_id=segment_id,
        candidate_id="candidate",
        target_start_index=0,
        target_end_index=1,
        source_id="source",
        source_start_ms=0,
        source_end_ms=100,
        timeline_start_ms=start,
        timeline_end_ms=start + 100,
        match_status=MatchStatus.EXACT,
        target_ipa=["a"],
        matched_ipa=["a"],
    )


def _composition() -> CompositionProject:
    return CompositionProject(
        composition_id="comp_0123456789abcdef",
        corpus_project_id="project",
        name="test",
        target_text="a",
        target_pronunciation="a",
        created_at="now",
        updated_at="now",
        crossfade_ms=0,
        segments=[_segment("one", 0), _segment("two", 100)],
    )


def _setup_jobs(monkeypatch, tmp_path, thread_start=None) -> None:
    comp = _composition()
    output_dir = tmp_path / "collages" / comp.composition_id
    monkeypatch.setattr(viewer, "_export_jobs", {})
    monkeypatch.setattr(viewer, "_export_threads", {})
    monkeypatch.setattr(viewer, "_project_dir", lambda _project_id: tmp_path)
    monkeypatch.setattr(viewer, "get_collage", lambda _composition_id: {"corpus_project_id": "project"})
    monkeypatch.setattr(viewer, "get_composition", lambda _directory, _composition_id: comp)
    monkeypatch.setattr(viewer, "collage_dir", lambda _composition_id: output_dir)
    if thread_start is not None:
        monkeypatch.setattr(viewer, "Thread", lambda **kwargs: SimpleNamespace(start=lambda: thread_start(kwargs), is_alive=lambda: False))


def test_export_job_reports_progress_and_downloads_finalized_file(tmp_path, monkeypatch) -> None:
    _setup_jobs(monkeypatch, tmp_path, lambda args: args["target"](*args["args"]))

    def export(_project_dir, composition, target, progress_callback=None):
        progress_callback("rendering", 36)
        progress_callback("writing", 84)
        path = viewer.collage_dir(composition.composition_id) / "exports" / f"{composition.composition_id}.{target.value.lower()}"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"finalized")
        return path

    monkeypatch.setattr(viewer, "export_composition", export)
    client = TestClient(viewer.app)
    started = client.post("/api/collages/comp_0123456789abcdef/export-jobs/WAV")
    job_id = started.json()["job_id"]
    status_response = client.get(f"/api/export-jobs/{job_id}")
    status = status_response.json()

    assert started.status_code == 200
    assert status_response.status_code == 200
    assert status == {
        "job_id": job_id,
        "composition_id": "comp_0123456789abcdef",
        "target": "WAV",
        "status": "complete",
        "percent": 100,
        "stage": "내보내기 완료",
        "filename": "comp_0123456789abcdef.wav",
        "error": None,
    }
    download = client.get(f"/api/export-jobs/{job_id}/download")
    assert download.content == b"finalized"
    assert download.headers["content-disposition"].endswith('filename="comp_0123456789abcdef.wav"')
    assert client.get("/api/export-jobs/missing").status_code == 404


def test_export_job_keeps_progress_on_failure_and_rejects_download(tmp_path, monkeypatch) -> None:
    _setup_jobs(monkeypatch, tmp_path, lambda args: args["target"](*args["args"]))

    def fail_export(_project_dir, _composition, _target, progress_callback=None):
        progress_callback("rendering", 43)
        raise OSError("encoder failed")

    monkeypatch.setattr(viewer, "export_composition", fail_export)
    client = TestClient(viewer.app)
    job_id = client.post("/api/collages/comp_0123456789abcdef/export-jobs/MP4").json()["job_id"]
    status = client.get(f"/api/export-jobs/{job_id}").json()

    assert status["status"] == "failed"
    assert status["percent"] == 43
    assert status["error"] == "encoder failed"
    assert client.get(f"/api/export-jobs/{job_id}/download").status_code == 400


def test_export_job_download_waits_for_completion(tmp_path, monkeypatch) -> None:
    _setup_jobs(monkeypatch, tmp_path, lambda _args: None)
    client = TestClient(viewer.app)
    job_id = client.post("/api/collages/comp_0123456789abcdef/export-jobs/EDL").json()["job_id"]

    assert client.get(f"/api/export-jobs/{job_id}/download").status_code == 409


def test_audio_export_progress_tracks_written_segments(tmp_path, monkeypatch) -> None:
    composition = replace(_composition(), mode=CompositionMode.SIMPLE)
    monkeypatch.setattr(
        "madnolia.exporters._render_segment_audio",
        lambda _directory, _mode, _segment, expected, *_args: np.ones(expected, dtype=np.float32),
    )
    progress = []

    rendered = _compose_audio(tmp_path, composition, lambda stage, percent: progress.append((stage, percent)))

    assert len(rendered) == 3200
    assert [percent for _stage, percent in progress] == [50, 100]
