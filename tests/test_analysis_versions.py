import json
import sqlite3
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from madnolia import pipeline, projects, storage
from madnolia.pipeline import IngestionPipeline, finalize_project, realign_project
from madnolia.types.common import (
    AlignmentMethod,
    AlignmentMode,
    AlignmentStatus,
    AnalysisResult,
    InferenceBackend,
    MediaSource,
    PhoneOccurrence,
    TranscriptionResult,
    TranscriptSentence,
    TranscriptWord,
)


def _result(source_id: str = "source_0_test", ipa: str = "a") -> AnalysisResult:
    source = MediaSource(
        source_id=source_id,
        path="sample.mp4",
        duration_ms=1000,
        audio_sample_rate=16000,
        audio_channels=1,
        video_width=640,
        video_height=480,
        video_fps=30.0,
    )
    word = TranscriptWord(text="가", start_ms=0, end_ms=500, confidence=0.9)
    sentence = TranscriptSentence(
        sentence_index=0,
        text="가",
        start_ms=0,
        end_ms=500,
        word_start_index=0,
        word_end_index=1,
    )
    phone = PhoneOccurrence(
        occurrence_id=f"{source_id}_phone",
        source_id=source_id,
        sentence_index=0,
        word_index=0,
        grapheme="가",
        pronunciation="가",
        phone_id=f"ko.vowel.{ipa}",
        ipa=ipa,
        start_ms=0,
        end_ms=500,
        confidence=0.9,
        alignment_method=AlignmentMethod.ESTIMATED_WORD,
        alignment_status=AlignmentStatus.ESTIMATED,
    )
    return AnalysisResult(
        source=source,
        transcript="가",
        language="ko",
        language_probability=0.99,
        audio_regions=[],
        sentences=[sentence],
        words=[word],
        phones=[phone],
        acoustic_features=[],
        transcript_candidates=[],
    )


def _manifest(result: AnalysisResult, analysis_files: list[str], database_file: str) -> dict:
    return {
        "project_id": "proj_20260927_120000_abcd1234",
        "schema_version": "1",
        "created_at": "2026-09-27T12:00:00+09:00",
        "model_name": "test-model",
        "inference_backend": InferenceBackend.FASTER_WHISPER.value,
        "inference_device": "GPU",
        "alignment_mode": AlignmentMode.ESTIMATED.value,
        "language": "ko",
        "sources": [asdict(result.source)],
        "analysis_files": analysis_files,
        "database_file": database_file,
        "candidate_models": [],
        "acoustic_unit_centroids_file": None,
        "nickname": "preserve me",
        "custom_field": {"preserve": True},
        "audio_files": {result.source.source_id: "../../cache/audio/sample.wav"},
    }


def _seed_legacy_project(project_dir: Path, *, manifest: bool = True) -> AnalysisResult:
    result = _result()
    analysis_path = project_dir / "analysis" / f"{result.source.source_id}.json"
    storage.write_json(analysis_path, result.to_dict())
    connection = storage.initialize_database(project_dir / "corpus.sqlite3")
    try:
        storage.save_analysis(connection, result)
    finally:
        connection.close()
    if manifest:
        storage.write_json(
            project_dir / "project.json",
            _manifest(result, [analysis_path.relative_to(project_dir).as_posix()], "corpus.sqlite3"),
        )
    return result


def _active_bytes(project_dir: Path) -> dict[str, bytes]:
    manifest_path = project_dir / "project.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    references = [*manifest["analysis_files"], manifest["database_file"]]
    if manifest.get("acoustic_unit_centroids_file"):
        references.append(manifest["acoustic_unit_centroids_file"])
    return {path: (project_dir / path).read_bytes() for path in ["project.json", *references]}


