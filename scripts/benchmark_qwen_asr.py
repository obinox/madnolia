import json
from dataclasses import asdict
from pathlib import Path
from time import monotonic

from madnolia.constants import QWEN_ASR_MODEL_REPOSITORIES
from madnolia.qwen_transcription import QwenASRTranscriber
from madnolia.types.common import AudioRegion, AudioRegionType


def main() -> None:
    project_dir = Path("data/output/proj_20260925_205633_386100a2")
    manifest = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    analysis = json.loads((project_dir / manifest["analysis_files"][0]).read_text(encoding="utf-8"))
    source_id = analysis["source"]["source_id"]
    audio_path = (project_dir / manifest["audio_files"][source_id]).resolve()
    regions = [
        AudioRegion(AudioRegionType(item["region_type"]), item["start_ms"], item["end_ms"])
        for item in analysis["audio_regions"]
    ]
    output_dir = Path("data/cache/qwen-benchmark")
    output_dir.mkdir(parents=True, exist_ok=True)
    for model_name in QWEN_ASR_MODEL_REPOSITORIES:
        started = monotonic()
        model = QwenASRTranscriber(model_name)
        loaded = monotonic()
        last_percent = -1

        def report(progress: float, label: str = model_name, start: float = started) -> None:
            nonlocal last_percent
            percent = int(progress * 100)
            if percent >= last_percent + 2:
                last_percent = percent
                print(label, percent, round(monotonic() - start), flush=True)

        result = model.transcribe(audio_path, regions, report)
        ended = monotonic()
        output = {
            "model": model_name,
            "source": analysis["source"]["path"],
            "duration_ms": analysis["source"]["duration_ms"],
            "model_load_seconds": round(loaded - started, 2),
            "transcription_seconds": round(ended - loaded, 2),
            "total_seconds": round(ended - started, 2),
            "transcript": result.transcript,
            "words": [asdict(word) for word in result.words],
        }
        destination = output_dir / f"{model_name}.json"
        destination.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
        print("saved", destination, "words", len(result.words), flush=True)


if __name__ == "__main__":
    main()
