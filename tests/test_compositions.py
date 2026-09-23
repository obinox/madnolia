import json
import wave
from dataclasses import asdict, replace

import numpy as np
from fastapi.testclient import TestClient

from madnolia import viewer
from madnolia.compositions import create_composition, get_composition, update_composition
from madnolia.exporters import export_composition, render_wav
from madnolia.types.common import (
    ExportTarget,
    MatchStatus,
    SaveCompositionRequest,
    TimelineSegment,
)


def test_composition_round_trip_and_wav_export(tmp_path) -> None:
    project_dir = tmp_path / "proj"
    audio_dir = project_dir / "audio"
    audio_dir.mkdir(parents=True)
    (project_dir / "project.json").write_text(
        json.dumps(
            {
                "sources": [
                    {
                        "source_id": "source",
                        "path": "video.mp4",
                        "duration_ms": 1000,
                        "audio_sample_rate": 16000,
                        "audio_channels": 1,
                        "video_width": 1920,
                        "video_height": 1080,
                        "video_fps": 30,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    with wave.open(str(audio_dir / "source.wav"), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        samples = (np.sin(np.arange(16000) / 20) * 8000).astype(np.int16)
        audio.writeframes(samples.tobytes())
    request = SaveCompositionRequest(
        name="test",
        target_text="가",
        target_pronunciation="가",
        crossfade_ms=8,
        segments=[_segment()],
    )
    composition = create_composition(project_dir, "proj", request)
    assert get_composition(project_dir, composition.composition_id) == composition
    updated = update_composition(
        project_dir,
        composition.composition_id,
        replace(request, name="updated"),
    )
    assert updated.name == "updated"
    wav_path = export_composition(project_dir, updated, ExportTarget.WAV)
    with wave.open(str(wav_path), "rb") as audio:
        assert audio.getnframes() == 1600
        assert audio.getframerate() == 16000
    stretched = update_composition(
        project_dir, composition.composition_id,
        replace(request, segments=[replace(
            _segment(), stretch_percent=150, timeline_end_ms=150,
        )]),
    )
    assert get_composition(project_dir, composition.composition_id) == stretched
    with wave.open(str(export_composition(project_dir, stretched, ExportTarget.WAV)), "rb") as audio:
        stretched_samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype=np.int16)
        assert audio.getnframes() == 2400
    frequency = np.argmax(np.abs(np.fft.rfft(stretched_samples))) * 16000 / len(stretched_samples)
    assert abs(frequency - 16000 / (40 * np.pi)) < 20


def _segment() -> TimelineSegment:
    return TimelineSegment(
        segment_id="segment_0",
        candidate_id="candidate",
        target_start_index=0,
        target_end_index=1,
        source_id="source",
        source_start_ms=100,
        source_end_ms=200,
        timeline_start_ms=0,
        timeline_end_ms=100,
        match_status=MatchStatus.EXACT,
        target_ipa=["k"],
        matched_ipa=["k"],
    )


def test_preview_matches_export_with_individual_gaps(tmp_path, monkeypatch) -> None:
    project_dir = tmp_path / "proj"
    audio_dir = project_dir / "audio"
    audio_dir.mkdir(parents=True)
    (project_dir / "project.json").write_text(
        json.dumps({"sources": [{
            "source_id": "source", "path": "video.mp4", "duration_ms": 1000,
            "audio_sample_rate": 16000, "audio_channels": 1,
            "video_width": 1920, "video_height": 1080, "video_fps": 30,
        }]}),
        encoding="utf-8",
    )
    with wave.open(str(audio_dir / "source.wav"), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(np.full(16000, 8000, dtype=np.int16).tobytes())
    segments = [
        replace(_segment(), timeline_end_ms=125, stretch_percent=125),
        replace(
            _segment(), segment_id="segment_1", timeline_start_ms=200,
            timeline_end_ms=300, gap_before_ms=75,
        ),
        replace(
            _segment(), segment_id="segment_2", timeline_start_ms=325,
            timeline_end_ms=425, gap_before_ms=25,
        ),
    ]
    request = SaveCompositionRequest(
        name="test", target_text="abc", target_pronunciation="abc",
        crossfade_ms=8, segments=segments,
    )
    monkeypatch.setattr(viewer, "DEFAULT_OUTPUT_DIR", tmp_path)
    response = TestClient(viewer.app).post(
        "/api/projects/proj/compositions/preview", json=asdict(request),
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    composition = create_composition(project_dir, "proj", request)
    preview = response.content
    assert preview == render_wav(project_dir, request)
    wav_path = export_composition(project_dir, composition, ExportTarget.WAV)
    assert preview == wav_path.read_bytes()
    with wave.open(str(wav_path), "rb") as audio:
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype=np.int16)
        assert audio.getnframes() == 425 * 16
        assert not np.any(samples[125 * 16:200 * 16])
        assert not np.any(samples[300 * 16:325 * 16])
    assert get_composition(project_dir, composition.composition_id).segments == segments
    saved_path = project_dir / "compositions" / f"{composition.composition_id}.json"
    saved = json.loads(saved_path.read_text(encoding="utf-8"))
    for segment in saved["segments"]:
        segment.pop("gap_before_ms")
        if segment["stretch_percent"] == 100:
            segment.pop("stretch_percent")
    saved_path.write_text(json.dumps(saved), encoding="utf-8")
    assert get_composition(project_dir, composition.composition_id).segments == segments
