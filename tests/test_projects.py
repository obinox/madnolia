import json
import sys
import wave
from io import BytesIO

from fastapi.testclient import TestClient

from madnolia import cli, compositions, projects, viewer
from madnolia.exporters import render_wav
from madnolia.pipeline import IngestionPipeline
from madnolia.types.common import (
    CreateProjectRequest,
    MatchStatus,
    SaveCompositionRequest,
    TimelineSegment,
)


def test_multiple_analyses_can_be_selected_and_legacy_compositions_survive(tmp_path, monkeypatch):
    output = tmp_path / "output"
    collections = tmp_path / "projects"
    monkeypatch.setattr(projects, "DEFAULT_OUTPUT_DIR", output)
    monkeypatch.setattr(projects, "DEFAULT_PROJECTS_DIR", collections)
    monkeypatch.setattr(viewer, "DEFAULT_PROJECTS_DIR", collections)
    monkeypatch.setattr(compositions, "DEFAULT_COLLAGES_DIR", tmp_path / "collages")
    for index in (1, 2):
        analysis_id = f"proj_20260924_00000{index}"
        source_id = f"source_{index}"
        root = output / analysis_id
        source = {
            "source_id": source_id,
            "path": str(tmp_path / f"video{index}.mp4"),
            "duration_ms": 1000,
            "audio_sample_rate": 16000,
            "audio_channels": 1,
            "video_width": 1920,
            "video_height": 1080,
            "video_fps": 30,
        }
        projects.write_json(
            root / "project.json",
            {
                "project_id": analysis_id,
                "created_at": "2026-09-24T00:00:00",
                "model_name": "tiny",
                "inference_backend": "faster_whisper",
                "inference_device": "CPU",
                "sources": [source],
                "analysis_files": [f"analysis/{source_id}.json"],
                "audio_files": {source_id: f"../../cache/audio/{source_id}.wav"}
                if index == 1
                else {},
            },
        )
        projects.write_json(
            root / "analysis" / f"{source_id}.json",
            {
                "source": source,
                "transcript": "",
                "language": "ko",
                "language_probability": None,
                "words": [],
                "phones": [],
            },
        )
        audio_path = (
            tmp_path / "cache" / "audio" / f"{source_id}.wav"
            if index == 1
            else root / "audio" / f"{source_id}.wav"
        )
        audio_path.parent.mkdir(parents=True)
        with wave.open(str(audio_path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes((index * 4000).to_bytes(2, "little", signed=True) * 16000)
    old = output / "proj_20260924_000001"
    projects.write_json(
        old / "compositions" / "comp_1234567890abcdef.json",
        {
            "composition_id": "comp_1234567890abcdef",
            "corpus_project_id": old.name,
            "name": "saved",
            "target_text": "가",
            "target_pronunciation": "가",
            "created_at": "2026-09-24T00:00:00",
            "updated_at": "2026-09-24T00:00:00",
            "crossfade_ms": 0,
            "segments": [],
        },
    )
    old_export = old / "exports" / "comp_1234567890abcdef" / "original.wav"
    old_export.parent.mkdir(parents=True)
    old_export.write_bytes(b"original")

    projects.migrate_legacy_projects()
    projects.migrate_legacy_projects()
    assert not (collections / old.name / "compositions").exists()
    assert not (old / "compositions").exists()
    assert (tmp_path / "collages" / "comp_1234567890abcdef" / "collage.json").is_file()
    assert (
        tmp_path / "collages" / "comp_1234567890abcdef" / "exports" / "original.wav"
    ).read_bytes() == b"original"
    assert json.loads((collections / old.name / "project.json").read_text(encoding="utf-8"))[
        "analysis_ids"
    ] == [old.name]

    manifest = projects.create_project(
        CreateProjectRequest(
            name="combined",
            analysis_ids=[old.name, "proj_20260924_000002"],
        )
    )
    directory = projects.project_dir(manifest["project_id"])
    assert len(projects.project_analyses(directory)) == 2
    assert projects.audio_path(directory, "source_1").resolve() == (
        tmp_path / "cache" / "audio" / "source_1.wav"
    )
    assert not (old / "audio").exists()
    assert (
        projects.audio_path(directory, "source_2")
        == output / "proj_20260924_000002" / "audio" / "source_2.wav"
    )
    segments = [
        TimelineSegment(
            segment_id=f"segment_{index}",
            candidate_id=f"candidate_{index}",
            target_start_index=index - 1,
            target_end_index=index,
            source_id=f"source_{index}",
            source_start_ms=0,
            source_end_ms=100,
            timeline_start_ms=(index - 1) * 100,
            timeline_end_ms=index * 100,
            match_status=MatchStatus.EXACT,
            target_ipa=["a"],
            matched_ipa=["a"],
        )
        for index in (1, 2)
    ]
    request = SaveCompositionRequest(
        name="combined",
        target_text="aa",
        target_pronunciation="aa",
        crossfade_ms=0,
        segments=segments,
    )
    with wave.open(BytesIO(render_wav(directory, request)), "rb") as audio:
        assert audio.getnframes() == 3200
        frames = audio.readframes(3200)
        assert frames[:2] != frames[3200:3202]
    client = TestClient(viewer.app)
    response = client.get(f"/api/projects/{manifest['project_id']}")
    assert response.status_code == 200
    assert len(response.json()["analyses"]) == 2
    assert any(item["name"] == "combined" for item in client.get("/api/projects").json())


def test_cli_ingests_input_videos_individually(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "ensure_analysis_models", lambda *args, **kwargs: None)
    for filename in ("first.mp4", "second.mp4"):
        (tmp_path / filename).touch()
    selected = []

    def capture(self, input_dir, output_root, selected_file):
        selected.append(selected_file.name)
        return output_root / selected_file.stem

    monkeypatch.setattr(IngestionPipeline, "run", capture)
    monkeypatch.setattr(sys, "argv", ["madnolia", "ingest", "--input", str(tmp_path)])
    cli.main()
    assert selected == ["first.mp4", "second.mp4"]


def test_existing_analysis_reads_shared_cache_without_output_audio(tmp_path, monkeypatch):
    analysis_id = "proj_20260924_222222"
    source_id = "source_0_test"
    root = tmp_path / "output" / analysis_id
    original = root / "audio" / f"{source_id}.wav"
    original.parent.mkdir(parents=True)
    original.write_bytes(b"same audio")
    cache = tmp_path / "cache" / "audio" / "cached.wav"
    cache.parent.mkdir(parents=True)
    cache.write_bytes(b"same audio")
    projects.write_json(
        root / "project.json",
        {
            "project_id": analysis_id,
            "created_at": "2026-09-24T22:22:22",
            "model_name": "small",
            "inference_backend": "faster_whisper",
            "inference_device": "CPU",
            "sources": [{"source_id": source_id, "path": "video.mp4", "duration_ms": 1000}],
            "analysis_files": [f"analysis/{source_id}.json"],
        },
    )
    monkeypatch.setattr(projects, "DEFAULT_OUTPUT_DIR", tmp_path / "output")
    monkeypatch.setattr(projects, "DEFAULT_PROJECTS_DIR", tmp_path / "projects")
    monkeypatch.setattr(projects, "AUDIO_CACHE_DIR", cache.parent)

    projects.migrate_legacy_projects()
    projects.migrate_legacy_projects()

    manifest = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert manifest["audio_files"][source_id] == "../../cache/audio/cached.wav"
    assert not original.exists()
    assert projects.audio_path(tmp_path / "projects" / analysis_id, source_id).resolve() == cache