def _assert_version_consistent(project_dir: Path) -> dict:
    manifest = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    analysis_version_dir = Path(manifest["analysis_files"][0]).parents[1]
    database_version_dir = Path(manifest["database_file"]).parent
    assert analysis_version_dir == database_version_dir
    analysis = json.loads((project_dir / manifest["analysis_files"][0]).read_text(encoding="utf-8"))
    database = sqlite3.connect(project_dir / manifest["database_file"])
    try:
        row = database.execute(
            "SELECT ipa, COUNT(*) FROM phone_occurrences WHERE source_id = ? GROUP BY ipa",
            (analysis["source"]["source_id"],),
        ).fetchone()
    finally:
        database.close()
    assert row == (analysis["phones"][0]["ipa"], len(analysis["phones"]))
    return manifest


def _mock_realign(monkeypatch, *, ipa: str):
    monkeypatch.setattr(pipeline, "KoreanPhonetics", lambda: object())
    monkeypatch.setattr(pipeline, "analysis_audio_path", lambda *args: Path("audio.wav"))
    monkeypatch.setattr(pipeline, "PhonemeCtcAligner", lambda **kwargs: object())
    monkeypatch.setattr(
        pipeline,
        "align_phone_occurrences",
        lambda source_id, *args: [_result(source_id, ipa).phones[0]],
    )
    monkeypatch.setattr(pipeline, "analyze_phone_acoustics", lambda *args: [])


def test_ingestion_publishes_json_and_sqlite_as_one_version(tmp_path, monkeypatch):
    video = tmp_path / "input" / "sample.mp4"
    video.parent.mkdir()
    video.touch()
    audio = tmp_path / "cached.wav"
    audio.touch()
    result = _result()
    monkeypatch.setattr(pipeline, "KoreanPhonetics", lambda: object())
    monkeypatch.setattr(pipeline, "inspect_media", lambda source_id, path: replace(result.source, source_id=source_id))
    monkeypatch.setattr(pipeline, "get_cached_audio", lambda *args: audio)
    monkeypatch.setattr(pipeline, "segment_sentences", lambda words: result.sentences)
    monkeypatch.setattr(
        pipeline,
        "estimate_phone_occurrences",
        lambda source_id, *args: [_result(source_id).phones[0]],
    )
    monkeypatch.setattr(pipeline, "analyze_phone_acoustics", lambda *args, **kwargs: [])
    transcriber = SimpleNamespace(
        transcribe=lambda *args, **kwargs: TranscriptionResult(
            transcript="가",
            language_probability=0.99,
            audio_regions=[],
            words=result.words,
        )
    )
    monkeypatch.setattr(IngestionPipeline, "_create_transcriber", lambda *args: transcriber)

    project_dir = IngestionPipeline(
        "test-model", InferenceBackend.FASTER_WHISPER, "CPU", discover_acoustic_units=False
    ).run(video.parent, tmp_path / "output", video)

    manifest = _assert_version_consistent(project_dir)
    assert manifest["analysis_files"][0].startswith("versions/")
    assert manifest["database_file"].startswith("versions/")
    assert (project_dir / "analysis").exists() is False


def test_realign_reads_and_republishes_legacy_project(tmp_path, monkeypatch):
    project_dir = tmp_path / "legacy"
    original = _seed_legacy_project(project_dir)
    _mock_realign(monkeypatch, ipa="i")

    realign_project(project_dir, "CPU", discover_acoustic_units=False)

    manifest = _assert_version_consistent(project_dir)
    updated = json.loads((project_dir / manifest["analysis_files"][0]).read_text(encoding="utf-8"))
    assert updated["phones"][0]["ipa"] == "i"
    assert updated["transcript"] == original.transcript
    assert manifest["inference_device"] == "GPU"
    assert manifest["nickname"] == "preserve me"
    assert manifest["custom_field"] == {"preserve": True}
    assert manifest["audio_files"] == {original.source.source_id: "../../cache/audio/sample.wav"}
    assert (project_dir / "analysis" / f"{original.source.source_id}.json").is_file()


