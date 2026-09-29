import json
import wave
from dataclasses import asdict, replace
from fractions import Fraction
from io import BytesIO

import numpy as np
import pytest
from fastapi.testclient import TestClient

from madnolia import compositions, viewer
from madnolia.compositions import create_composition, get_composition, update_composition
from madnolia.exporters import _video_overlap_alpha, export_composition, render_wav
from madnolia.types.common import (
    CompositionMode,
    ExportTarget,
    MatchStatus,
    PhoneAlignmentOperation,
    PhoneUnit,
    SaveCompositionRequest,
    TimelineSegment,
)


def test_composition_round_trip_and_wav_export(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(compositions, "DEFAULT_COLLAGES_DIR", tmp_path / "collages")
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
    with pytest.raises(FileNotFoundError):
        get_composition(tmp_path / "another-project", composition.composition_id)
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
        project_dir,
        composition.composition_id,
        replace(
            request,
            segments=[
                replace(
                    _segment(),
                    stretch_percent=150,
                    timeline_end_ms=150,
                )
            ],
        ),
    )
    assert get_composition(project_dir, composition.composition_id) == stretched
    with wave.open(
        str(export_composition(project_dir, stretched, ExportTarget.WAV)), "rb"
    ) as audio:
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
    monkeypatch.setattr(compositions, "DEFAULT_COLLAGES_DIR", tmp_path / "collages")
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
        audio.writeframes(np.full(16000, 8000, dtype=np.int16).tobytes())
    segments = [
        replace(_segment(), timeline_end_ms=125, stretch_percent=125),
        replace(
            _segment(),
            segment_id="segment_1",
            timeline_start_ms=200,
            timeline_end_ms=300,
            gap_before_ms=75,
        ),
        replace(
            _segment(),
            segment_id="segment_2",
            timeline_start_ms=325,
            timeline_end_ms=425,
            gap_before_ms=25,
        ),
    ]
    request = SaveCompositionRequest(
        name="test",
        target_text="abc",
        target_pronunciation="abc",
        crossfade_ms=8,
        segments=segments,
    )
    monkeypatch.setattr(viewer, "DEFAULT_OUTPUT_DIR", tmp_path)
    response = TestClient(viewer.app).post(
        "/api/projects/proj/compositions/preview",
        json=asdict(request),
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    client = TestClient(viewer.app)
    created = client.post(
        "/api/collages",
        json={"project_id": "proj", "composition": asdict(request)},
    )
    assert created.status_code == 200
    collage_id = created.json()["composition_id"]
    assert client.get(f"/api/collages/{collage_id}").json()["corpus_project_id"] == "proj"
    assert client.put(f"/api/collages/{collage_id}", json=asdict(request)).status_code == 200
    assert client.post(f"/api/collages/{collage_id}/export/WAV").status_code == 200
    composition = create_composition(project_dir, "proj", request)
    preview = response.content
    assert preview == render_wav(project_dir, request)
    wav_path = export_composition(project_dir, composition, ExportTarget.WAV)
    assert preview == wav_path.read_bytes()
    with wave.open(str(wav_path), "rb") as audio:
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype=np.int16)
        assert audio.getnframes() == 425 * 16
        assert not np.any(samples[125 * 16 : 200 * 16])
        assert not np.any(samples[300 * 16 : 325 * 16])
    assert get_composition(project_dir, composition.composition_id).segments == segments
    saved_path = tmp_path / "collages" / composition.composition_id / "collage.json"
    saved = json.loads(saved_path.read_text(encoding="utf-8"))
    for segment in saved["segments"]:
        segment.pop("gap_before_ms")
        if segment["stretch_percent"] == 100:
            segment.pop("stretch_percent")
    saved_path.write_text(json.dumps(saved), encoding="utf-8")
    assert get_composition(project_dir, composition.composition_id).segments == segments


