import wave
from dataclasses import replace

import numpy as np
import pytest

from madnolia import autotune, exporters
from madnolia.exporters import (
    _render_edit_regions,
    _render_phone_pitch_points,
    _render_segment_audio,
)
from madnolia.pitch_shift import render_local_pitch_curve
from madnolia.types.common import (
    CompositionMode,
    EditRegion,
    MatchStatus,
    PhoneAlignmentOperation,
    PhonePitchOwnerRef,
    PhonePitchPoint,
    PhoneUnit,
    TimelineSegment,
)
from madnolia.world_pitch import read_exact_region_audio


def test_f0_estimation_tracks_detuned_tones_with_subsample_precision() -> None:
    sample_rate = 16000
    times = np.arange(sample_rate, dtype=np.float64) / sample_rate
    for frequency in (70.0, 90.0, 110.0, 220.0, 432.0, 448.0, 800.0):
        samples = (0.5 * np.sin(2 * np.pi * frequency * times)).astype(np.float32)
        f0, voiced, _ = autotune._estimate_f0(samples, sample_rate)
        estimated = float(np.median(f0[voiced]))
        assert abs(1200 * np.log2(estimated / frequency)) < 10


def test_f0_estimation_rejects_dominant_second_harmonic() -> None:
    sample_rate = 16000
    times = np.arange(sample_rate, dtype=np.float64) / sample_rate
    samples = (
        0.15 * np.sin(2 * np.pi * 220 * times)
        + 0.8 * np.sin(2 * np.pi * 440 * times)
        + 0.3 * np.sin(2 * np.pi * 660 * times)
    ).astype(np.float32)

    f0, voiced, _ = autotune._estimate_f0(samples, sample_rate)

    assert np.all(voiced)
    assert abs(float(np.median(f0)) - 220) < 3


