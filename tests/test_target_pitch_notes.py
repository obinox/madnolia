import json
import wave
from dataclasses import replace
from io import BytesIO

import numpy as np
import pytest

from madnolia import compositions
from madnolia.autotune import _estimate_f0
from madnolia.compositions import create_composition, get_composition, update_composition
from madnolia.exporters import render_wav
from madnolia.services.composition_validation import _validate_request
from madnolia.types.common import (
    CompositionMode,
    EditRegion,
    MatchStatus,
    PhonePitchPoint,
    PianoRollPitchNote,
    SaveCompositionRequest,
    TimelineSegment,
)


def _write_project(tmp_path, voiced_until_ms=1000):
    project_dir = tmp_path / "project"
    audio_dir = project_dir / "audio"
    audio_dir.mkdir(parents=True)
    (project_dir / "project.json").write_text(
        json.dumps({"sources": [{"source_id": "source", "duration_ms": 1000}]}),
        encoding="utf-8",
    )
    samples = np.zeros(16000, dtype=np.float32)
    voiced_samples = voiced_until_ms * 16
    times = np.arange(voiced_samples, dtype=np.float64) / 16000
    voiced = sum(
        (0.4 / harmonic) * np.sin(2 * np.pi * 220 * harmonic * times + harmonic * 0.17)
        for harmonic in range(1, 9)
    )
    samples[:voiced_samples] = voiced * (0.45 / np.max(np.abs(voiced)))
    with wave.open(str(audio_dir / "source.wav"), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(np.clip(samples * 32767, -32768, 32767).astype("<i2").tobytes())
    return project_dir


def _segment(start=0, end=1000, timeline_start=0):
    duration = end - start
    return TimelineSegment(
        segment_id=f"segment_{start}",
        candidate_id="candidate",
        target_start_index=0,
        target_end_index=1,
        source_id="source",
        source_start_ms=start,
        source_end_ms=end,
        timeline_start_ms=timeline_start,
        timeline_end_ms=timeline_start + duration,
        match_status=MatchStatus.EXACT,
        target_ipa=["a"],
        matched_ipa=["a"],
        edit_regions=[EditRegion(f"region_{start}", start, end, duration)],
    )


def _note(start=0, end=1000, curve=None, note_id="note"):
    points = curve or [PhonePitchPoint(0, 69), PhonePitchPoint(1, 69)]
    return PianoRollPitchNote(note_id, start, end, points)


def _request(segments=None, notes=None):
    return SaveCompositionRequest(
        name="pitch notes",
        target_text="a",
        target_pronunciation="a",
        crossfade_ms=0,
        segments=segments or [_segment()],
        mode=CompositionMode.PROFESSIONAL,
        pitch_notes=notes or [],
    )


def _rendered_samples(project_dir, request):
    with wave.open(BytesIO(render_wav(project_dir, request)), "rb") as audio:
        assert audio.getframerate() == 16000
        return np.frombuffer(audio.readframes(audio.getnframes()), dtype=np.int16)


def test_pitch_note_changes_only_its_absolute_time_range(tmp_path):
    project_dir = _write_project(tmp_path)
    baseline = _rendered_samples(project_dir, _request())
    rendered = _rendered_samples(project_dir, _request(notes=[_note(250, 700)]))

    assert len(rendered) == 16000
    np.testing.assert_array_equal(rendered[:4000], baseline[:4000])
    np.testing.assert_array_equal(rendered[11200:], baseline[11200:])
    f0, voiced, frame_times = _estimate_f0(rendered, 16000)
    note_frames = voiced & (frame_times >= 300) & (frame_times <= 650)
    assert np.median(f0[note_frames]) == pytest.approx(440, abs=12)


def test_curved_pitch_note_continues_across_segment_boundary(tmp_path):
    project_dir = _write_project(tmp_path)
    curve = [PhonePitchPoint(0, 69), PhonePitchPoint(0.5, 72), PhonePitchPoint(1, 69)]
    request = _request(
        segments=[_segment(0, 500, 0), _segment(500, 1000, 500)],
        notes=[_note(100, 900, curve)],
    )

    rendered = _rendered_samples(project_dir, request)
    f0, voiced, frame_times = _estimate_f0(rendered, 16000)
    before = np.median(f0[voiced & (frame_times >= 440) & (frame_times <= 480)])
    after = np.median(f0[voiced & (frame_times >= 520) & (frame_times <= 560)])
    peak = np.median(f0[voiced & (frame_times >= 490) & (frame_times <= 510)])
    early = np.median(f0[voiced & (frame_times >= 180) & (frame_times <= 220)])
    late = np.median(f0[voiced & (frame_times >= 780) & (frame_times <= 820)])

    assert len(rendered) == 16000
    assert before == pytest.approx(after, abs=18)
    assert peak == pytest.approx(523.25, abs=25)
    assert early == pytest.approx(late, abs=18)
    assert peak > max(early, late) + 25


def test_pitch_note_does_not_create_voicing_in_silent_source_gap(tmp_path):
    project_dir = _write_project(tmp_path, voiced_until_ms=500)
    rendered = _rendered_samples(project_dir, _request(notes=[_note()]))
    f0, voiced, frame_times = _estimate_f0(rendered, 16000)

    assert len(rendered) == 16000
    assert np.count_nonzero(voiced & (frame_times >= 600) & (frame_times <= 900)) == 0
    assert np.median(f0[voiced & (frame_times >= 100) & (frame_times <= 400)]) == pytest.approx(440, abs=12)


def test_pitch_notes_round_trip_create_load_and_update(tmp_path, monkeypatch):
    monkeypatch.setattr(compositions, "DEFAULT_COLLAGES_DIR", tmp_path / "collages")
    project_dir = _write_project(tmp_path)
    notes = [
        _note(120, 420, [PhonePitchPoint(0, 65.5), PhonePitchPoint(0.4, 69), PhonePitchPoint(1, 67)], "first"),
        _note(500, 800, [PhonePitchPoint(0, 72), PhonePitchPoint(1, 70.25)], "second"),
    ]
    simple_parent = create_composition(
        project_dir,
        "project",
        replace(_request(), mode=CompositionMode.SIMPLE, segments=[replace(_segment(), edit_regions=[])]),
    )
    request = replace(
        _request(notes=notes),
        parent_composition_id=simple_parent.composition_id,
        parent_composition_updated_at=simple_parent.updated_at,
    )

    created = create_composition(project_dir, "project", request)
    assert created.pitch_notes == notes
    assert get_composition(project_dir, created.composition_id).pitch_notes == notes

    updated_notes = [replace(notes[0], end_ms=450), notes[1]]
    updated = update_composition(project_dir, created.composition_id, replace(request, pitch_notes=updated_notes))
    assert updated.pitch_notes == updated_notes
    assert get_composition(project_dir, created.composition_id).pitch_notes == updated_notes


@pytest.mark.parametrize(
    "note, message",
    [
        (_note(-1, 100), "at or after zero"),
        (_note(100, 119), "at least 20 milliseconds"),
        (_note(0, 100, [PhonePitchPoint(0.1, 69), PhonePitchPoint(1, 69)]), "start at 0 and end at 1"),
        (_note(0, 100, [PhonePitchPoint(0, 69), PhonePitchPoint(0.5, 70)]), "start at 0 and end at 1"),
        (_note(0, 100, [PhonePitchPoint(0, 69), PhonePitchPoint(0.5, 70), PhonePitchPoint(0.5, 71), PhonePitchPoint(1, 69)]), "curve points are invalid"),
        (_note(0, 100, [PhonePitchPoint(0, 69), PhonePitchPoint(0.8, 70), PhonePitchPoint(0.7, 71), PhonePitchPoint(1, 69)]), "curve points are invalid"),
        (_note(0, 100, [PhonePitchPoint(0, 69), PhonePitchPoint(0.5, float("nan")), PhonePitchPoint(1, 69)]), "curve points are invalid"),
        (_note(0, 100, [PhonePitchPoint(0, 69), PhonePitchPoint(0.5, float("inf")), PhonePitchPoint(1, 69)]), "curve points are invalid"),
    ],
)
def test_pitch_note_validation_rejects_invalid_bounds_and_curves(note, message):
    with pytest.raises(ValueError, match=message):
        _validate_request(_request(notes=[note]))


def test_pitch_note_validation_rejects_noninteger_bounds_and_duplicate_ids():
    fractional = replace(_note(0, 100), start_ms=0.5)
    duplicate = [_note(0, 100), _note(200, 300)]
    duplicate[1] = replace(duplicate[1], note_id="note")

    with pytest.raises(ValueError, match="integer milliseconds"):
        _validate_request(_request(notes=[fractional]))
    with pytest.raises(ValueError, match="nonempty and unique"):
        _validate_request(_request(notes=duplicate))


def test_pitch_notes_require_professional_segments_with_regions():
    note = _note()
    with pytest.raises(ValueError, match="professional segments with edit regions"):
        _validate_request(replace(_request(notes=[note]), mode=CompositionMode.SIMPLE))
    with pytest.raises(ValueError, match="professional segments with edit regions"):
        _validate_request(_request(segments=[replace(_segment(), edit_regions=[])], notes=[note]))