def test_repeated_realign_uses_current_version_and_keeps_old_versions(tmp_path, monkeypatch):
    project_dir = tmp_path / "versioned"
    result = _seed_legacy_project(project_dir)
    _mock_realign(monkeypatch, ipa="i")
    realign_project(project_dir, "CPU", discover_acoustic_units=False)
    first_manifest = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    first_references = [*first_manifest["analysis_files"], first_manifest["database_file"]]
    first_snapshot = {name: (project_dir / name).read_bytes() for name in first_references}

    legacy = result.to_dict()
    legacy["transcript"] = "legacy stale data"
    legacy["phones"][0]["ipa"] = "x"
    storage.write_json(project_dir / "analysis" / f"{result.source.source_id}.json", legacy)
    _mock_realign(monkeypatch, ipa="u")
    realign_project(project_dir, "CPU", discover_acoustic_units=False)

    second_manifest = _assert_version_consistent(project_dir)
    second = json.loads((project_dir / second_manifest["analysis_files"][0]).read_text(encoding="utf-8"))
    assert second["transcript"] == result.transcript
    assert second["phones"][0]["ipa"] == "u"
    assert all((project_dir / name).read_bytes() == data for name, data in first_snapshot.items())
    assert first_manifest["analysis_files"][0] != second_manifest["analysis_files"][0]


@pytest.mark.parametrize(
    "failure", ["analysis_json", "database", "manifest", "manifest_replace"]
)
def test_realign_failure_keeps_active_manifest_and_files_unchanged(tmp_path, monkeypatch, failure):
    project_dir = tmp_path / "failure"
    _seed_legacy_project(project_dir)
    _mock_realign(monkeypatch, ipa="i")
    realign_project(project_dir, "CPU", discover_acoustic_units=False)
    original = _active_bytes(project_dir)
    _mock_realign(monkeypatch, ipa="u")

    if failure == "analysis_json":
        original_write = storage.write_json

        def fail_analysis_json(path, data):
            if path.parent.name == "analysis" and path.name.endswith(".json"):
                raise OSError("analysis write failed")
            return original_write(path, data)

        monkeypatch.setattr(storage, "write_json", fail_analysis_json)
    elif failure == "database":
        monkeypatch.setattr(storage, "save_analysis", lambda *args: (_ for _ in ()).throw(OSError("db write failed")))
    elif failure == "manifest":
        original_write = storage.write_json

        def fail_manifest(path, data):
            if path == project_dir / "project.json":
                raise OSError("manifest publish failed")
            return original_write(path, data)

        monkeypatch.setattr(storage, "write_json", fail_manifest)
    else:
        original_replace = storage.os.replace

        def fail_manifest_replace(source, destination):
            if Path(destination) == project_dir / "project.json":
                raise OSError("manifest replace failed")
            return original_replace(source, destination)

        monkeypatch.setattr(storage.os, "replace", fail_manifest_replace)

    with pytest.raises(OSError):
        realign_project(project_dir, "CPU", discover_acoustic_units=False)

    assert _active_bytes(project_dir) == original


def test_realign_does_not_fall_back_when_active_json_is_missing(tmp_path, monkeypatch):
    project_dir = tmp_path / "missing_active"
    _seed_legacy_project(project_dir)
    manifest = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    next_result = _result(ipa="i")
    storage.publish_analysis_version(project_dir, [next_result], manifest)
    current = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    (project_dir / current["analysis_files"][0]).unlink()
    _mock_realign(monkeypatch, ipa="u")

    with pytest.raises(FileNotFoundError):
        realign_project(project_dir, "CPU", discover_acoustic_units=False)


def test_finalize_publishes_legacy_directory_without_manifest(tmp_path):
    project_dir = tmp_path / "no_manifest"
    _seed_legacy_project(project_dir, manifest=False)

    finalize_project(
        project_dir,
        "test-model",
        InferenceBackend.FASTER_WHISPER,
        "CPU",
        AlignmentMode.ESTIMATED,
    )

    manifest = _assert_version_consistent(project_dir)
    assert manifest["analysis_files"][0].startswith("versions/")


