import json
import sys
import traceback
from pathlib import Path

from madnolia.transcription import _read_audio_interval


def run_openvino_worker(model_dir: Path, device: str) -> None:
    try:
        import openvino_genai as ov_genai

        pipeline = ov_genai.WhisperPipeline(str(model_dir.resolve()), device, word_timestamps=True)
        _respond({"ready": True})
        for line in sys.stdin:
            command = json.loads(line)
            samples = _read_audio_interval(
                Path(command["audio_path"]), command["start_ms"], command["end_ms"]
            )
            options = {
                "language": "ko",
                "task": "transcribe",
                "return_timestamps": True,
                "word_timestamps": True,
                "max_new_tokens": command["max_new_tokens"],
            }
            if command["initial_prompt"]:
                options["initial_prompt"] = command["initial_prompt"]
            result = pipeline.generate(samples, **options)
            words = (
                result.words[0]
                if result.words and isinstance(result.words[0], list)
                else result.words
            )
            _respond(
                {
                    "words": [
                        {
                            "text": word.word,
                            "start_ms": round(word.start_ts * 1000),
                            "end_ms": round(word.end_ts * 1000),
                        }
                        for word in words or []
                    ]
                }
            )
    except Exception:  # noqa: BLE001
        _respond({"error": traceback.format_exc()})


def _respond(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    run_openvino_worker(Path(sys.argv[1]), sys.argv[2])
