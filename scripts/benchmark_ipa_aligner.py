import argparse
import json
import sys
from pathlib import Path
from time import monotonic


def align_scores(similarity, numpy):
    frames, phones = similarity.shape
    if frames < phones:
        raise ValueError(f"Too many phones for frames: {phones} > {frames}")
    scores = numpy.full(phones, -numpy.inf, dtype=numpy.float32)
    scores[0] = similarity[0, 0]
    back = numpy.zeros((frames, phones), dtype=numpy.uint8)
    for frame in range(1, frames):
        previous = scores.copy()
        scores[0] = previous[0] + similarity[frame, 0]
        advance = previous[:-1] >= previous[1:]
        scores[1:] = numpy.maximum(previous[1:], previous[:-1]) + similarity[frame, 1:]
        back[frame, 1:] = advance
    if not numpy.isfinite(scores[-1]):
        raise ValueError("No complete monotonic alignment")
    assignments = numpy.zeros(frames, dtype=numpy.int32)
    phone = phones - 1
    for frame in range(frames - 1, -1, -1):
        assignments[frame] = phone
        if frame:
            phone -= int(back[frame, phone])
    return assignments


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-span-ms", type=int, default=15000)
    args = parser.parse_args()
    root = args.baseline.parent
    sys.path.insert(0, str((root / "legacy-python").resolve()))
    sys.path.insert(1, str((root / "clap-ipa-source").resolve()))

    import numpy as np
    import torch
    from clap.encoders import PhoneEncoder, SpeechEncoder
    from torch.nn import functional
    from transformers import DebertaV2Tokenizer, WhisperFeatureExtractor

    from madnolia.transcription import _read_audio_interval

    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    chunks = []
    for original in baseline["chunks"]:
        start = original["word_start"]
        while start < original["word_end"]:
            end = start + 1
            while (
                end < original["word_end"]
                and baseline["words"][end]["end_ms"]
                - baseline["words"][start]["start_ms"] <= args.max_span_ms
            ):
                end += 1
            indices = [
                index for index in original["phone_indices"]
                if start <= baseline["phones"][index]["word_index"] < end
            ]
            if indices:
                chunks.append({"word_start": start, "word_end": end, "phone_indices": indices})
            start = end
    models = root / "ipa-models"
    started = monotonic()
    speech = SpeechEncoder.from_pretrained(
        models / "anyspeech--ipa-align-tiny-speech", local_files_only=True
    ).eval().to("xpu")
    phone_encoder = PhoneEncoder.from_pretrained(
        models / "anyspeech--ipa-align-tiny-phone", local_files_only=True
    ).eval().to("xpu")
    tokenizer = DebertaV2Tokenizer.from_pretrained(
        models / "charsiu--IPATokenizer", local_files_only=True
    )
    feature = WhisperFeatureExtractor.from_pretrained(
        models / "openai--whisper-base", local_files_only=True
    )
    loaded = monotonic()
    results = [None] * len(baseline["phones"])
    progress = root / f"phone-boundaries-ipa-checkpoints-{args.max_span_ms}"
    progress.mkdir(parents=True, exist_ok=True)
    for chunk_index, chunk in enumerate(chunks, 1):
        saved = progress / f"{chunk_index:03d}.json"
        if saved.exists():
            positions = json.loads(saved.read_text(encoding="utf-8"))
        else:
            word_start = baseline["words"][chunk["word_start"]]["start_ms"]
            word_end = baseline["words"][chunk["word_end"] - 1]["end_ms"]
            start_ms = max(0, word_start - 250)
            end_ms = min(600000, word_end + 250)
            samples = _read_audio_interval(Path(baseline["audio"]), start_ms, end_ms)
            batch = feature(
                [samples], sampling_rate=16000, return_attention_mask=True, return_tensors="pt"
            )
            length = int(batch["attention_mask"].sum())
            batch["attention_mask"] = batch["attention_mask"][:, :length]
            batch["input_features"] = batch["input_features"][:, :, :length]
            symbols = [baseline["phones"][index]["ipa"] for index in chunk["phone_indices"]]
            encoded = tokenizer(
                ["[SEP]", *symbols, "[SEP]"], add_special_tokens=False,
                return_attention_mask=False, return_length=True,
                return_token_type_ids=False,
            )
            token_ids = [token for group in encoded["input_ids"] for token in group]
            token_lengths = encoded["length"]
            phone_mask = torch.zeros((len(token_lengths), len(token_ids)))
            cursor = 0
            for phone_index, token_length in enumerate(token_lengths):
                phone_mask[phone_index, cursor:cursor + token_length] = 1 / token_length
                cursor += token_length
            with torch.inference_mode():
                audio_embeddings = speech(**batch.to("xpu")).last_hidden_state[0]
                phone_embeddings = phone_encoder(
                    torch.tensor([token_ids], device="xpu")
                ).last_hidden_state[0]
                phone_vectors = functional.normalize(
                    phone_mask.to("xpu") @ phone_embeddings, dim=-1
                )
                audio_vectors = functional.normalize(audio_embeddings, dim=-1)
                similarity = (audio_vectors @ phone_vectors.T).float().cpu().numpy()
            assignments = align_scores(similarity, np)
            positions = []
            for symbol_index, symbol in enumerate(symbols, 1):
                frames = np.flatnonzero(assignments == symbol_index)
                step_ms = (end_ms - start_ms) / len(assignments)
                positions.append({
                    "start_ms": start_ms + round(int(frames[0]) * step_ms),
                    "end_ms": start_ms + round((int(frames[-1]) + 1) * step_ms),
                    "unknown": tokenizer.unk_token_id in encoded["input_ids"][symbol_index],
                    "ipa": symbol,
                })
            saved.write_text(json.dumps(positions, ensure_ascii=False), encoding="utf-8")
        for index, position in zip(chunk["phone_indices"], positions, strict=True):
            results[index] = position
        if chunk_index == 1 or chunk_index % 5 == 0:
            print("aligned", chunk_index, "/", len(chunks),
                  "seconds", round(monotonic() - started, 1), flush=True)

    completed = monotonic()
    args.output.write_text(json.dumps({
        "audio": baseline["audio"], "model": "IPA-ALIGNER tiny",
        "max_span_ms": args.max_span_ms, "chunk_count": len(chunks),
        "load_seconds": round(loaded - started, 2),
        "alignment_seconds": round(completed - loaded, 2),
        "total_seconds": round(completed - started, 2),
        "phones": results,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print("saved", args.output, "phones", len(results),
          "seconds", round(completed - started, 2), flush=True)


if __name__ == "__main__":
    main()
