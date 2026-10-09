import argparse
import html
import json
import sys
import wave
from dataclasses import replace
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from madnolia.autotune import generate_autotune_envelopes
from madnolia.constants import (
    PITCH_COMPARISON_AUTOTUNE_SPEEDS_MS,
    PITCH_COMPARISON_AUTOTUNE_STRENGTHS,
    PITCH_COMPARISON_CLIP_DURATION_MS,
    PITCH_COMPARISON_CURRENT_CENTS,
    PITCH_COMPARISON_SAMPLE_RATE,
    PITCH_COMPARISON_WORLD_CENTS,
    PITCH_COMPARISON_WORLD_FRAME_PERIOD_MS,
)
from madnolia.exporters import _render_edit_regions
from madnolia.pitch_shift import render_relative_pitched_audio
from madnolia.projects import project_dir
from madnolia.types.common import EditRegion, MatchStatus, TimelineSegment


def read_mono(path):
    with wave.open(str(path), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError(f"Expected mono 16-bit PCM WAV: {path}")
        rate = audio.getframerate()
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").astype(np.float32)
    return samples / 32768.0, rate


def write_mono(path, samples, rate):
    pcm = np.round(np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(pcm.tobytes())


def world_renders(samples, rate, cents_values, pyworld):
    frame_period = PITCH_COMPARISON_WORLD_FRAME_PERIOD_MS
    source64 = samples.astype(np.float64)
    f0, times = pyworld.dio(source64, rate, frame_period=frame_period)
    f0 = pyworld.stonemask(source64, f0, times, rate)
    spectrum = pyworld.cheaptrick(source64, f0, times, rate)
    aperiodicity = pyworld.d4c(source64, f0, times, rate)
    renders = {}
    for cents in cents_values:
        synthesis_f0 = f0.copy()
        synthesis_f0[synthesis_f0 > 0] *= 2.0 ** (cents / 1200.0)
        rendered = pyworld.synthesize(synthesis_f0, spectrum, aperiodicity, rate, frame_period)
        if len(rendered) < len(samples):
            rendered = np.pad(rendered, (0, len(samples) - len(rendered)))
        renders[cents] = rendered[: len(samples)].astype(np.float32)
    return renders


def f0_summary(samples, rate, pyworld):
    f0, _ = pyworld.dio(
        samples.astype(np.float64),
        rate,
        frame_period=PITCH_COMPARISON_WORLD_FRAME_PERIOD_MS,
    )
    voiced = f0[f0 > 0]
    return {
        "voiced_frames": len(voiced),
        "median_f0_hz": round(float(np.median(voiced)), 3) if len(voiced) else None,
    }


def add_audio(path, label, samples, rate, pyworld, reference=None):
    output = path.with_suffix(".wav")
    write_mono(output, samples, rate)
    f0 = f0_summary(samples, rate, pyworld)
    reference_f0 = f0_summary(reference, rate, pyworld) if reference is not None else None
    median_f0_shift = None
    if f0["median_f0_hz"] and reference_f0 and reference_f0["median_f0_hz"]:
        median_f0_shift = round(
            1200 * np.log2(f0["median_f0_hz"] / reference_f0["median_f0_hz"]), 2
        )
    return {
        "label": label,
        "file": output.name,
        "duration_ms": round(len(samples) * 1000 / rate, 1),
        "finite": bool(np.isfinite(samples).all()),
        "peak": round(float(np.max(np.abs(samples))) if len(samples) else 0, 6),
        "clipped_samples": int(np.count_nonzero(np.abs(samples) >= 0.999)),
        "f0": f0,
        "median_f0_shift_cents": median_f0_shift,
        "identity_rms_delta": round(float(np.sqrt(np.mean((samples - reference) ** 2))), 8)
        if reference is not None and len(samples) == len(reference)
        else None,
    }


def build_report(result, output):
    sections = []
    for item in result["clips"]:
        rows = "".join(
            "<tr><td>{}</td><td><audio controls preload='none' src='{}'></audio></td>"
            "<td>{} ms</td><td>{} Hz</td><td>{} ¢</td><td>{}</td><td>{}</td></tr>".format(
                html.escape(render["label"]),
                html.escape(render["file"]),
                render["duration_ms"],
                html.escape(str(render["f0"]["median_f0_hz"])),
                html.escape(str(render["median_f0_shift_cents"])),
                render["clipped_samples"],
                html.escape(str(render["identity_rms_delta"])),
            )
            for render in item["renders"]
        )
        sections.append(
            "<section><h2>{}</h2><p>{}</p><table><thead><tr><th>\uc774\ub984</th>"
            "<th>\ub4e3\uae30</th><th>\uae38\uc774</th><th>\uc911\uc559 F0</th>"
            "<th>\uc6d0\uc74c \ub300\ube44 F0 \uc774\ub3d9</th>"
            "<th>\ud074\ub9ac\ud551 \ud45c\ubcf8</th><th>\uc6d0\uc74c \ub300\ube44 RMS \ucc28\uc774</th>"
            "</tr></thead><tbody>{}</tbody></table></section>".format(
                html.escape(item["label"]), html.escape(item["source_note"]), rows
            )
        )
    speed_rows = "".join(
        "<tr><td>{}</td><td>{}</td><td>{}</td></tr>".format(
            html.escape(item["label"]),
            result["autotune_speed_equal"][item["composition_id"]]["0"],
            result["autotune_speed_equal"][item["composition_id"]]["100"],
        )
        for item in result["clips"]
    )
    notes = (
        "<p>\u2018\ud604\uc7ac 0\u00a2 \uc6b0\ud68c\u2019\ub294 \uc6d0\uc74c \ubcf5\uc0ac\uc774\uba70 "
        "\u2018WORLD 0\u00a2\u2019\ub294 WORLD \ubd84\uc11d\u00b7\uc7ac\ud569\uc131\uc785\ub2c8\ub2e4. "
        "WORLD\ub294 \uc6d0\ubcf8 16 kHz \ubaa8\ub178 \uc18c\uc2a4\ub9cc \uc0ac\uc6a9\ud569\ub2c8\ub2e4. "
        "\uace0\uc815 \uc774\ub3d9\uc740 \u221225\u00a2, +25\u00a2, +100\u00a2\uc785\ub2c8\ub2e4.</p>"
        "<p>\uc790\ub3d9 \ubcf4\uc815 \ube44\uad50\ub294 \uc800\uc7a5\ub41c \uc18c\uc2a4\uc758 "
        "4\ucd08 \uc6d0\uc74c \uad6c\uac04\uc744 \ud558\ub098\uc758 EditRegion\uc73c\ub85c "
        "\uad6c\uc131\ud574 \uacf5\uac1c generate_autotune_envelopes "
        "\uacb0\uacfc\ub97c \ud604\uc7ac EditRegion \ub80c\ub354\ub7ec\uc5d0 \uc801\uc6a9\ud588\uc2b5\ub2c8\ub2e4. "
        "\uac15\ub3c4 0/100%\uc640 \uc18d\ub3c4 0/200 ms\ub97c \ube44\uad50\ud569\ub2c8\ub2e4.</p>"
        "<p>\uc218\uce58\ub294 \uae38\uc774, \uc720\ud55c\uac12, \ud53c\ud06c, \ud074\ub9ac\ud551 \ud45c\ubcf8 "
        "\uc218, WORLD DIO \uc911\uc559 F0\uc640 \uc6d0\uc74c \ub300\ube44 F0 \uc774\ub3d9\uc785\ub2c8\ub2e4. "
        "DIO\ub294 \uc790\uc74c\u00b7\uc228\uc18c\ub9ac\u00b7"
        "\ubc18\uc8fc\ub97c \uc644\ubcbd\ud788 \ub098\ub204\uc9c0 \ubabb\ud558\ubbc0\ub85c F0\ub294 \uc9c4\ub2e8\uc6a9\uc774\uba70 "
        "\uc74c\uc9c8 \ud310\uc815\uc740 \uccad\ucde8\ub85c \ud574\uc57c \ud569\ub2c8\ub2e4.</p>"
    )
    (output / "index.html").write_text(
        "<!doctype html><html lang='ko'><meta charset='utf-8'>"
        "<title>\ud53c\uce58 \uc5d4\uc9c4 \uccad\ucde8 \ube44\uad50</title>"
        "<style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:0 20px;color:#222}"
        "section{border-top:1px solid #ccc;padding:16px 0}table{width:100%;border-collapse:collapse}"
        "th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd}audio{width:min(440px,45vw)}"
        "</style><h1>\ud53c\uce58 \uc5d4\uc9c4 \uccad\ucde8 \ube44\uad50</h1>"
        + notes
        + "".join(sections)
        + "<section><h2>\uc18d\ub3c4 \ube44\uad50 \uc77c\uce58 \uac80\uc0ac</h2>"
        + "<p>\uc18d\ub3c4 0 ms\uc640 200 ms \ub80c\ub354\ub9c1 \uacb0\uacfc\ub97c "
        + "np.array_equal\ub85c \ube44\uad50\ud588\uc2b5\ub2c8\ub2e4. True\ub294 "
        + "\uc0d8\ud50c\uc774 \ubaa8\ub450 \uc77c\uce58\ud568\uc744 \ub73b\ud569\ub2c8\ub2e4.</p>"
        + "<table><tr><th>\ud504\ub85c\uc81d\ud2b8</th><th>\uac15\ub3c4 0%</th>"
        + "<th>\uac15\ub3c4 100%</th></tr>"
        + speed_rows
        + "</table></section>"
        + "</html>",
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
    result = {
        "method": "WORLD DIO/StoneMask/CheapTrick/D4C",
        "clips": [],
        "autotune_speed_equal": {},
    }
    for clip_index, entry in enumerate(manifest["clips"]):
        source_path = Path(entry["audio_path"])
        full_audio, rate = read_mono(source_path)
        if rate != PITCH_COMPARISON_SAMPLE_RATE:
            raise ValueError(f"Expected native 16 kHz audio: {source_path} ({rate})")
        start = max(0, round(entry["start_ms"] * rate / 1000))
        end = min(len(full_audio), round(entry["end_ms"] * rate / 1000))
        source = full_audio[start:end]
        duration_ms = round(len(source) * 1000 / rate)
        if duration_ms != PITCH_COMPARISON_CLIP_DURATION_MS:
            raise ValueError(f"Clip length differs from comparison setting: {entry['label']}")
        source_stats = pyworld
        renders = [
            add_audio(
                args.output / f"{clip_index:02d}-original",
                "\uc6d0\uc74c",
                source,
                rate,
                source_stats,
                source,
            ),
            add_audio(
                args.output / f"{clip_index:02d}-current-bypass",
                "\ud604\uc7ac \uc5d4\uc9c4 0\u00a2 \uc6b0\ud68c (\uc6d0\uc74c \ubcf5\uc0ac)",
                render_relative_pitched_audio(source, len(source), 0),
                rate,
                source_stats,
                source,
            ),
        ]
        for cents in PITCH_COMPARISON_CURRENT_CENTS:
            shifted = render_relative_pitched_audio(source, len(source), cents)
            renders.append(
                add_audio(
                    args.output / f"{clip_index:02d}-current-{cents:+d}c",
                    f"\ud604\uc7ac \uc5d4\uc9c4 {cents:+d}\u00a2",
                    shifted,
                    rate,
                    source_stats,
                    source,
                )
            )
        world_set = world_renders(source, rate, (0, *PITCH_COMPARISON_WORLD_CENTS), pyworld)
        renders.append(
            add_audio(
                args.output / f"{clip_index:02d}-world-0c",
                "WORLD 0\u00a2 (\uc804\uccb4 \uc7ac\ud569\uc131)",
                world_set[0],
                rate,
                source_stats,
                source,
            )
        )
        for cents in PITCH_COMPARISON_WORLD_CENTS:
            renders.append(
                add_audio(
                    args.output / f"{clip_index:02d}-world-{cents:+d}c",
                    f"WORLD +{cents}\u00a2",
                    world_set[cents],
                    rate,
                    source_stats,
                    source,
                )
            )

        project = project_dir(entry["project_id"])
        source_start_ms = start * 1000 // rate
        source_end_ms = end * 1000 // rate
        segment = TimelineSegment(
            segment_id=f"comparison-{clip_index}",
            candidate_id="comparison",
            target_start_index=0,
            target_end_index=1,
            source_id=entry["source_id"],
            source_start_ms=source_start_ms,
            source_end_ms=source_end_ms,
            timeline_start_ms=0,
            timeline_end_ms=duration_ms,
            match_status=MatchStatus.EXACT,
            target_ipa=[],
            matched_ipa=[],
            edit_regions=[
                EditRegion("comparison-region", source_start_ms, source_end_ms, duration_ms)
            ],
        )
        autotune_outputs = {}
        for strength in PITCH_COMPARISON_AUTOTUNE_STRENGTHS:
            for speed in PITCH_COMPARISON_AUTOTUNE_SPEEDS_MS:
                tuned = generate_autotune_envelopes(project, [segment], strength, speed)[0]
                tuned_segment = replace(segment, edit_regions=tuned.edit_regions)
                rendered = _render_edit_regions(source_path, tuned_segment, project)
                autotune_outputs[(strength, speed)] = rendered
                renders.append(
                    add_audio(
                        args.output / f"{clip_index:02d}-autotune-s{strength}-v{speed}",
                        f"\ud604\uc7ac \uc790\ub3d9 \ubcf4\uc815 \uac15\ub3c4 {strength}% "
                        f"\u00b7 \uc18d\ub3c4 {speed}ms",
                        rendered,
                        rate,
                        source_stats,
                        source,
                    )
                )
        result["autotune_speed_equal"][entry["composition_id"]] = {
            str(strength): bool(
                np.array_equal(
                    autotune_outputs[(strength, PITCH_COMPARISON_AUTOTUNE_SPEEDS_MS[0])],
                    autotune_outputs[(strength, PITCH_COMPARISON_AUTOTUNE_SPEEDS_MS[1])],
                )
            )
            for strength in PITCH_COMPARISON_AUTOTUNE_STRENGTHS
        }
        result["clips"].append(
            {
                "label": entry["label"],
                "composition_id": entry["composition_id"],
                "source_note": (
                    f"{entry['composition_name']} \u00b7 {entry['composition_id']} \u00b7 "
                    f"source {entry['source_id']} \u00b7 {entry['start_ms']}\u2013{entry['end_ms']} ms"
                ),
                "renders": renders,
            }
        )
    result["manifest"] = str(args.manifest)
    (args.output / "metrics.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    build_report(result, args.output)
    print(
        json.dumps(
            {
                "clips": len(result["clips"]),
                "renders": sum(len(item["renders"]) for item in result["clips"]),
                "output": str(args.output / "index.html"),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
