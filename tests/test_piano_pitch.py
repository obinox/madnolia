import json
import wave
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from madnolia import viewer
from madnolia.autotune import _apply_pitch_notes_to_contour, _estimate_f0, analyze_composition_pitch
from madnolia.exporters import _render_edit_regions, _render_segment_audio
from madnolia.types.common import (
    CompositionMode,
    EditRegion,
    MatchStatus,
    PianoRollPitchNote,
    PhoneAlignmentOperation,
    PitchCurvePoint,
    PhonePitchContour,
    SegmentPitchContour,
    PhonePitchOwnerRef,
    PhonePitchPoint,
    PhoneUnit,
    PitchEnvelopePoint,
    TimelineSegment,
)


def _unit(phone_id: str, start: int, end: int, target: float | None, duration: int) -> PhoneUnit:
    return PhoneUnit(
        phone_unit_id=phone_id,
        operation=PhoneAlignmentOperation.MATCH,
        target_index=0,
        target_phone_id="ko.vowel.a",
        target_ipa="a",
        source_occurrence_id=phone_id,
        source_phone_id="ko.vowel.a",
        source_ipa="a",
        source_start_ms=start,
        source_end_ms=end,
        output_duration_ms=duration,
        source_f0_hz=220,
        target_pitch_midi=target,
    )


def _segment(units: list[PhoneUnit]) -> TimelineSegment:
    return TimelineSegment(
        segment_id="segment",
        candidate_id="candidate",
        target_start_index=0,
        target_end_index=2,
        source_id="source",
        source_start_ms=0,
        source_end_ms=1000,
        timeline_start_ms=0,
        timeline_end_ms=1500,
        match_status=MatchStatus.EXACT,
        target_ipa=["a", "a"],
        matched_ipa=["a", "a"],
        phone_units=units,
        edit_regions=[EditRegion("first", 0, 500, 250, 100), EditRegion("second", 500, 1000, 1250)],
        pitch_envelope=[PitchEnvelopePoint(0, 50), PitchEnvelopePoint(1, 50)],
    )


def _pitch_offset_cents(phone, point_index: int) -> float:
    original = phone.original[point_index].hz
    corrected = phone.corrected[point_index].hz
    assert original is not None and corrected is not None
    return float(1200 * np.log2(corrected / original))


def _without_layer_pitch(segment: TimelineSegment) -> TimelineSegment:
    return replace(
        segment,
        edit_regions=[replace(region, relative_pitch_cents=0) for region in segment.edit_regions],
        pitch_envelope=[],
    )


