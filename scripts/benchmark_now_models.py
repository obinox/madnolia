import argparse
import json
from pathlib import Path
from time import monotonic

from madnolia.qwen_transcription import QwenASRTranscriber
from madnolia.transcription import LocalWhisperTranscriber, OpenVINOWhisperTranscriber


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--backend", choices=("openvino", "faster-whisper", "qwen3-asr"), required=True)
    parser.add_argument("--device", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    started = monotonic()
    if args.backend == "openvino":
        transcriber = OpenVINOWhisperTranscriber(args.model, args.device)
    elif args.backend == "qwen3-asr":
        transcriber = QwenASRTranscriber(args.model, args.device)
    else:
        transcriber = LocalWhisperTranscriber(args.model, args.device)
    loaded = monotonic()
    print(f"loaded {args.model} in {loaded - started:.2f}s", flush=True)

    last_percent = -10

    def report(progress: float) -> None:
        nonlocal last_percent
        percent = int(progress * 100)
        if percent >= last_percent + 10:
            last_percent = percent
            print(f"{args.model}: {percent}% after {monotonic() - started:.1f}s", flush=True)

    result = transcriber.transcribe(args.audio, progress_callback=report)
    completed = monotonic()
    output = {
        "model": args.model,
        "backend": args.backend,
        "device": args.device,
        "audio": str(args.audio.resolve()),
        "model_load_seconds": round(loaded - started, 2),
        "transcription_seconds": round(completed - loaded, 2),
        "total_seconds": round(completed - started, 2),
        "word_count": len(result.words),
        "transcript": result.transcript,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"saved {args.output} in {completed - started:.2f}s", flush=True)


if __name__ == "__main__":
    main()
