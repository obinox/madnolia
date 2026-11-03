import json
import subprocess
import sys
import tempfile
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pyworld


ROOT = Path(__file__).resolve().parents[2]
TESTS = ROOT / "web" / "tests" / "fixtures"


def source_commit(path):
    return subprocess.check_output(
        ["git", "log", "-1", "--format=%H", "legacy/python", "--", path],
        cwd=ROOT,
        text=True,
    ).strip()


def module_file(package, relative_path):
    target = package / "madnolia" / relative_path.removeprefix("src/madnolia/")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(subprocess.check_output(
        ["git", "show", f"legacy/python:{relative_path}"], cwd=ROOT
    ))


def generate_world_fixture():
    source = "src/madnolia/world_pitch.py"
    with tempfile.TemporaryDirectory(prefix="madnolia-fixture-") as temporary:
        package = Path(temporary) / "madnolia"
        package.mkdir()
        (package / "types").mkdir()
        (package / "__init__.py").write_text("")
        (package / "types" / "__init__.py").write_text("")
        module_file(package.parent, source)
        (package / "constants.py").write_text(
            "WORLD_PITCH_CONTEXT_MS=120\nWORLD_PITCH_FRAME_PERIOD_MS=5\nWORLD_PITCH_PEAK_LIMIT=0.98\n"
        )
        (package / "pitch_shift.py").write_text(
            "def midi_to_hz(midi): return 440.0 * 2 ** ((midi - 69.0) / 12.0)\n"
        )
        (package / "types" / "common.py").write_text(
            "class EditRegion: pass\nclass TimelineSegment: pass\n"
            "class WorldPitchAnalysis:\n def __init__(self, **kwargs): self.__dict__.update(kwargs)\n"
        )
        for name in list(sys.modules):
            if name == "madnolia" or name.startswith("madnolia."):
                del sys.modules[name]
        sys.path.insert(0, temporary)
        from madnolia.world_pitch import render_world_regions

        sample_rate = 16_000
        indices = np.arange(sample_rate * 6)
        seconds = indices / sample_rate
        frequencies = np.where(seconds < 2, 175, np.where(seconds < 4, 247, 329))
        raw = (0.42 * np.sin(2 * np.pi * frequencies * seconds) + 0.09 * np.sin(4 * np.pi * frequencies * seconds)).astype(np.float32)
        pcm = np.floor(raw.astype(np.float64) * 32768 + 0.5).clip(-32768, 32767).astype("<i2")
        audio_path = Path(temporary) / "source.wav"
        with wave.open(str(audio_path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(sample_rate)
            audio.writeframes(pcm.tobytes())
        regions = [
            {"start": 3600, "end": 5500, "duration": 1550, "cents": -37.125, "points": [{"position": 0, "midi": 64.375}, {"position": 1, "midi": 64.375}]},
            {"start": 300, "end": 1900, "duration": 2000, "cents": 18.625, "points": []},
            {"start": 2650, "end": 4700, "duration": 2100, "cents": -11.375, "points": [{"position": 0, "midi": 67.125}, {"position": 1, "midi": 67.125}]},
        ]
        convert = lambda values: [SimpleNamespace(**value) for value in values]
        region_objects = [SimpleNamespace(source_start_ms=item["start"], source_end_ms=item["end"], output_duration_ms=item["duration"], relative_pitch_cents=item["cents"], pitch_points=convert(item["points"])) for item in regions]
        units = [SimpleNamespace(source_start_ms=2650, source_end_ms=4700, vibrato_depth_cents=24, vibrato_rate_hz=5.25, vibrato_start_ms=0)]
        notes = [
            SimpleNamespace(start_ms=1950, end_ms=2430, pitch_points=convert([{"position": 0, "midi": 72.125}, {"position": 1, "midi": 72.125}])),
            SimpleNamespace(start_ms=4120, end_ms=5650, pitch_points=convert([{"position": 0, "midi": 59.625}, {"position": 1, "midi": 59.625}])),
        ]
        segment = SimpleNamespace(edit_regions=region_objects, pitch_envelope=[], phone_units=units, timeline_start_ms=0, timeline_end_ms=5650)
        output = render_world_regions(audio_path, segment, pitch_notes=notes)
        landmarks = [0, 1, 80, 8000, 24800, 50000, 70000, len(output) - 1]
        return {
            "source": f"legacy/python:{source}",
            "source_commit": source_commit(source),
            "pyworld_version": pyworld.__version__,
            "output_length": len(output),
            "sample_indices": landmarks,
            "samples": [float(output[index]) for index in landmarks],
        }


def generate_phone_fixture():
    source = "src/madnolia/acoustic_features.py"
    with tempfile.TemporaryDirectory(prefix="madnolia-phone-fixture-") as temporary:
        package = Path(temporary) / "madnolia"
        package.mkdir()
        (package / "types").mkdir()
        (package / "__init__.py").write_text("")
        (package / "types" / "__init__.py").write_text("")
        module_file(package.parent, source)
        (package / "types" / "common.py").write_text(
            "class AnalysisCheckpoint: pass\nclass PhoneOccurrence: pass\n"
            "class PhoneAcousticFeatures:\n def __init__(self, **kwargs): self.__dict__.update(kwargs)\n"
        )
        for name in list(sys.modules):
            if name == "madnolia" or name.startswith("madnolia."):
                del sys.modules[name]
        sys.path.insert(0, temporary)
        from madnolia.acoustic_features import analyze_phone_acoustics

        sample_rate = 16_000
        indices = np.arange(sample_rate)
        signal = np.zeros(sample_rate, dtype=np.float32)
        signal[: sample_rate // 4] = (0.2 * np.sin(2 * np.pi * 200 * indices[: sample_rate // 4] / sample_rate)).astype(np.float32)
        pcm = np.floor(signal.astype(np.float64) * 32768 + 0.5).clip(-32768, 32767).astype("<i2")
        audio_path = Path(temporary) / "source.wav"
        with wave.open(str(audio_path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(sample_rate)
            audio.writeframes(pcm.tobytes())
        cases = [
            {"phone_id": "en.vowel.open", "start_ms": 100, "end_ms": 110},
            {"phone_id": "en.vowel.open", "start_ms": 500, "end_ms": 510},
            {"phone_id": "en.consonant.fricative", "start_ms": 150, "end_ms": 160},
        ]
        phones = [SimpleNamespace(occurrence_id=f"fixture-{index}", phone_id=case["phone_id"], start_ms=case["start_ms"], end_ms=case["end_ms"]) for index, case in enumerate(cases)]
        features = analyze_phone_acoustics(audio_path, phones)
        return {
            "source": f"legacy/python:{source}",
            "source_commit": source_commit(source),
            "sample_rate": sample_rate,
            "cases": [{**case, "f0_hz": feature.f0_hz, "voiced_probability": feature.voiced_probability, "rms_db": feature.rms_db, "peak_db": feature.peak_db} for case, feature in zip(cases, features)],
        }


def main():
    TESTS.mkdir(parents=True, exist_ok=True)
    (TESTS / "world-worker-reference.json").write_text(json.dumps(generate_world_fixture(), indent=2) + "\n")
    (TESTS / "phone-acoustic-features.json").write_text(json.dumps(generate_phone_fixture(), indent=2) + "\n")
    source = "src/madnolia/acoustic_units.py"
    seeds = np.linspace(0, 256, num=32, dtype=int).tolist()
    seed_fixture = {
        "source": f"legacy/python:{source}",
        "source_commit": source_commit(source),
        "vector_count": 257,
        "cluster_count": 32,
        "indices": seeds,
    }
    (TESTS / "hubert-linspace-reference.json").write_text(json.dumps(seed_fixture, indent=2) + "\n")


if __name__ == "__main__":
    main()