def test_absolute_pitch_points_correct_chirp_in_both_render_paths(tmp_path, monkeypatch) -> None:
    sample_rate = 16000
    times = np.arange(sample_rate, dtype=np.float64) / sample_rate
    source_f0 = 200 + 60 * times
    source = (0.55 * np.sin(2 * np.pi * np.cumsum(source_f0) / sample_rate)).astype(np.float32)
    source_path = tmp_path / "chirp.wav"
    with wave.open(str(source_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes((source * 32767).astype("<i2").tobytes())
    monkeypatch.setattr(autotune, "audio_path", lambda _directory, _source_id: source_path)
    monkeypatch.setattr("madnolia.exporters.audio_path", lambda _directory, _source_id: source_path)
    target_midi = 69.0 + 12 * np.log2(220 / 440)

    contours = (
        [PhonePitchPoint(0.0, target_midi), PhonePitchPoint(1.0, target_midi)],
        [
            PhonePitchPoint(0.0, target_midi),
            PhonePitchPoint(0.5, target_midi + 12 * np.log2(250 / 220)),
            PhonePitchPoint(1.0, target_midi),
        ],
    )
    for use_edit_region in (False, True):
        for contour_index, points in enumerate(contours):
            unit = replace(
                _test_phone("vowel", 0, 1000, 1000),
                source_f0_hz=230,
                pitch_points=points,
            )
            segment = TimelineSegment(
                segment_id=f"segment-{use_edit_region}-{contour_index}",
                candidate_id="candidate",
                target_start_index=0,
                target_end_index=1,
                source_id="source",
                source_start_ms=0,
                source_end_ms=1000,
                timeline_start_ms=0,
                timeline_end_ms=1000,
                match_status=MatchStatus.EXACT,
                target_ipa=["a"],
                matched_ipa=["a"],
                phone_units=[unit],
                edit_regions=[EditRegion("region", 0, 1000, 1000)] if use_edit_region else [],
            )
            rendered = _render_segment_audio(
                tmp_path,
                CompositionMode.PROFESSIONAL,
                segment,
                sample_rate,
                pitch_groups=autotune.build_phone_pitch_groups([segment]),
            )

            assert len(rendered) == len(source)
            windows = ((0.15, 0.25), (0.45, 0.55), (0.75, 0.85))
            for start_seconds, end_seconds in windows:
                center_position = (start_seconds + end_seconds) / 2
                original = source[round(start_seconds * sample_rate) : round(end_seconds * sample_rate)]
                corrected = rendered[round(start_seconds * sample_rate) : round(end_seconds * sample_rate)]
                expected_original = 200 + 60 * center_position
                expected_target = np.interp(
                    center_position,
                    [point.position for point in points],
                    [440 * 2 ** ((point.midi - 69) / 12) for point in points],
                )
                assert abs(_spectral_peak(original, sample_rate) - expected_original) < 7
                assert abs(_spectral_peak(corrected, sample_rate) - expected_target) < 7


def test_group_pitch_graph_uses_phone_local_vibrato_and_region_offset(tmp_path, monkeypatch) -> None:
    first = replace(
        _test_phone("first", 0, 500, 500),
        source_f0_hz=440,
        pitch_points=[PhonePitchPoint(0, 69), PhonePitchPoint(1, 69)],
    )
    second = replace(
        _test_phone("second", 500, 1000, 500),
        source_f0_hz=440,
        pitch_owner_ref=PhonePitchOwnerRef("segment", "first"),
        vibrato_depth_cents=100,
        vibrato_rate_hz=2,
        vibrato_start_ms=150,
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
        phone_units=[first, second],
        edit_regions=[EditRegion("region", 0, 1000, 1000, relative_pitch_cents=120)],
    )
    monkeypatch.setattr(autotune, "audio_path", lambda *_args: tmp_path / "source.wav")
    monkeypatch.setattr(autotune, "_read_source", lambda *_args: (np.zeros(1), 16000))
    monkeypatch.setattr(
        autotune,
        "_estimate_f0",
        lambda *_args: (np.full(10, 440.0), np.ones(10, dtype=bool), np.arange(10) * 50 + 20),
    )

    with_offsets = autotune._analyze_segment_pitch(
        tmp_path, segment, True, pitch_groups=autotune.build_phone_pitch_groups([segment])
    )
    without_offsets = autotune._analyze_segment_pitch(
        tmp_path, segment, False, pitch_groups=autotune.build_phone_pitch_groups([segment])
    )
    voiced_index = min(
        range(len(with_offsets.phones[1].original)),
        key=lambda index: abs(with_offsets.phones[1].original[index].position - 0.72),
    )
    early_index = min(
        range(len(with_offsets.phones[1].original)),
        key=lambda index: abs(with_offsets.phones[1].original[index].position - 0.52),
    )

    assert _pitch_offset_cents(with_offsets.phones[1], early_index) == pytest.approx(120, abs=1)
    assert _pitch_offset_cents(without_offsets.phones[1], early_index) == pytest.approx(0, abs=1)
    assert _pitch_offset_cents(with_offsets.phones[1], voiced_index) == pytest.approx(
        120 + autotune._vibrato_cents(second, 220), abs=1
    )
    attached_unvoiced = replace(second, source_f0_hz=None)
    follower_segment = replace(segment, phone_units=[first, attached_unvoiced])
    follower_graph = autotune._analyze_segment_pitch(
        tmp_path,
        follower_segment,
        pitch_groups=autotune.build_phone_pitch_groups([follower_segment]),
    ).phones[1]
    assert all(
        point.hz == corrected.hz
        for point, corrected in zip(follower_graph.original, follower_graph.corrected, strict=True)
        if point.hz is not None
    )


def test_pitch_point_renderer_preserves_no_voiced_and_short_inputs() -> None:
    unit = _test_phone("short", 0, 20, 20)
    group = ([PhonePitchPoint(0, 81), PhonePitchPoint(1, 81)], 0.0, 20.0)
    silence = np.zeros(3200, dtype=np.float32)
    short = (0.5 * np.sin(2 * np.pi * 440 * np.arange(200) / 16000)).astype(np.float32)

    assert np.array_equal(_render_phone_pitch_points(silence, unit, group, 0, 200, 69), silence)
    assert np.array_equal(_render_phone_pitch_points(short, unit, group, 0, 12.5, 69), short)


def test_pitch_point_renderer_keeps_unvoiced_gap_unchanged() -> None:
    sample_rate = 16000
    times = np.arange(sample_rate, dtype=np.float64) / sample_rate
    samples = np.zeros(sample_rate, dtype=np.float32)
    for start, end in ((0.1, 0.4), (0.6, 0.9)):
        selected = (times >= start) & (times < end)
        samples[selected] = 0.5 * np.sin(2 * np.pi * 440 * times[selected])
    rng = np.random.default_rng(3)
    samples[round(0.4 * sample_rate):round(0.6 * sample_rate)] = (
        rng.normal(0, 0.005, round(0.2 * sample_rate)).astype(np.float32)
    )
    unit = _test_phone("mixed", 0, 1000, 1000)
    group = ([PhonePitchPoint(0, 70), PhonePitchPoint(1, 70)], 0.0, 1000.0)

    rendered = _render_phone_pitch_points(samples, unit, group, 0, 1000, 69)

    gap = slice(round(0.47 * sample_rate), round(0.53 * sample_rate))
    assert np.array_equal(rendered[gap], samples[gap])
    voiced = rendered[round(0.15 * sample_rate):round(0.35 * sample_rate)]
    spectrum = np.abs(np.fft.rfft(voiced * np.hanning(len(voiced))))
    frequencies = np.fft.rfftfreq(len(voiced), 1 / sample_rate)
    band = (frequencies >= 400) & (frequencies <= 550)
    assert frequencies[band][np.argmax(spectrum[band])] > 455


def test_pitch_point_renderer_corrects_steep_chirp_without_time_drift() -> None:
    sample_rate = 16000
    times = np.arange(round(1.5 * sample_rate), dtype=np.float64) / sample_rate
    source_f0 = np.interp(times, [0.0, 0.6, 1.5], [180.0, 330.0, 200.0])
    samples = (0.5 * np.sin(2 * np.pi * np.cumsum(source_f0) / sample_rate)).astype(np.float32)
    unit = _test_phone("chirp", 0, 1500, 1500)
    group = ([PhonePitchPoint(0, 69 + 12 * np.log2(220 / 440)), PhonePitchPoint(1, 69 + 12 * np.log2(220 / 440))], 0.0, 1500.0)

    source_pitch, source_voiced, source_times = autotune._estimate_f0(samples, sample_rate)
    rendered = _render_phone_pitch_points(samples, unit, group, 0.0, 1500.0, 69 + 12 * np.log2(250 / 440))
    rendered_pitch, rendered_voiced, rendered_times = autotune._estimate_f0(rendered, sample_rate)

    assert len(rendered) == len(samples)
    assert np.isfinite(rendered).all()
    windows = ((0.18, 0.38), (0.48, 0.68), (0.78, 0.98), (1.08, 1.28), (1.25, 1.45))
    for start, end in windows:
        source_mask = source_voiced & (source_times / 1000 >= start) & (source_times / 1000 <= end)
        output_mask = rendered_voiced & (rendered_times / 1000 >= start) & (rendered_times / 1000 <= end)
        expected_source = np.interp(
            np.median(source_times[source_mask]) / 1000,
            [0.0, 0.6, 1.5],
            [180.0, 330.0, 200.0],
        )
        assert abs(float(np.median(source_pitch[source_mask])) - expected_source) < 7
        assert abs(float(np.median(rendered_pitch[output_mask])) - 220) <= 5
    rms_ratios = [
        np.sqrt(np.mean(np.square(rendered[start : start + 320])))
        / max(1e-9, np.sqrt(np.mean(np.square(samples[start : start + 320]))))
        for start in range(round(0.1 * sample_rate), round(1.4 * sample_rate), 320)
    ]
    assert min(rms_ratios) > 0.6


def test_pitch_point_renderer_corrects_steep_chirp_to_high_target() -> None:
    sample_rate = 16000
    times = np.arange(round(1.5 * sample_rate), dtype=np.float64) / sample_rate
    source_f0 = np.interp(times, [0.0, 0.6, 1.5], [180.0, 330.0, 200.0])
    samples = (0.5 * np.sin(2 * np.pi * np.cumsum(source_f0) / sample_rate)).astype(np.float32)
    unit = _test_phone("high-chirp", 0, 1500, 1500)
    target_midi = 69 + 12 * np.log2(440 / 440)
    group = ([PhonePitchPoint(0, target_midi), PhonePitchPoint(1, target_midi)], 0.0, 1500.0)

    rendered = _render_phone_pitch_points(
        samples, unit, group, 0.0, 1500.0, 69 + 12 * np.log2(250 / 440)
    )
    frequencies, voiced, frame_times = autotune._estimate_f0(rendered, sample_rate)
    windows = ((0.18, 0.38), (0.48, 0.68), (0.78, 0.98), (1.08, 1.28), (1.25, 1.45))
    for start, end in windows:
        selected = voiced & (frame_times / 1000 >= start) & (frame_times / 1000 <= end)
        assert abs(float(np.median(frequencies[selected])) - 440) < 5
    rms_ratios = [
        np.sqrt(np.mean(np.square(rendered[start : start + 320])))
        / max(1e-9, np.sqrt(np.mean(np.square(samples[start : start + 320]))))
        for start in range(round(0.1 * sample_rate), round(1.4 * sample_rate), 320)
    ]
    assert min(rms_ratios) > 0.6


def test_pitch_point_renderer_keeps_static_offset_target_accurate() -> None:
    sample_rate = 16000
    samples = (0.5 * np.sin(2 * np.pi * 432 * np.arange(sample_rate) / sample_rate)).astype(np.float32)
    unit = replace(_test_phone("static", 0, 1000, 1000), source_f0_hz=432)
    group = ([PhonePitchPoint(0, 69), PhonePitchPoint(1, 69)], 0.0, 1000.0)
    target_hz = 440 * 2 ** (40 / 1200)

    rendered = _render_phone_pitch_points(
        samples,
        unit,
        group,
        0.0,
        1000.0,
        69,
        np.full(len(samples), 40, dtype=np.float32),
    )
    frequencies, voiced, _ = autotune._estimate_f0(rendered, sample_rate)

    assert abs(float(np.median(frequencies[voiced])) - target_hz) < 4


def test_pitch_point_renderer_preserves_curve_in_short_voiced_phone() -> None:
    sample_rate = 16000
    source_hz = 220.0
    target_hz = 330.0
    samples = (0.5 * np.sin(2 * np.pi * source_hz * np.arange(1280) / sample_rate)).astype(np.float32)
    unit = _test_phone("short-curve", 0, 80, 80)
    source_midi = 69 + 12 * np.log2(source_hz / 440)
    target_midi = 69 + 12 * np.log2(target_hz / 440)
    group = (
        [
            PhonePitchPoint(0.0, source_midi),
            PhonePitchPoint(0.4, source_midi),
            PhonePitchPoint(0.41, target_midi),
            PhonePitchPoint(1.0, target_midi),
        ],
        0.0,
        80.0,
    )

    rendered = _render_phone_pitch_points(samples, unit, group, 0.0, 80.0, source_midi)
    frequencies, voiced, frame_times = autotune._estimate_f0(rendered, sample_rate)
    early = voiced & (frame_times <= 20)
    late = voiced & (frame_times >= 60)

    assert np.any(early) and np.any(late)
    assert abs(float(np.median(frequencies[early])) - source_hz) < 20
    assert abs(float(np.median(frequencies[late])) - target_hz) < 25


def test_local_pitch_curve_preserves_tone_through_final_aligned_frame() -> None:
    sample_rate = 16000
    samples = (0.5 * np.sin(2 * np.pi * 220 * np.arange(sample_rate) / sample_rate)).astype(np.float32)
    cents = np.linspace(0, 50, len(samples), dtype=np.float32)

    rendered = render_local_pitch_curve(samples, cents)

    source_rms = np.sqrt(np.mean(np.square(samples[-80:])))
    rendered_rms = np.sqrt(np.mean(np.square(rendered[-80:])))
    assert len(rendered) == len(samples)
    assert np.isfinite(rendered).all()
    assert rendered_rms / source_rms > 0.7


def test_strength_speed_and_fractional_region_base() -> None:
    f0 = np.full(100, 440.0)
    voiced = np.ones(100, dtype=bool)
    frame_times = np.arange(100) * 10 + 20
    region = [EditRegion("r", 0, 1000, 1500, relative_pitch_cents=30)]
    full = autotune._region_envelope(region, 1500, 0, f0, voiced, frame_times, 100, 0)
    zero = autotune._region_envelope(region, 1500, 0, f0, voiced, frame_times, 0, 0)
    slow = autotune._region_envelope(region, 1500, 0, f0, voiced, frame_times, 100, 500)
    assert min(point.cents for point in full) == -30
    assert {point.cents for point in zero} == {0}
    assert full[-1].cents != slow[-1].cents


def test_unvoiced_frames_are_zero_anchors_and_region_positions_follow_stretch() -> None:
    f0 = np.full(100, 432.0)
    voiced = np.ones(100, dtype=bool)
    voiced[30:70] = False
    f0[~voiced] = 0
    frame_times = np.arange(100) * 10 + 20
    regions = [
        EditRegion("a", 0, 400, 800),
        EditRegion("b", 400, 1000, 400),
    ]
    points = autotune._region_envelope(regions, 1200, 0, f0, voiced, frame_times, 100, 0)
    silent = [point for point in points if point.cents == 0 and 0.5 <= point.position <= 0.9]
    assert len(silent) == 2
    assert abs(silent[0].position - 0.5) < 0.04
    assert abs(silent[1].position - 5 / 6) < 0.02


def test_sub_frame_region_returns_both_envelope_endpoints() -> None:
    points = autotune._region_envelope(
        [EditRegion("short", 0, 1, 1)],
        1,
        0,
        np.asarray([432.0]),
        np.asarray([True]),
        np.asarray([0.5]),
        100,
        0,
    )
    assert [point.position for point in points] == [0.0, 1.0]


def test_generated_curve_corrects_original_audio_and_preserves_length(tmp_path, monkeypatch) -> None:
    sample_rate = 16000
    times = np.arange(sample_rate, dtype=np.float64) / sample_rate
    source = (0.5 * np.sin(2 * np.pi * 432 * times)).astype(np.float32)
    audio_path = tmp_path / "source.wav"
    with wave.open(str(audio_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes((source * 32767).astype("<i2").tobytes())
    monkeypatch.setattr(autotune, "audio_path", lambda _directory, _source_id: audio_path)
    from madnolia.types.common import MatchStatus, TimelineSegment

    segment = TimelineSegment(
        segment_id="seg",
        candidate_id="candidate",
        target_start_index=0,
        target_end_index=1,
        source_id="source",
        source_start_ms=0,
        source_end_ms=1000,
        timeline_start_ms=0,
        timeline_end_ms=1000,
        match_status=MatchStatus.EXACT,
        target_ipa=[],
        matched_ipa=[],
        edit_regions=[EditRegion("r", 0, 1000, 1000)],
        phone_units=[_test_phone("first", 0, 500, 500), _test_phone("second", 500, 1000, 500)],
    )
    result = autotune.generate_autotune_envelopes(tmp_path, [segment], 100, 0)[0]
    rendered = _render_edit_regions(audio_path, replace(segment, phone_units=result.phone_units, edit_regions=result.edit_regions))
    assert len(rendered) == len(source)
    middle = rendered[4000:12000]
    spectrum = np.abs(np.fft.rfft(middle * np.hanning(len(middle))))
    frequency = np.fft.rfftfreq(len(middle), 1 / sample_rate)[np.argmax(spectrum)]
    assert abs(frequency - 440) < 3


def test_changing_tones_map_to_stretched_region_positions(tmp_path, monkeypatch) -> None:
    sample_rate = 16000
    times = np.arange(sample_rate) / sample_rate
    source = np.concatenate(
        (
            0.5 * np.sin(2 * np.pi * 432 * times[:8000]),
            0.5 * np.sin(2 * np.pi * 448 * times[:8000]),
        )
    ).astype(np.float32)
    audio_path = tmp_path / "source.wav"
    with wave.open(str(audio_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes((source * 32767).astype("<i2").tobytes())
    monkeypatch.setattr(autotune, "audio_path", lambda _directory, _source_id: audio_path)
    from madnolia.types.common import MatchStatus, TimelineSegment

    segment = TimelineSegment(
        segment_id="seg",
        candidate_id="candidate",
        target_start_index=0,
        target_end_index=1,
        source_id="source",
        source_start_ms=0,
        source_end_ms=1000,
        timeline_start_ms=0,
        timeline_end_ms=1250,
        match_status=MatchStatus.EXACT,
        target_ipa=[],
        matched_ipa=[],
        phone_units=[_test_phone("merged", 0, 1000, 1250)],
        user_guide_source_ms=[500],
        edit_regions=[
            EditRegion("a", 0, 500, 500),
            EditRegion("b", 500, 1000, 750),
        ],
    )
    result = autotune.generate_autotune_envelopes(tmp_path, [segment], 100, 0)[0]
    assert all(not unit.pitch_points and unit.pitch_owner_ref is None for unit in result.phone_units)
    assert all(len(region.pitch_points) > 2 for region in result.edit_regions)
    assert all(region.pitch_points[0].position == 0 for region in result.edit_regions)
    assert all(region.pitch_points[-1].position == 1 for region in result.edit_regions)
    assert [(region.source_start_ms, region.source_end_ms) for region in result.edit_regions] == [(0, 500), (500, 1000)]
    assert result.edit_regions[0].region_id == "a" and result.edit_regions[1].region_id == "b"
    assert segment.user_guide_source_ms == [500]
    assert [region.output_duration_ms for region in result.edit_regions] == [500, 750]
    rendered = _render_edit_regions(audio_path, replace(segment, phone_units=result.phone_units, edit_regions=result.edit_regions))
    assert len(rendered) == round(1250 * sample_rate / 1000)
    assert round(result.edit_regions[0].output_duration_ms * sample_rate / 1000) == 8000
    for start, end in ((0.08, 0.32), (0.55, 0.9)):
        clip = rendered[round(start * sample_rate) : round(end * sample_rate)]
        spectrum = np.abs(np.fft.rfft(clip * np.hanning(len(clip))))
        frequency = np.fft.rfftfreq(len(clip), 1 / sample_rate)[np.argmax(spectrum)]
        assert abs(frequency - 440) < 5


def test_region_autotune_strength_zero_is_passthrough_and_speed_changes_contour(tmp_path, monkeypatch) -> None:
    sample_rate = 16000
    frequency = np.linspace(430, 450, sample_rate)
    phase = 2 * np.pi * np.cumsum(frequency) / sample_rate
    source = sum(
        (0.45 / harmonic) * np.sin(harmonic * phase + harmonic * 0.17)
        for harmonic in range(1, 9)
    ).astype(np.float32)
    source *= 0.45 / np.max(np.abs(source))
    audio_path = tmp_path / "source.wav"
    with wave.open(str(audio_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes((source * 32767).astype("<i2").tobytes())
    monkeypatch.setattr(autotune, "audio_path", lambda *_args: audio_path)
    monkeypatch.setattr(exporters, "audio_path", lambda *_args: audio_path)
    segment = TimelineSegment(
        segment_id="segment",
        candidate_id="candidate",
        target_start_index=0,
        target_end_index=1,
        source_id="source",
        source_start_ms=0,
        source_end_ms=1000,
        timeline_start_ms=0,
        timeline_end_ms=1000,
        match_status=MatchStatus.EXACT,
        target_ipa=["a"],
        matched_ipa=["a"],
        edit_regions=[EditRegion("region", 0, 1000, 1000)],
    )

    untouched = autotune.generate_autotune_envelopes(tmp_path, [segment], 0, 0)[0]
    assert untouched.edit_regions[0].pitch_points == []
    monkeypatch.setattr(
        exporters,
        "render_world_regions",
        lambda *_args, **_kwargs: pytest.fail("an unchanged region must bypass WORLD synthesis"),
    )
    assert np.array_equal(
        _render_segment_audio(
            tmp_path,
            CompositionMode.PROFESSIONAL,
            replace(segment, edit_regions=untouched.edit_regions),
            len(source),
        ),
        read_exact_region_audio(audio_path, segment.edit_regions),
    )

    fast = autotune.generate_autotune_envelopes(tmp_path, [segment], 100, 0)[0]
    slow = autotune.generate_autotune_envelopes(tmp_path, [segment], 100, 250)[0]
    fast_points = fast.edit_regions[0].pitch_points
    slow_points = slow.edit_regions[0].pitch_points
    assert len(fast_points) == len(slow_points) > 2
    assert max(abs(left.midi - right.midi) for left, right in zip(fast_points, slow_points, strict=True)) > 0.2


def test_region_curve_tracks_changing_pitch_and_preserves_silence(tmp_path, monkeypatch) -> None:
    sample_rate = 16000
    frequencies = np.concatenate((np.full(5000, 180), np.full(5000, 330), np.full(6000, 200)))
    phase = 2 * np.pi * np.cumsum(frequencies) / sample_rate
    source = sum(
        (0.45 / harmonic) * np.sin(harmonic * phase + harmonic * 0.17)
        for harmonic in range(1, 9)
    ).astype(np.float32)
    source *= 0.45 / np.max(np.abs(source))
    source[7000:8500] = 0
    audio_path = tmp_path / "source.wav"
    with wave.open(str(audio_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes((source * 32767).astype("<i2").tobytes())
    monkeypatch.setattr(autotune, "audio_path", lambda *_args: audio_path)
    region = EditRegion(
        "region",
        0,
        1000,
        1000,
        pitch_points=[PhonePitchPoint(0, 69), PhonePitchPoint(1, 69)],
    )
    segment = TimelineSegment(
        segment_id="segment",
        candidate_id="candidate",
        target_start_index=0,
        target_end_index=1,
        source_id="source",
        source_start_ms=0,
        source_end_ms=1000,
        timeline_start_ms=0,
        timeline_end_ms=1000,
        match_status=MatchStatus.EXACT,
        target_ipa=[],
        matched_ipa=[],
        edit_regions=[region],
    )
    rendered = _render_edit_regions(audio_path, segment)
    assert len(rendered) == len(source)
    assert np.max(np.abs(rendered[7600:8000])) < 1e-3
    for start, end in ((0.12, 0.28), (0.36, 0.42), (0.62, 0.68), (0.78, 0.92)):
        clip = rendered[round(start * sample_rate) : round(end * sample_rate)]
        spectrum = np.abs(np.fft.rfft(clip * np.hanning(len(clip))))
        frequency = np.fft.rfftfreq(len(clip), 1 / sample_rate)[np.argmax(spectrum)]
        assert abs(frequency - 440) < 10


def test_unvoiced_region_prefers_following_contiguous_segment_target(tmp_path, monkeypatch) -> None:
    sample_rate = 16000
    samples = np.zeros(32000, dtype=np.float32)
    left_times = np.arange(8000) / sample_rate
    right_times = np.arange(16000) / sample_rate
    samples[:8000] = 0.45 * np.sin(2 * np.pi * 220 * left_times)
    samples[16000:] = 0.45 * np.sin(2 * np.pi * 330 * right_times)
    audio_path = tmp_path / "source.wav"
    with wave.open(str(audio_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes((samples * 32767).astype("<i2").tobytes())
    monkeypatch.setattr(autotune, "audio_path", lambda *_args: audio_path)

    def segment(segment_id, source_start, source_end, timeline_start, timeline_end, regions):
        return TimelineSegment(
            segment_id=segment_id,
            candidate_id="candidate",
            target_start_index=0,
            target_end_index=1,
            source_id="source",
            source_start_ms=source_start,
            source_end_ms=source_end,
            timeline_start_ms=timeline_start,
            timeline_end_ms=timeline_end,
            match_status=MatchStatus.EXACT,
            target_ipa=[],
            matched_ipa=[],
            edit_regions=regions,
        )

    first = segment(
        "first", 0, 1000, 0, 1000,
        [EditRegion("voiced", 0, 500, 500), EditRegion("unvoiced", 500, 1000, 500)],
    )
    second = segment("second", 1000, 2000, 1000, 2000, [EditRegion("next-vowel", 1000, 2000, 1000)])
    first_result, second_result = autotune.generate_autotune_envelopes(tmp_path, [first, second], 100, 0)
    assert first_result.edit_regions[1].source_f0_hz is None
    assert first_result.edit_regions[1].pitch_points[0].midi == pytest.approx(
        second_result.edit_regions[0].pitch_points[0].midi
    )
    assert first_result.edit_regions[1].pitch_points[0].midi != pytest.approx(
        first_result.edit_regions[0].pitch_points[0].midi
    )


def test_region_pitch_graph_matches_render_with_relative_pitch_and_vibrato(tmp_path, monkeypatch) -> None:
    sample_rate = 16000
    times = np.arange(sample_rate) / sample_rate
    source = (0.45 * np.sin(2 * np.pi * 440 * times)).astype(np.float32)
    audio_path = tmp_path / "source.wav"
    with wave.open(str(audio_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes((source * 32767).astype("<i2").tobytes())
    monkeypatch.setattr(autotune, "audio_path", lambda *_args: audio_path)
    unit = replace(_test_phone("vowel", 0, 1000, 1000), vibrato_depth_cents=30, vibrato_rate_hz=5)
    segment = TimelineSegment(
        segment_id="segment",
        candidate_id="candidate",
        target_start_index=0,
        target_end_index=1,
        source_id="source",
        source_start_ms=0,
        source_end_ms=1000,
        timeline_start_ms=0,
        timeline_end_ms=1000,
        match_status=MatchStatus.EXACT,
        target_ipa=[],
        matched_ipa=[],
        phone_units=[unit],
        edit_regions=[EditRegion(
            "region", 0, 1000, 1000, relative_pitch_cents=100,
            pitch_points=[PhonePitchPoint(0, 69), PhonePitchPoint(1, 69)],
        )],
        pitch_envelope=[autotune.PitchEnvelopePoint(0, 30), autotune.PitchEnvelopePoint(1, 30)],
    )
    graph = autotune.analyze_composition_pitch(tmp_path, [segment]).segments[0].regions[0]
    rendered = _render_edit_regions(audio_path, segment)
    rendered_f0, rendered_voiced, _ = autotune._estimate_f0(rendered, sample_rate)
    graph_f0 = np.asarray([point.hz for point in graph.corrected if point.hz is not None])
    assert np.median(graph_f0) == pytest.approx(np.median(rendered_f0[rendered_voiced]), rel=0.02)
    assert np.ptp(graph_f0) > 10


def test_partial_region_points_keep_other_region_offsets_in_graph(tmp_path, monkeypatch) -> None:
    sample_rate = 16000
    times = np.arange(sample_rate) / sample_rate
    source = (0.45 * np.sin(2 * np.pi * 440 * times)).astype(np.float32)
    audio_path = tmp_path / "source.wav"
    with wave.open(str(audio_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes((source * 32767).astype("<i2").tobytes())
    monkeypatch.setattr(autotune, "audio_path", lambda *_args: audio_path)
    segment = TimelineSegment(
        segment_id="segment",
        candidate_id="candidate",
        target_start_index=0,
        target_end_index=1,
        source_id="source",
        source_start_ms=0,
        source_end_ms=1000,
        timeline_start_ms=0,
        timeline_end_ms=1000,
        match_status=MatchStatus.EXACT,
        target_ipa=[],
        matched_ipa=[],
        edit_regions=[
            EditRegion("manual", 0, 500, 500, pitch_points=[PhonePitchPoint(0, 69), PhonePitchPoint(1, 69)]),
            EditRegion("relative", 500, 1000, 500, relative_pitch_cents=120),
        ],
    )
    graph = autotune.analyze_composition_pitch(tmp_path, [segment]).segments[0].regions
    second_original = [point.hz for point in graph[1].original if point.hz is not None]
    second = [point.hz for point in graph[1].corrected if point.hz is not None]
    assert np.median(second) == pytest.approx(np.median(second_original) * 2 ** (120 / 1200), rel=0.01)


def test_autotune_skips_targeted_phone_and_corrects_untargeted_phone(tmp_path, monkeypatch) -> None:
    sample_rate = 16000
    times = np.arange(sample_rate, dtype=np.float64) / sample_rate
    source = (0.5 * np.sin(2 * np.pi * 432 * times)).astype(np.float32)
    audio_path = tmp_path / "source.wav"
    with wave.open(str(audio_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes((source * 32767).astype("<i2").tobytes())
    monkeypatch.setattr(autotune, "audio_path", lambda _directory, _source_id: audio_path)
    targeted = PhoneUnit(
        phone_unit_id="targeted",
        operation=PhoneAlignmentOperation.MATCH,
        target_index=0,
        target_phone_id="a",
        target_ipa="a",
        source_occurrence_id="targeted",
        source_phone_id="a",
        source_ipa="a",
        source_start_ms=100,
        source_end_ms=300,
        output_duration_ms=200,
        target_pitch_midi=69,
    )
    untargeted = replace(
        targeted,
        phone_unit_id="untargeted",
        target_index=1,
        source_occurrence_id="untargeted",
        source_start_ms=500,
        source_end_ms=900,
        output_duration_ms=400,
        target_pitch_midi=None,
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
        phone_units=[targeted, untargeted],
        edit_regions=[EditRegion("region", 0, 1000, 1000)],
    )

    result = autotune.generate_autotune_envelopes(tmp_path, [segment], 100, 0)[0]
    assert all(not unit.pitch_points and unit.pitch_owner_ref is None for unit in result.phone_units)
    assert result.edit_regions[0].source_f0_hz is not None
    assert result.edit_regions[0].pitch_points[0].midi == pytest.approx(69, abs=0.1)


def test_unvoiced_units_attach_to_next_vowel_then_previous_vowel(tmp_path, monkeypatch) -> None:
    sample_rate = 16000
    sample_count = 700 * 16
    samples = np.zeros(sample_count, dtype=np.float32)
    tone_times = np.arange(400 * 16) / sample_rate
    samples[100 * 16:500 * 16] = 0.5 * np.sin(2 * np.pi * 220 * tone_times)
    audio_path = tmp_path / "source.wav"
    with wave.open(str(audio_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes((samples * 32767).astype("<i2").tobytes())
    monkeypatch.setattr(autotune, "audio_path", lambda _directory, _source_id: audio_path)

    unvoiced_before = replace(_test_phone("h", 0, 100, 100), target_phone_id="ko.consonant.glottal.fricative", source_phone_id="ko.consonant.glottal.fricative", target_ipa="h", source_ipa="h", target_pitch_midi=72)
    vowel = replace(_test_phone("vowel", 100, 500, 400), source_f0_hz=220)
    unvoiced_after = replace(_test_phone("s", 500, 700, 200), target_phone_id="ko.consonant.alveolar.fricative", source_phone_id="ko.consonant.alveolar.fricative", target_ipa="s", source_ipa="s", target_pitch_midi=72)
    segment = TimelineSegment(
        segment_id="segment",
        candidate_id="candidate",
        target_start_index=0,
        target_end_index=3,
        source_id="source",
        source_start_ms=0,
        source_end_ms=700,
        timeline_start_ms=0,
        timeline_end_ms=700,
        match_status=MatchStatus.EXACT,
        target_ipa=["h", "a", "s"],
        matched_ipa=["h", "a", "s"],
        phone_units=[unvoiced_before, vowel, unvoiced_after],
        edit_regions=[EditRegion("region", 0, 700, 700)],
    )

    result = autotune.generate_autotune_envelopes(tmp_path, [segment], 100, 0)[0]
    before, owner, after = result.phone_units

    points = result.edit_regions[0].pitch_points
    assert len(points) > 2
    voiced_points = [point for point in points if 0 < point.position < 1]
    assert min(point.position for point in voiced_points) > 0.1
    assert max(point.position for point in voiced_points) < 0.75
    assert all(point.midi == pytest.approx(57, abs=0.15) for point in points)
    assert result.edit_regions[0].source_f0_hz == pytest.approx(220, abs=2)
    assert before.pitch_points == owner.pitch_points == after.pitch_points == []
    assert before.target_pitch_midi == 72
    assert after.target_pitch_midi == 72
    assert before.pitch_owner_ref is None
    assert after.pitch_owner_ref is None


def test_short_voiced_unit_uses_stored_source_f0_fallback() -> None:
    unit = replace(_test_phone("short-vowel", 10, 30, 20), source_f0_hz=220)
    segment = TimelineSegment(
        segment_id="segment",
        candidate_id="candidate",
        target_start_index=0,
        target_end_index=1,
        source_id="source",
        source_start_ms=0,
        source_end_ms=40,
        timeline_start_ms=0,
        timeline_end_ms=40,
        match_status=MatchStatus.EXACT,
        target_ipa=["a"],
        matched_ipa=["a"],
        phone_units=[unit],
    )

    assert autotune._unit_median_hz(
        unit, segment, np.zeros(0), np.zeros(0, dtype=bool), np.zeros(0)
    ) == 220


def _test_phone(phone_id: str, start: int, end: int, duration: int) -> PhoneUnit:
    return PhoneUnit(
        phone_unit_id=phone_id,
        operation=PhoneAlignmentOperation.MATCH,
        target_index=None,
        target_phone_id="ko.vowel.a",
        target_ipa="a",
        source_occurrence_id=phone_id,
        source_phone_id="ko.vowel.a",
        source_ipa="a",
        source_start_ms=start,
        source_end_ms=end,
        output_duration_ms=duration,
    )


def _spectral_peak(samples: np.ndarray, sample_rate: int) -> float:
    window = samples * np.hanning(len(samples))
    spectrum = np.abs(np.fft.rfft(window))
    frequencies = np.fft.rfftfreq(len(samples), 1 / sample_rate)
    band = (frequencies >= 100) & (frequencies <= 400)
    return float(frequencies[band][np.argmax(spectrum[band])])


def _pitch_offset_cents(phone, point_index: int) -> float:
    original = phone.original[point_index].hz
    corrected = phone.corrected[point_index].hz
    if original is None or corrected is None:
        return 0.0
    return float(1200 * np.log2(corrected / original))