def test_professional_composition_round_trip_and_phone_duration(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(compositions, "DEFAULT_COLLAGES_DIR", tmp_path / "collages")
    project_dir = tmp_path / "proj"
    audio_dir = project_dir / "audio"
    audio_dir.mkdir(parents=True)
    (project_dir / "project.json").write_text(
        json.dumps({
            "sources": [{
                "source_id": "source",
                "path": "video.mp4",
                "duration_ms": 1000,
                "audio_sample_rate": 16000,
                "audio_channels": 1,
                "video_width": 1920,
                "video_height": 1080,
                "video_fps": 30,
            }],
        }),
        encoding="utf-8",
    )
    with wave.open(str(audio_dir / "source.wav"), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(np.full(16000, 8000, dtype=np.int16).tobytes())
    unit = PhoneUnit(
        phone_unit_id="phone_0",
        operation=PhoneAlignmentOperation.MATCH,
        target_index=0,
        target_phone_id="ko.vowel.a",
        target_ipa="a",
        source_occurrence_id="occurrence_0",
        source_phone_id="ko.vowel.a",
        source_ipa="a",
        source_start_ms=100,
        source_end_ms=200,
        output_duration_ms=250,
    )
    segment = replace(
        _segment(),
        timeline_end_ms=250,
        lane=0,
        phone_units=[unit],
    )
    request = SaveCompositionRequest(
        name="professional",
        target_text="가",
        target_pronunciation="가",
        crossfade_ms=8,
        segments=[segment],
        mode=CompositionMode.PROFESSIONAL,
    )

    composition = create_composition(project_dir, "proj", request)
    loaded = get_composition(project_dir, composition.composition_id)

    assert loaded == composition
    assert loaded.mode == CompositionMode.PROFESSIONAL
    with wave.open(BytesIO(render_wav(project_dir, loaded)), "rb") as audio:
        assert audio.getnframes() == 250 * 16


def test_professional_mp4_retimes_phone_video(tmp_path, monkeypatch) -> None:
    import av

    monkeypatch.setattr(compositions, "DEFAULT_COLLAGES_DIR", tmp_path / "collages")
    project_dir = tmp_path / "proj"
    audio_dir = project_dir / "audio"
    audio_dir.mkdir(parents=True)
    source_video = tmp_path / "source.mp4"
    _write_test_video(source_video)
    (project_dir / "project.json").write_text(
        json.dumps({
            "sources": [{
                "source_id": "source",
                "path": str(source_video),
                "duration_ms": 1000,
                "audio_sample_rate": 16000,
                "audio_channels": 1,
                "video_width": 64,
                "video_height": 64,
                "video_fps": 10,
            }],
        }),
        encoding="utf-8",
    )
    with wave.open(str(audio_dir / "source.wav"), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(np.full(16000, 8000, dtype=np.int16).tobytes())
    unit = PhoneUnit(
        phone_unit_id="phone_0",
        operation=PhoneAlignmentOperation.MATCH,
        target_index=0,
        target_phone_id="ko.vowel.a",
        target_ipa="a",
        source_occurrence_id="occurrence_0",
        source_phone_id="ko.vowel.a",
        source_ipa="a",
        source_start_ms=100,
        source_end_ms=300,
        output_duration_ms=400,
    )
    segment = replace(
        _segment(),
        source_start_ms=100,
        source_end_ms=300,
        timeline_end_ms=400,
        lane=0,
        phone_units=[unit],
    )
    request = SaveCompositionRequest(
        name="professional video",
        target_text="가",
        target_pronunciation="가",
        crossfade_ms=8,
        segments=[segment],
        mode=CompositionMode.PROFESSIONAL,
    )
    composition = create_composition(project_dir, "proj", request)

    output = export_composition(project_dir, composition, ExportTarget.MP4)
    with av.open(str(output)) as container:
        frames = list(container.decode(video=0))

    assert len(frames) == 4
    assert frames[-1].time is not None
    assert float(frames[-1].time) >= 0.3


def test_professional_video_overlap_uses_dissolve_progress() -> None:
    previous = replace(_segment(), timeline_start_ms=0, timeline_end_ms=200)
    current = replace(
        _segment(),
        segment_id="segment_1",
        timeline_start_ms=100,
        timeline_end_ms=300,
    )

    assert _video_overlap_alpha(current, previous, 3, 30) == 0.0
    assert _video_overlap_alpha(current, previous, 4, 30) == pytest.approx(1 / 3)
    assert _video_overlap_alpha(current, previous, 6, 30) == 1.0


def test_mp4_export_rejects_audio_only_source_without_server_error(tmp_path, monkeypatch) -> None:
    from madnolia import projects

    project_id = "proj_20260928_100000"
    project_dir = tmp_path / "projects" / project_id
    project_dir.mkdir(parents=True)
    audio_dir = project_dir / "audio"
    audio_dir.mkdir()
    source_audio = tmp_path / "source.wav"
    with wave.open(str(source_audio), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(np.full(16000, 8000, dtype=np.int16).tobytes())
    with wave.open(str(audio_dir / "source.wav"), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(np.full(16000, 8000, dtype=np.int16).tobytes())
    (project_dir / "project.json").write_text(
        json.dumps(
            {
                "project_id": project_id,
                "sources": [
                    {
                        "source_id": "source",
                        "path": str(source_audio),
                        "duration_ms": 1000,
                        "audio_sample_rate": 16000,
                        "audio_channels": 1,
                        "video_width": None,
                        "video_height": None,
                        "video_fps": None,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(projects, "DEFAULT_PROJECTS_DIR", tmp_path / "projects")
    monkeypatch.setattr(compositions, "DEFAULT_COLLAGES_DIR", tmp_path / "collages")
    request = SaveCompositionRequest(
        name="audio only",
        target_text="test",
        target_pronunciation="test",
        crossfade_ms=8,
        segments=[_segment()],
    )
    composition = create_composition(project_dir, project_id, request)

    response = TestClient(viewer.app).post(
        f"/api/projects/{project_id}/compositions/{composition.composition_id}/export/MP4"
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "MP4 export requires a video track in each selected source."
    assert not list(
        (tmp_path / "collages" / composition.composition_id / "exports").glob("*.mp4")
    )


def _write_test_video(path) -> None:
    import av

    output = av.open(str(path), "w")
    stream = output.add_stream("libx264", rate=10)
    stream.width = 64
    stream.height = 64
    stream.pix_fmt = "yuv420p"
    for index in range(10):
        pixels = np.full((64, 64, 3), index * 20, dtype=np.uint8)
        frame = av.VideoFrame.from_ndarray(pixels, format="rgb24")
        frame.pts = index
        frame.time_base = Fraction(1, 10)
        for packet in stream.encode(frame):
            output.mux(packet)
    for packet in stream.encode():
        output.mux(packet)
    output.close()