def test_finalize_reads_current_version_and_retains_previous_files(tmp_path):
    project_dir = tmp_path / "finalize"
    result = _seed_legacy_project(project_dir)
    previous_manifest = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    centroids = np.array([[0.2, 0.4], [0.6, 0.8]], dtype=np.float32)
    storage.publish_analysis_version(project_dir, [result], previous_manifest, centroids)
    finalize_project(
        project_dir,
        "test-model",
        InferenceBackend.FASTER_WHISPER,
        "CPU",
    )
    previous = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    previous_paths = [*previous["analysis_files"], previous["database_file"]]
    previous_snapshot = {path: (project_dir / path).read_bytes() for path in previous_paths}
    legacy = result.to_dict()
    legacy["transcript"] = "wrong source"
    storage.write_json(project_dir / "analysis" / f"{result.source.source_id}.json", legacy)

    finalize_project(
        project_dir,
        "test-model",
        InferenceBackend.FASTER_WHISPER,
        "CPU",
    )

    current = _assert_version_consistent(project_dir)
    active = json.loads((project_dir / current["analysis_files"][0]).read_text(encoding="utf-8"))
    assert active["transcript"] == result.transcript
    assert np.array_equal(np.load(project_dir / current["acoustic_unit_centroids_file"]), centroids)
    assert all((project_dir / path).read_bytes() == data for path, data in previous_snapshot.items())


def test_centroid_write_failure_preserves_published_version(tmp_path, monkeypatch):
    project_dir = tmp_path / "centroid_failure"
    result = _result()
    storage.publish_analysis_version(project_dir, [result], _manifest(result, [], ""))
    original = _active_bytes(project_dir)
    manifest = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    next_result = _result(ipa="i")

    def fail_save(*args, **kwargs):
        raise OSError("centroid write failed")

    monkeypatch.setattr(storage.np, "save", fail_save)
    with pytest.raises(OSError, match="centroid write failed"):
        storage.publish_analysis_version(project_dir, [next_result], manifest, np.zeros((2, 3)))

    assert _active_bytes(project_dir) == original


def test_failed_first_publish_leaves_manifest_absent(tmp_path, monkeypatch):
    project_dir = tmp_path / "first_publish_failure"
    result = _result()

    def fail_save(*args, **kwargs):
        raise OSError("database write failed")

    monkeypatch.setattr(storage, "save_analysis", fail_save)
    with pytest.raises(OSError, match="database write failed"):
        storage.publish_analysis_version(project_dir, [result], _manifest(result, [], ""))

    assert not (project_dir / "project.json").exists()


def test_project_reader_follows_active_version_and_keeps_audio_cache(tmp_path, monkeypatch):
    analysis_id = "proj_20260927_120000_abcd1234"
    project_dir = tmp_path / "analyses" / analysis_id
    result = _seed_legacy_project(project_dir)
    cache = tmp_path / "cache" / "audio" / "sample.wav"
    cache.parent.mkdir(parents=True)
    cache.write_bytes(b"shared audio")
    monkeypatch.setattr(projects, "DEFAULT_OUTPUT_DIR", project_dir.parent)
    monkeypatch.setattr(projects, "DEFAULT_PROJECTS_DIR", tmp_path / "collections")
    projects.write_json(
        tmp_path / "collections" / "collection_test" / "project.json",
        {
            "project_id": "collection_test",
            "analysis_ids": [analysis_id],
            "sources": [asdict(result.source)],
        },
    )
    current = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    next_result = _result(ipa="i")
    storage.publish_analysis_version(project_dir, [next_result], current)

    analyses = projects.project_analyses(tmp_path / "collections" / "collection_test")

    assert analyses[0].phones[0].ipa == "i"
    assert projects.analysis_audio_path(project_dir, result.source.source_id).resolve() == cache.resolve()
    assert cache.read_bytes() == b"shared audio"