def _write_project(tmp_path: Path, frequency: float = 220) -> Path:
    project_dir = tmp_path / "project"
    audio_dir = project_dir / "audio"
    audio_dir.mkdir(parents=True)
    (project_dir / "project.json").write_text(
        json.dumps({"project_id": "project", "sources": [{"source_id": "source", "duration_ms": 1000}]}),
        encoding="utf-8",
    )
    samples = np.sin(2 * np.pi * frequency * np.arange(16000) / 16000)
    with wave.open(str(audio_dir / "source.wav"), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(np.clip(samples * 32767, -32768, 32767).astype(np.int16).tobytes())
    return project_dir


def _request() -> dict[str, object]:
    return {
        "name": "draft",
        "target_text": "aa",
        "target_pronunciation": "aa",
        "crossfade_ms": 0,
        "mode": "PROFESSIONAL",
        "segments": [
            {
                "segment_id": "segment",
                "candidate_id": "candidate",
                "target_start_index": 0,
                "target_end_index": 2,
                "source_id": "source",
                "source_start_ms": 0,
                "source_end_ms": 1000,
                "timeline_start_ms": 0,
                "timeline_end_ms": 1500,
                "match_status": "EXACT",
                "target_ipa": ["a", "a"],
                "matched_ipa": ["a", "a"],
                "phone_units": [
                    {
                        "phone_unit_id": "phone-one",
                        "operation": "MATCH",
                        "target_index": 0,
                        "target_phone_id": "ko.vowel.a",
                        "target_ipa": "a",
                        "source_occurrence_id": "one",
                        "source_phone_id": "ko.vowel.a",
                        "source_ipa": "a",
                        "source_start_ms": 100,
                        "source_end_ms": 400,
                        "output_duration_ms": 300,
                        "source_f0_hz": 220,
                        "target_pitch_midi": 69,
                    },
                    {
                        "phone_unit_id": "phone-two",
                        "operation": "MATCH",
                        "target_index": 1,
                        "target_phone_id": "ko.vowel.a",
                        "target_ipa": "a",
                        "source_occurrence_id": "two",
                        "source_phone_id": "ko.vowel.a",
                        "source_ipa": "a",
                        "source_start_ms": 400,
                        "source_end_ms": 900,
                        "output_duration_ms": 500,
                    },
                ],
                "edit_regions": [
                    {"region_id": "first", "source_start_ms": 0, "source_end_ms": 500, "output_duration_ms": 250, "relative_pitch_cents": 100},
                    {"region_id": "second", "source_start_ms": 500, "source_end_ms": 1000, "output_duration_ms": 1250, "relative_pitch_cents": 0},
                ],
                "pitch_envelope": [{"position": 0, "cents": 50}, {"position": 1, "cents": 50}],
            }
        ],
    }


def test_pitch_analysis_uses_unsaved_regions_and_measured_hz(tmp_path, monkeypatch) -> None:
    project_dir = _write_project(tmp_path)
    monkeypatch.setattr(viewer, "_project_dir", lambda _project_id: project_dir)
    monkeypatch.setattr(viewer, "validate_preview_request", lambda *_args: None)
    response = TestClient(viewer.app).post(
        "/api/projects/project/compositions/pitch-analysis",
        json=_request(),
    )

    assert response.status_code == 200
    first, second = response.json()["segments"][0]["phones"]
    assert (first["output_start_ms"], first["output_end_ms"]) == (50, 200)
    assert (second["output_start_ms"], second["output_end_ms"]) == (200, 1250)
    assert first["original"][0]["position"] == pytest.approx(0.04)
    assert first["original"][0]["hz"] == pytest.approx(220, abs=2)
    assert first["corrected"][0]["hz"] == pytest.approx(220 * 2 ** (1350 / 1200), abs=4)
    assert second["original"][0]["hz"] == pytest.approx(220, abs=2)


def test_pitch_analysis_marks_unvoiced_frames_as_null_hz(tmp_path, monkeypatch) -> None:
    project_dir = _write_project(tmp_path)
    audio_path = project_dir / "audio" / "source.wav"
    silence = np.zeros(16000, dtype=np.int16)
    with wave.open(str(audio_path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(silence.tobytes())
    monkeypatch.setattr(viewer, "_project_dir", lambda _project_id: project_dir)
    monkeypatch.setattr(viewer, "validate_preview_request", lambda *_args: None)

    response = TestClient(viewer.app).post(
        "/api/projects/project/compositions/pitch-analysis",
        json=_request(),
    )

    assert response.status_code == 200
    phones = response.json()["segments"][0]["phones"]
    assert phones
    for phone in phones:
        assert phone["original"]
        assert phone["corrected"]
        assert all(point["hz"] is None for point in phone["original"])
        assert all(point["hz"] is None for point in phone["corrected"])


def test_edit_region_renderer_applies_phone_targets_once_and_keeps_manual_offset(tmp_path) -> None:
    project_dir = _write_project(tmp_path)
    path = project_dir / "audio" / "source.wav"
    segment = _segment([_unit("one", 0, 500, 69, 500), _unit("two", 500, 1000, 66.5, 1000)])

    rendered = _render_edit_regions(path, segment, project_dir)
    first_f0, first_voiced, _ = _estimate_f0(rendered[:4000], 16000)
    second_f0, second_voiced, _ = _estimate_f0(rendered[4000:], 16000)

    assert np.median(first_f0[first_voiced]) == pytest.approx(220 * 2 ** (1350 / 1200), abs=8)
    assert np.median(second_f0[second_voiced]) == pytest.approx(220 * 2 ** (1000 / 1200), abs=12)


def test_phone_pitch_points_render_flat_notes_without_sweeping_unvoiced_gap(tmp_path) -> None:
    sample_rate = 16000
    times = np.arange(sample_rate, dtype=np.float64) / sample_rate
    source = np.zeros(sample_rate, dtype=np.float32)
    source[:4800] = 0.4 * np.sin(2 * np.pi * 220 * times[:4800])
    source[4800:8000] = 0.4 * np.sin(2 * np.pi * 330 * times[4800:8000])
    source[8000:] = 0.4 * np.sin(2 * np.pi * 220 * times[8000:])
    path = tmp_path / "source.wav"
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        audio.writeframes((source * 32767).astype("<i2").tobytes())
    left = replace(
        _unit("left", 0, 300, None, 300),
        pitch_points=[PhonePitchPoint(0, 50), PhonePitchPoint(1, 50)],
        pitch_owner_ref=PhonePitchOwnerRef("segment", "left"),
    )
    unvoiced = replace(
        _unit("unvoiced", 300, 500, None, 200),
        source_f0_hz=None,
        pitch_points=[],
        pitch_owner_ref=PhonePitchOwnerRef("segment", "right"),
    )
    right = replace(
        _unit("right", 500, 1000, None, 500),
        pitch_points=[PhonePitchPoint(0, 72), PhonePitchPoint(1, 72)],
        pitch_owner_ref=PhonePitchOwnerRef("segment", "right"),
    )
    segment = TimelineSegment(
        segment_id="segment",
        candidate_id="candidate",
        target_start_index=0,
        target_end_index=3,
        source_id="source",
        source_start_ms=0,
        source_end_ms=1000,
        timeline_start_ms=0,
        timeline_end_ms=1000,
        match_status=MatchStatus.EXACT,
        target_ipa=["a", "s", "a"],
        matched_ipa=["a", "s", "a"],
        phone_units=[left, unvoiced, right],
        edit_regions=[EditRegion("region", 0, 1000, 1000)],
    )

    rendered = _render_edit_regions(path, segment)
    f0, voiced, frame_times = _estimate_f0(rendered, sample_rate)
    frame_times = frame_times / 1000

    assert len(rendered) == len(source)
    assert np.median(f0[voiced & (frame_times < 0.25)]) == pytest.approx(440 * 2 ** ((50 - 69) / 12), abs=8)
    assert np.median(f0[voiced & (frame_times > 0.34) & (frame_times < 0.46)]) == pytest.approx(330, abs=5)
    assert np.median(f0[voiced & (frame_times > 0.65) & (frame_times < 0.9)]) == pytest.approx(440 * 2 ** ((72 - 69) / 12), abs=8)


def test_phone_pitch_point_interior_rise_and_fall_are_rendered(tmp_path) -> None:
    sample_rate = 16000
    times = np.arange(sample_rate) / sample_rate
    path = tmp_path / "source.wav"
    source = 0.5 * np.sin(2 * np.pi * 220 * times)
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        audio.writeframes((source * 32767).astype("<i2").tobytes())
    unit = replace(
        _unit("curve", 0, 1000, None, 1000),
        pitch_points=[
            PhonePitchPoint(0, 69),
            PhonePitchPoint(0.5, 72),
            PhonePitchPoint(1, 69),
        ],
        pitch_owner_ref=PhonePitchOwnerRef("segment", "curve"),
    )
    segment = replace(
        _segment([unit]),
        timeline_end_ms=1000,
        edit_regions=[EditRegion("region", 0, 1000, 1000)],
        pitch_envelope=[],
    )

    rendered = _render_edit_regions(path, segment)
    f0, voiced, frame_times = _estimate_f0(rendered, sample_rate)
    time_seconds = frame_times / 1000
    low_start = np.median(f0[voiced & (time_seconds > 0.1) & (time_seconds < 0.2)])
    peak = np.median(f0[voiced & (time_seconds > 0.45) & (time_seconds < 0.55)])
    low_end = np.median(f0[voiced & (time_seconds > 0.8) & (time_seconds < 0.9)])

    assert len(rendered) == len(source)
    assert low_start == pytest.approx(440 * 2 ** (0.9 / 12), abs=12)
    assert peak == pytest.approx(440 * 2 ** (3 / 12), abs=12)
    assert low_end == pytest.approx(440 * 2 ** (0.9 / 12), abs=12)


def test_phone_pitch_points_render_on_professional_phone_path(tmp_path) -> None:
    project_dir = _write_project(tmp_path)
    unit = replace(
        _unit("flat", 0, 1000, None, 1000),
        pitch_points=[PhonePitchPoint(0, 69), PhonePitchPoint(1, 69)],
        pitch_owner_ref=PhonePitchOwnerRef("segment", "flat"),
    )
    segment = replace(
        _segment([unit]),
        timeline_end_ms=1000,
        edit_regions=[],
        pitch_envelope=[],
    )

    rendered = _render_segment_audio(project_dir, CompositionMode.PROFESSIONAL, segment, 16000)
    f0, voiced, _ = _estimate_f0(rendered[2000:14000], 16000)

    assert len(rendered) == 16000
    assert np.median(f0[voiced]) == pytest.approx(440, abs=8)


def test_region_pitch_points_preserve_legacy_phone_pitch_outside_note(tmp_path) -> None:
    sample_rate = 16000
    times = np.arange(sample_rate, dtype=np.float64) / sample_rate
    source = sum(
        (0.4 / harmonic) * np.sin(2 * np.pi * 220 * harmonic * times + harmonic * 0.17)
        for harmonic in range(1, 9)
    ).astype(np.float32)
    source *= 0.45 / np.max(np.abs(source))
    path = tmp_path / "source.wav"
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        audio.writeframes((source * 32767).astype("<i2").tobytes())
    left = _unit("left", 0, 500, None, 500)
    right = replace(
        _unit("right", 500, 1000, None, 500),
        pitch_points=[PhonePitchPoint(0, 72), PhonePitchPoint(1, 72)],
        pitch_owner_ref=PhonePitchOwnerRef("segment", "right"),
    )
    segment = TimelineSegment(
        segment_id="segment",
        candidate_id="candidate",
        target_start_index=0,
        target_end_index=2,
        source_id="source",
        source_start_ms=0,
        source_end_ms=1000,
        timeline_start_ms=0,
        timeline_end_ms=1000,
        match_status=MatchStatus.EXACT,
        target_ipa=["a", "a"],
        matched_ipa=["a", "a"],
        phone_units=[left, right],
        edit_regions=[
            EditRegion("note", 0, 500, 500, pitch_points=[PhonePitchPoint(0, 69), PhonePitchPoint(1, 69)]),
            EditRegion("legacy", 500, 1000, 500),
        ],
    )

    rendered = _render_edit_regions(path, segment)
    first_f0, first_voiced, _ = _estimate_f0(rendered[:8000], sample_rate)
    second_f0, second_voiced, _ = _estimate_f0(rendered[8000:], sample_rate)

    assert np.median(first_f0[first_voiced]) == pytest.approx(440, abs=10)
    assert np.median(second_f0[second_voiced]) == pytest.approx(523.25, abs=14)


def test_pitch_analysis_tracks_strength_and_portamento_settings(tmp_path) -> None:
    project_dir = _write_project(tmp_path)
    left = _unit("left", 0, 500, 60, 500)
    right = _unit("right", 500, 1000, 64, 1000)

    uncorrected = analyze_composition_pitch(
        project_dir,
        [_without_layer_pitch(_segment([replace(left, target_pitch_strength_percent=0), right]))],
    ).segments[0]
    corrected = analyze_composition_pitch(
        project_dir,
        [_without_layer_pitch(_segment([replace(left, transition_to_next_ms=300, transition_strength_percent=0), right]))],
    ).segments[0]
    portamento = analyze_composition_pitch(
        project_dir,
        [_without_layer_pitch(_segment([replace(left, transition_to_next_ms=300, transition_strength_percent=100), right]))],
    ).segments[0]
    centered = analyze_composition_pitch(
        project_dir,
        [_without_layer_pitch(_segment([replace(
            left,
            transition_to_next_ms=300,
            transition_strength_percent=100,
            transition_center_ms=100,
        ), right]))],
    ).segments[0]

    assert _pitch_offset_cents(uncorrected.phones[0], 10) == pytest.approx(0, abs=3)
    assert _pitch_offset_cents(corrected.phones[0], 10) == pytest.approx(300, abs=8)
    assert _pitch_offset_cents(portamento.phones[0], -1) > _pitch_offset_cents(corrected.phones[0], -1) + 50
    assert _pitch_offset_cents(centered.phones[0], -1) < _pitch_offset_cents(portamento.phones[0], -1) - 50


def test_absolute_pitch_notes_map_phone_contours_to_segment_time() -> None:
    segment = replace(_segment([_unit("phone", 0, 1000, None, 300)]), timeline_start_ms=1000, timeline_end_ms=2000)
    points = [PitchCurvePoint(position, 440.0) for position in (0.25, 0.5, 0.75)]
    contour = SegmentPitchContour(
        segment.segment_id,
        [PhonePitchContour("phone", 0, 1000, 400, 700, points, points)],
    )
    note = PianoRollPitchNote("target", 1450, 1550, [PhonePitchPoint(0, 72), PhonePitchPoint(1, 72)])

    corrected = _apply_pitch_notes_to_contour(contour, segment, [note]).phones[0].corrected

    assert corrected[0].hz == pytest.approx(440)
    assert corrected[1].hz == pytest.approx(440 * 2 ** ((72 - 69) / 12))
    assert corrected[2].hz == pytest.approx(440)


def test_pitch_analysis_vibrato_respects_start_depth_and_rate(tmp_path) -> None:
    project_dir = _write_project(tmp_path)
    unit = replace(
        _unit("vibrato", 0, 1000, None, 1000),
        vibrato_depth_cents=100,
        vibrato_rate_hz=5,
        vibrato_start_ms=200,
    )

    def contour(current: PhoneUnit):
        segment = replace(
            _segment([current]),
            timeline_end_ms=1000,
            edit_regions=[EditRegion("only", 0, 1000, 1000)],
            pitch_envelope=[],
        )
        return analyze_composition_pitch(project_dir, [segment]).segments[0].phones[0]

    five_hz = contour(unit)
    ten_hz = contour(replace(unit, vibrato_rate_hz=10))
    shallow = contour(replace(unit, vibrato_depth_cents=50))

    before_start = min(range(len(five_hz.original)), key=lambda index: abs(five_hz.original[index].position - 0.15))
    positive_peak = min(range(len(five_hz.original)), key=lambda index: abs(five_hz.original[index].position - 0.25))
    assert _pitch_offset_cents(five_hz, before_start) == pytest.approx(0, abs=3)
    assert _pitch_offset_cents(five_hz, positive_peak) > 60
    assert _pitch_offset_cents(shallow, positive_peak) == pytest.approx(
        _pitch_offset_cents(five_hz, positive_peak) / 2, abs=8
    )
    assert _pitch_offset_cents(ten_hz, positive_peak) < 20

    segment = replace(
        _segment([unit]),
        timeline_end_ms=1000,
        edit_regions=[EditRegion("only", 0, 1000, 1000)],
        pitch_envelope=[],
    )
    rendered = _render_edit_regions(project_dir / "audio" / "source.wav", segment, project_dir)
    frequencies, voiced, frame_times = _estimate_f0(rendered, 16000)
    midi = 69 + 12 * np.log2(frequencies[voiced] / 440)
    voiced_times = frame_times[voiced] / 1000
    before_start = midi[(voiced_times >= 0.04) & (voiced_times <= 0.16)]
    after_start = midi[(voiced_times >= 0.22) & (voiced_times <= 0.98)]
    assert np.ptp(before_start) < 0.3
    assert np.ptp(after_start) * 100 > 100
