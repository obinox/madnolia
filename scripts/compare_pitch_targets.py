import argparse
import html
import json
import sys
import wave
from dataclasses import replace
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from madnolia.compositions import load_composition
from madnolia.constants import (
    PITCH_COMPARISON_SAMPLE_RATE,
    PITCH_COMPARISON_WORLD_FRAME_PERIOD_MS,
    PITCH_TARGET_COMPARISON_CONTEXT_MS,
    PITCH_TARGET_COMPARISON_PEAK_LIMIT,
)
from madnolia.exporters import _render_edit_regions
from madnolia.projects import audio_path, project_dir
from madnolia.types.common import EditRegion, PhonePitchPoint


def read_audio(path, start_ms=0, end_ms=None):
    with wave.open(str(path), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError(f"Expected mono 16-bit PCM WAV: {path}")
        rate = audio.getframerate()
        total = audio.getnframes()
        start = min(total, max(0, round(start_ms * rate / 1000)))
        end = total if end_ms is None else min(total, max(start, round(end_ms * rate / 1000)))
        audio.setpos(start)
        data = np.frombuffer(audio.readframes(end - start), dtype="<i2").astype(np.float32)
    return data / 32768.0, rate


def write_audio(path, samples, rate):
    pcm = np.round(np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(pcm.tobytes())


def estimate_f0(samples, rate, pyworld):
    f0, times = pyworld.dio(
        samples.astype(np.float64),
        rate,
        frame_period=PITCH_COMPARISON_WORLD_FRAME_PERIOD_MS,
    )
    f0 = pyworld.stonemask(samples.astype(np.float64), f0, times, rate)
    return f0, times


def first_vowel(composition):
    for segment_index, segment in enumerate(composition.segments):
        for unit in segment.phone_units:
            if (
                unit.source_start_ms is not None
                and unit.source_end_ms is not None
                and unit.source_phone_id
                and ".vowel." in unit.source_phone_id
            ):
                return segment_index, segment, unit
    raise ValueError(f"No mapped source vowel found in {composition.composition_id}")


def measure_reference(composition, project, pyworld):
    segment_index, segment, unit = first_vowel(composition)
    path = audio_path(project, segment.source_id)
    source_start = max(0, unit.source_start_ms - PITCH_TARGET_COMPARISON_CONTEXT_MS)
    source_end = unit.source_end_ms + PITCH_TARGET_COMPARISON_CONTEXT_MS
    samples, rate = read_audio(path, source_start, source_end)
    if rate != PITCH_COMPARISON_SAMPLE_RATE:
        raise ValueError(f"Expected native 16 kHz audio for {composition.composition_id}: {rate}")
    f0, times = estimate_f0(samples, rate, pyworld)
    absolute_times_ms = times * 1000 + source_start
    selected = (
        (absolute_times_ms >= unit.source_start_ms)
        & (absolute_times_ms < unit.source_end_ms)
        & (f0 > 0)
    )
    if not np.any(selected):
        raise ValueError(
            f"No WORLD voiced frame inside first vowel {unit.source_ipa} "
            f"{unit.source_start_ms}-{unit.source_end_ms}ms in {composition.composition_id}"
        )
    target_hz = float(np.median(f0[selected]))
    return {
        "segment_index": segment_index,
        "source_id": segment.source_id,
        "ipa": unit.source_ipa,
        "start_ms": unit.source_start_ms,
        "end_ms": unit.source_end_ms,
        "voiced_frames": int(np.count_nonzero(selected)),
        "target_hz": target_hz,
        "context_start_ms": source_start,
        "context_end_ms": source_end,
    }


def world_segment(path, segment, target_hz, pyworld):
    context_start = max(0, segment.source_start_ms - PITCH_TARGET_COMPARISON_CONTEXT_MS)
    context_end = segment.source_end_ms + PITCH_TARGET_COMPARISON_CONTEXT_MS
    context, rate = read_audio(path, context_start, context_end)
    if rate != PITCH_COMPARISON_SAMPLE_RATE:
        raise ValueError(f"Expected native 16 kHz audio for {path}: {rate}")
    source64 = context.astype(np.float64)
    f0, times = pyworld.dio(
        source64,
        rate,
        frame_period=PITCH_COMPARISON_WORLD_FRAME_PERIOD_MS,
    )
    f0 = pyworld.stonemask(source64, f0, times, rate)
    spectrum = pyworld.cheaptrick(source64, f0, times, rate)
    aperiodicity = pyworld.d4c(source64, f0, times, rate)
    inside = (
        (times * 1000 + context_start >= segment.source_start_ms)
        & (times * 1000 + context_start < segment.source_end_ms)
    )
    target_f0 = f0.copy()
    target_f0[inside & (target_f0 > 0)] = target_hz
    baseline = pyworld.synthesize(
        f0, spectrum, aperiodicity, rate, PITCH_COMPARISON_WORLD_FRAME_PERIOD_MS
    )
    tuned = pyworld.synthesize(
        target_f0,
        spectrum,
        aperiodicity,
        rate,
        PITCH_COMPARISON_WORLD_FRAME_PERIOD_MS,
    )
    start = round((segment.source_start_ms - context_start) * rate / 1000)
    length = round((segment.source_end_ms - segment.source_start_ms) * rate / 1000)
    baseline = fit_length(baseline[start:], length)
    tuned = fit_length(tuned[start:], length)
    selected = inside & (f0 > 0)
    if np.any(selected) and not np.all(target_f0[selected] == target_hz):
        raise AssertionError("WORLD voiced target frames differ from the absolute reference")
    return baseline, tuned, int(np.count_nonzero(selected))


def fit_length(samples, length):
    if len(samples) >= length:
        return samples[:length].astype(np.float32)
    return np.pad(samples, (0, length - len(samples))).astype(np.float32)


def make_current_segment(segment, target_midi):
    points = [PhonePitchPoint(0.0, target_midi), PhonePitchPoint(1.0, target_midi)]
    region = EditRegion(
        region_id=f"target-{segment.segment_id}",
        source_start_ms=segment.source_start_ms,
        source_end_ms=segment.source_end_ms,
        output_duration_ms=segment.source_end_ms - segment.source_start_ms,
        relative_pitch_cents=0,
        pitch_points=points,
    )
    phones = [
        replace(
            unit,
            target_pitch_midi=None,
            target_pitch_strength_percent=0,
            formant_shift_semitones=0.0,
            vibrato_depth_cents=0,
            vibrato_rate_hz=0.0,
            vibrato_start_ms=0,
            pitch_points=[],
            pitch_owner_ref=None,
        )
        for unit in segment.phone_units
    ]
    return replace(
        segment,
        edit_regions=[region],
        phone_units=phones,
        pitch_envelope=[],
        volume_envelope=[],
        stretch_percent=100,
    )


def render_composition(composition, project, target_hz, pyworld):
    rate = PITCH_COMPARISON_SAMPLE_RATE
    original_chunks = []
    current_chunks = []
    world_zero_chunks = []
    world_target_chunks = []
    mappings = []
    target_frames = 0
    current_target_points = 0
    output_offset = 0
    target_midi = 69 + 12 * np.log2(target_hz / 440.0)
    for segment in composition.segments:
        path = audio_path(project, segment.source_id)
        source, source_rate = read_audio(path, segment.source_start_ms, segment.source_end_ms)
        if source_rate != rate:
            raise ValueError(f"Expected native 16 kHz source: {path}")
        expected_length = round((segment.source_end_ms - segment.source_start_ms) * rate / 1000)
        source = fit_length(source, expected_length)
        current_segment = make_current_segment(segment, target_midi)
        for region in current_segment.edit_regions:
            if (
                region.relative_pitch_cents != 0
                or len(region.pitch_points) != 2
                or any(point.midi != target_midi for point in region.pitch_points)
            ):
                raise AssertionError("Current renderer target points are not one absolute pitch")
            current_target_points += len(region.pitch_points)
        current = _render_edit_regions(path, current_segment)
        current = fit_length(current, expected_length)
        world_zero, world_target, voiced_frames = world_segment(
            path, segment, target_hz, pyworld
        )
        target_frames += voiced_frames
        original_chunks.append(source)
        current_chunks.append(current)
        world_zero_chunks.append(world_zero)
        world_target_chunks.append(world_target)
        for unit in segment.phone_units:
            if (
                unit.source_phone_id
                and ".vowel." in unit.source_phone_id
                and unit.source_start_ms is not None
                and unit.source_end_ms is not None
            ):
                start = output_offset + round((unit.source_start_ms - segment.source_start_ms) * rate / 1000)
                end = output_offset + round((unit.source_end_ms - segment.source_start_ms) * rate / 1000)
                if end > start:
                    mappings.append(
                        {
                            "ipa": unit.source_ipa,
                            "source_start_ms": unit.source_start_ms,
                            "source_end_ms": unit.source_end_ms,
                            "output_start_sample": start,
                            "output_end_sample": end,
                            "segment_id": segment.segment_id,
                        }
                    )
        output_offset += expected_length
    outputs = {
        "original": np.concatenate(original_chunks),
        "world_resynthesis": np.concatenate(world_zero_chunks),
        "current_target": np.concatenate(current_chunks),
        "world_target": np.concatenate(world_target_chunks),
    }
    if len({len(samples) for samples in outputs.values()}) != 1:
        raise AssertionError(
            f"Rendered lengths differ: {composition.composition_id} "
            f"{ {key: len(value) for key, value in outputs.items()} }"
        )
    return outputs, mappings, target_frames, current_target_points


def output_pitch_diagnostics(outputs, mappings, target_hz, pyworld):
    result = {}
    for variant, samples in outputs.items():
        f0, times = estimate_f0(samples, PITCH_COMPARISON_SAMPLE_RATE, pyworld)
        time_ms = times * 1000
        diagnostics = []
        for mapping in mappings:
            start_ms = mapping["output_start_sample"] * 1000 / PITCH_COMPARISON_SAMPLE_RATE
            end_ms = mapping["output_end_sample"] * 1000 / PITCH_COMPARISON_SAMPLE_RATE
            selected = (time_ms >= start_ms) & (time_ms < end_ms) & (f0 > 0)
            values = f0[selected]
            measured = float(np.median(values)) if len(values) else None
            cents_error = (
                float(1200 * np.log2(measured / target_hz)) if measured is not None else None
            )
            diagnostics.append(
                {
                    **mapping,
                    "voiced_frames": len(values),
                    "median_f0_hz": measured,
                    "cents_from_target": cents_error,
                }
            )
        result[variant] = diagnostics
    return result


def output_stats(samples, rate, peak_before_gain):
    return {
        "duration_ms": round(len(samples) * 1000 / rate, 1),
        "finite": bool(np.isfinite(samples).all()),
        "peak": float(np.max(np.abs(samples))) if len(samples) else 0.0,
        "peak_before_gain": peak_before_gain,
        "clipped_samples": int(np.count_nonzero(np.abs(samples) >= 0.999)),
    }


def create_html(compositions, output):
    parts = []
    for composition in compositions:
        target = f"{composition['reference']['target_hz']:.3f} Hz"
        audios = "".join(
            "<tr><td>{}</td><td><audio controls preload='none' src='{}'></audio></td>"
            "<td>{} ms</td><td>{}</td></tr>".format(
                html.escape(variant["label"]),
                html.escape(variant["file"]),
                variant["stats"]["duration_ms"],
                variant["stats"]["clipped_samples"],
            )
            for variant in composition["outputs"]
        )
        vowel_rows = "".join(
            "<tr><td>{}</td><td>{}</td><td>{}\u2013{} ms</td>{}</tr>".format(
                index + 1,
                html.escape(str(vowel["ipa"])),
                vowel["source_start_ms"],
                vowel["source_end_ms"],
                "".join(
                    "<td>{} Hz<br>{}\u00a2</td>".format(
                        "\u2014" if record["median_f0_hz"] is None else f"{record['median_f0_hz']:.2f}",
                        "\u2014" if record["cents_from_target"] is None else f"{record['cents_from_target']:+.1f}",
                    )
                    for record in (vowel[name] for name in ("original", "current_target", "world_target"))
                ),
            )
            for index, vowel in enumerate(composition["vowels"])
        )
        parts.append(
            "<section><h2>{}</h2><p class='target'>\uccab \ubaa8\uc74c /{}/: <strong>{}</strong> "
            "</p><p>\ubaa8\ub4e0 \uc74c\uc808\uc744 \uccab \uc74c\uc808\uc758 \ubaa9\ud45c\uc74c\uc5d0 \ub9de\ucd94\uc5b4 \ube44\uad50\ud569\ub2c8\ub2e4.</p>"
            "<table><tr><th>\ub80c\ub354</th><th>\ub4e3\uae30</th><th>\uae38\uc774</th><th>\ud074\ub9ac\ud551 \ud45c\ubcf8</th></tr>{}</table>"
            "<details><summary>\ubaa9\ud45c \uce21\uc815 \uc815\ubcf4</summary><p>WORLD DIO\u00b7StoneMask\uac00 \uccab \ubaa8\uc74c\uc5d0\uc11c "
            "{}\uac1c voiced frame\uc744 \uce21\uc815\ud574 {:.3f} Hz\ub97c \ubaa9\ud45c\ub85c \uc0bc\uc558\uc2b5\ub2c8\ub2e4. "
            "WORLD \ubaa9\ud45c \ud504\ub808\uc784 {}\uac1c\uc5d0 \uc774 \uc8fc\ud30c\uc218\ub97c \uc801\uc6a9\ud588\uc2b5\ub2c8\ub2e4. "
            "\uc74c\ud45c \uaca9\uc790 \ubc18\uc62c\ub9bc\uc740 \uc801\uc6a9\ud558\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4.</p></details>"
            "<details><summary>\ubaa8\uc74c\ubcc4 F0 \uce21\uc815 \u00b7 Hz / \ubaa9\ud45c \ub300\ube44 cents</summary>"
            "<table><tr><th>#</th><th>IPA</th><th>\uc18c\uc2a4 \uc704\uce58</th><th>\uc6d0\uc74c</th><th>\ud604\uc7ac \ub80c\ub354</th>"
            "<th>WORLD \ubaa9\ud45c</th></tr>{}</table></details></section>".format(
                html.escape(composition["name"]),
                html.escape(str(composition["reference"]["ipa"])),
                target,
                audios,
                composition["reference"]["voiced_frames"],
                composition["reference"]["target_hz"],
                composition["world_target_voiced_frames"],
                vowel_rows,
            )
        )
    notes = "<p>\uccab \uc74c\uc808\uc5d0 \ub9de\ucd98 \ubaa9\ud45c\uc74c\uc73c\ub85c \ubaa8\ub4e0 \uc74c\uc808\uc744 \ub9de\ucdb0 \ub4e3\ub294 \ube44\uad50\uc785\ub2c8\ub2e4. \uc6d0\uc74c\uacfc \ub450 \uc5d4\uc9c4 \uacb0\uacfc\ub97c \ub098\ub780\ud788 \ube44\uad50\ud558\uc138\uc694.</p>"
    (output / "index.html").write_text(
        "<!doctype html><html lang='ko'><meta charset='utf-8'><title>\uccab \uc74c\uc808\uc5d0 \ub9de\ucd98 \ube44\uad50</title>"
        "<style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:0 20px;color:#222}"
        "section{border-top:1px solid #ccc;padding:18px 0}.target{font-size:20px}"
        "table{width:100%;border-collapse:collapse;margin:10px 0}th,td{text-align:left;padding:7px;"
        "border-bottom:1px solid #ddd}audio{width:min(460px,45vw)}details{margin-top:16px}</style>"
        "<h1>\uccab \uc74c\uc808\uc5d0 \ub9de\ucd98 \ube44\uad50</h1>" + notes + "".join(parts) + "</html>",
        encoding="utf-8",
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pyworld-site", type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.pyworld_site.resolve()))
    import pyworld

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    args.output.mkdir(parents=True, exist_ok=True)
    report = {"settings": {"sample_rate": PITCH_COMPARISON_SAMPLE_RATE}, "compositions": []}
    html_compositions = []
    for composition_id in manifest["composition_ids"]:
        composition = load_composition(
            Path("data/collages") / composition_id / "collage.json"
        )
        project = project_dir(composition.corpus_project_id)
        reference = measure_reference(composition, project, pyworld)
        target_hz = reference["target_hz"]
        outputs, mappings, target_frames, current_target_points = render_composition(
            composition, project, target_hz, pyworld
        )
        peak_before_gain = {
            key: float(np.max(np.abs(samples))) for key, samples in outputs.items()
        }
        max_peak_before_gain = max(peak_before_gain.values())
        common_gain = (
            min(1.0, PITCH_TARGET_COMPARISON_PEAK_LIMIT / max_peak_before_gain)
            if max_peak_before_gain > 0
            else 1.0
        )
        outputs = {key: samples * common_gain for key, samples in outputs.items()}
        file_entries = []
        pcm_outputs = {}
        for key, samples in outputs.items():
            filename = f"{composition_id}-{key}.wav"
            output_path = args.output / filename
            write_audio(output_path, samples, PITCH_COMPARISON_SAMPLE_RATE)
            pcm_samples, pcm_rate = read_audio(output_path)
            if pcm_rate != PITCH_COMPARISON_SAMPLE_RATE or len(pcm_samples) != len(samples):
                raise AssertionError(f"PCM round-trip changed duration: {filename}")
            if not np.isfinite(pcm_samples).all():
                raise AssertionError(f"PCM round-trip produced non-finite audio: {filename}")
            pcm_outputs[key] = pcm_samples
        vowels = output_pitch_diagnostics(pcm_outputs, mappings, target_hz, pyworld)
        for key, samples in pcm_outputs.items():
            filename = f"{composition_id}-{key}.wav"
            if np.count_nonzero(np.abs(samples) >= 0.999):
                raise AssertionError(f"PCM output clips: {filename}")
            file_entries.append(
                {
                    "key": key,
                    "label": {
                        "original": "\uC6D0\uC74C",
                        "world_resynthesis": "WORLD \uBB34\uBCF4\uC815 \uC7AC\uD569\uC131",
                        "current_target": "\uD604\uC7AC \uC5D4\uC9C4 \u00B7 \uBAA8\uB4E0 \uC74C\uC808\uC744 \uCCAB \uC74C\uC808\uC5D0 \uB9DE\uCDA4",
                        "world_target": "WORLD \u00B7 \uBAA8\uB4E0 \uC74C\uC808\uC744 \uCCAB \uC74C\uC808\uC5D0 \uB9DE\uCDA4",
                    }[key],
                    "file": filename,
                    "stats": output_stats(
                        samples,
                        PITCH_COMPARISON_SAMPLE_RATE,
                        peak_before_gain[key],
                    ),
                    "vowels": vowels[key],
                }
            )
        html_vowels = []
        for index, mapping in enumerate(mappings):
            html_vowels.append(
                {
                    **mapping,
                    **{
                        variant: vowels[variant][index]
                        for variant in ("original", "current_target", "world_target")
                    },
                }
            )
        composition_result = {
            "composition_id": composition_id,
            "name": composition.name,
            "segments": len(composition.segments),
            "reference": reference,
            "target_midi_exact": float(69 + 12 * np.log2(target_hz / 440.0)),
            "common_gain": common_gain,
            "max_peak_before_gain": max_peak_before_gain,
            "world_target_voiced_frames": target_frames,
            "world_target_frames_constant_hz": True,
            "current_target_points_constant_midi": current_target_points,
            "outputs": file_entries,
            "vowels": html_vowels,
            "all_output_lengths_equal": len({len(samples) for samples in outputs.values()}) == 1,
        }
        report["compositions"].append(composition_result)
        html_compositions.append(composition_result)
        print(
            json.dumps(
                {
                    "composition": composition_id,
                    "reference_ipa": reference["ipa"],
                    "reference_hz": reference["target_hz"],
                    "reference_frames": reference["voiced_frames"],
                    "segments": len(composition.segments),
                    "duration_ms": file_entries[0]["stats"]["duration_ms"],
                },
                ensure_ascii=True,
            )
        )
    (args.output / "metrics.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    create_html(html_compositions, args.output)


if __name__ == "__main__":
    main()
