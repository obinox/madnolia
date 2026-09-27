import argparse
import json
from dataclasses import asdict
from pathlib import Path
from time import monotonic

from madnolia.alignment import _alignment_word_chunks, align_phone_occurrences
from madnolia.ctc_alignment import PhonemeCtcAligner
from madnolia.hierarchy import segment_sentences
from madnolia.phonetics import KoreanPhonetics
from madnolia.qwen_transcription import QwenASRTranscriber
from madnolia.transcription import _checkpoint_directory, _detect_audio_regions
from madnolia.types.common import TranscriptWord


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    started = monotonic()
    regions = _detect_audio_regions(args.audio, 600000)
    windows = list(QwenASRTranscriber._windows(regions))
    checkpoints = _checkpoint_directory(args.audio, "qwen3-asr-0.6b", "xpu", regions, windows)
    words = []
    for index in range(1, len(windows) + 1):
        payload = json.loads((checkpoints / f"{index:06d}.json").read_text(encoding="utf-8"))
        words.extend(TranscriptWord(**item) for item in payload["words"])
    sentences = segment_sentences(words)
    phonetics = KoreanPhonetics()
    print("words", len(words), "sentences", len(sentences), flush=True)
    aligner = PhonemeCtcAligner(device="GPU")
    loaded = monotonic()
    phones = align_phone_occurrences(
        "maple-now-2026-09-10", args.audio, words, sentences, phonetics, aligner,
    )
    aligned = monotonic()
    chunks = []
    for start, end in _alignment_word_chunks(words, sentences):
        indices = [index for index, phone in enumerate(phones) if start <= phone.word_index < end]
        if indices:
            chunks.append({"word_start": start, "word_end": end, "phone_indices": indices})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({
        "audio": str(args.audio.resolve()), "word_count": len(words),
        "load_seconds": round(loaded - started, 2),
        "alignment_seconds": round(aligned - loaded, 2),
        "total_seconds": round(aligned - started, 2),
        "words": [asdict(word) for word in words],
        "phones": [asdict(phone) for phone in phones], "chunks": chunks,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print("saved", args.output, "phones", len(phones), "chunks", len(chunks),
          "seconds", round(aligned - started, 2), flush=True)


if __name__ == "__main__":
    main()
