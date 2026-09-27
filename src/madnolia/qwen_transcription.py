import json
from dataclasses import asdict
from pathlib import Path

import numpy as np

from madnolia.constants import (
    CUDA_DEVICE,
    MODEL_CACHE_DIR,
    QWEN_ALIGNER_REPOSITORY,
    QWEN_ASR_MODEL_REPOSITORIES,
    QWEN_AUDIO_CHUNK_SECONDS,
    QWEN_AUDIO_OVERLAP_MS,
    QWEN_GPU_BATCH_SIZE,
    QWEN_MAX_NEW_TOKENS,
    XPU_DEVICE,
)
from madnolia.transcription import (
    _audio_duration_ms,
    _checkpoint_directory,
    _detect_audio_regions,
    _read_audio_interval,
    _write_checkpoint,
)
from madnolia.types.common import (
    AudioRegion,
    AudioRegionType,
    TranscriptionProgressCallback,
    TranscriptionResult,
    TranscriptWord,
)


class QwenASRTranscriber:
    def __init__(self, model_name: str, device: str = "CPU") -> None:
        import torch
        from transformers import (
            AutoProcessor,
            Qwen3ASRForConditionalGeneration,
            Qwen3ASRForTokenClassification,
        )

        repository = QWEN_ASR_MODEL_REPOSITORIES[model_name]
        model_dir = MODEL_CACHE_DIR / "huggingface" / repository.rsplit("/", 1)[-1]
        aligner_dir = MODEL_CACHE_DIR / "huggingface" / QWEN_ALIGNER_REPOSITORY.rsplit("/", 1)[-1]
        self._device = (
            "cuda" if device.upper() == CUDA_DEVICE else
            "xpu" if device.upper() == XPU_DEVICE else "cpu"
        )
        if self._device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("PyTorch CUDA is unavailable")
        if self._device == "xpu" and not torch.xpu.is_available():
            raise RuntimeError("PyTorch XPU is unavailable; install the Intel XPU build of PyTorch")
        dtype = (
            torch.float16 if self._device == "cuda" else
            torch.bfloat16 if self._device == "xpu" else torch.float32
        )
        self._torch = torch
        self._model_name = model_name
        self._processor = AutoProcessor.from_pretrained(model_dir, local_files_only=True)
        self._model = Qwen3ASRForConditionalGeneration.from_pretrained(
            model_dir, local_files_only=True, dtype=dtype
        ).to(self._device).eval()
        self._aligner_processor = AutoProcessor.from_pretrained(aligner_dir, local_files_only=True)
        self._aligner = Qwen3ASRForTokenClassification.from_pretrained(
            aligner_dir, local_files_only=True, dtype=dtype
        ).to(self._device).eval()

    def transcribe(
        self,
        audio_path: Path,
        audio_regions: list[AudioRegion] | None = None,
        progress_callback: TranscriptionProgressCallback | None = None,
    ) -> TranscriptionResult:
        duration_ms = _audio_duration_ms(audio_path)
        if audio_regions is None:
            audio_regions = _detect_audio_regions(audio_path, duration_ms, progress_callback)
        windows = list(self._windows(audio_regions))
        checkpoint_dir = _checkpoint_directory(
            audio_path, self._model_name, self._device, audio_regions, windows
        )
        checkpoint_dir.mkdir(parents=True, exist_ok=True)
        words: list[TranscriptWord] = []
        transcripts: list[str] = []
        batch_size = QWEN_GPU_BATCH_SIZE if self._device != "cpu" else 1
        for batch_start in range(0, len(windows), batch_size):
            batch = windows[batch_start:batch_start + batch_size]
            cached = {}
            pending = []
            for batch_index, window in enumerate(batch):
                chunk_path = checkpoint_dir / f"{batch_start + batch_index + 1:06d}.json"
                if chunk_path.is_file():
                    try:
                        saved = json.loads(chunk_path.read_text(encoding="utf-8"))
                        if saved["window"] == list(window):
                            cached[batch_index] = (
                                saved["transcript"], [TranscriptWord(**item) for item in saved["words"]]
                            )
                            continue
                    except (ValueError, KeyError, TypeError):
                        pass
                pending.append(batch_index)
            if pending:
                results = self._transcribe_windows(
                    [_read_audio_interval(audio_path, batch[i][0], batch[i][1]) for i in pending],
                    [batch[i] for i in pending],
                )
                for batch_index, (chunk_transcript, chunk_words) in zip(pending, results):
                    window = batch[batch_index]
                    chunk_path = checkpoint_dir / f"{batch_start + batch_index + 1:06d}.json"
                    _write_checkpoint(
                        chunk_path,
                        {"window": list(window), "transcript": chunk_transcript,
                         "words": [asdict(item) for item in chunk_words]},
                    )
                    cached[batch_index] = (chunk_transcript, chunk_words)
            for batch_index in range(len(batch)):
                chunk_transcript, chunk_words = cached[batch_index]
                words.extend(chunk_words)
                transcripts.append(chunk_transcript)
                if progress_callback:
                    progress_callback((batch_start + batch_index + 1) / len(windows))
        if progress_callback:
            progress_callback(1.0)
        return TranscriptionResult(
            transcript=" ".join(part for part in transcripts if part),
            language_probability=None,
            audio_regions=audio_regions,
            words=words,
        )

    def _transcribe_window(
        self, samples: np.ndarray, offset_ms: int, keep_start_ms: int, keep_end_ms: int
    ) -> tuple[str, list[TranscriptWord]]:
        return self._transcribe_windows(
            [samples], [(offset_ms, keep_end_ms, keep_start_ms, keep_end_ms)]
        )[0]

    def _transcribe_windows(
        self, samples: list[np.ndarray], windows: list[tuple[int, int, int, int]]
    ) -> list[tuple[str, list[TranscriptWord]]]:
        request = self._processor.apply_transcription_request(
            audio=samples, language="Korean",
            processor_kwargs={"sampling_rate": 16000, "padding": True}, return_tensors="pt",
        )
        request = {key: value.to(self._device) for key, value in request.items()}
        if self._device != "cpu":
            request["input_features"] = request["input_features"].to(self._model.dtype)
        with self._torch.inference_mode():
            output = self._model.generate(**request, max_new_tokens=QWEN_MAX_NEW_TOKENS)
        results = []
        for index, sample in enumerate(samples):
            transcript = self._processor.decode(
                output[index, request["input_ids"].shape[1]:], return_format="transcription_only"
            ).strip()
            offset_ms, _, keep_start_ms, keep_end_ms = windows[index]
            results.append((transcript, self._align_window(
                sample, transcript, offset_ms, keep_start_ms, keep_end_ms
            )))
        return results

    def _align_window(
        self, samples: np.ndarray, transcript: str,
        offset_ms: int, keep_start_ms: int, keep_end_ms: int,
    ) -> list[TranscriptWord]:
        if not transcript:
            return []
        inputs, word_lists = self._aligner_processor.prepare_forced_aligner_inputs(
            audio=samples, transcript=transcript,
            processor_kwargs={"sampling_rate": 16000}, return_tensors="pt",
        )
        inputs = {key: value.to(self._device) for key, value in inputs.items()}
        if self._device != "cpu":
            inputs["input_features"] = inputs["input_features"].to(self._aligner.dtype)
        with self._torch.inference_mode():
            alignment = self._aligner(**inputs)
        aligned = self._aligner_processor.decode_forced_alignment(
            alignment.logits, inputs["input_ids"], word_lists,
            self._aligner.config.timestamp_token_id,
        )[0]
        if not aligned:
            raise RuntimeError("Qwen3 ASR alignment returned no words")
        words = []
        for item in aligned:
            start_ms = offset_ms + round(item["start_time"] * 1000)
            end_ms = max(start_ms + 1, offset_ms + round(item["end_time"] * 1000))
            midpoint = (start_ms + end_ms) // 2
            if item["text"] and keep_start_ms <= midpoint < keep_end_ms:
                words.append(TranscriptWord(item["text"], start_ms, end_ms, None))
        return words

    @staticmethod
    def _windows(regions: list[AudioRegion]):
        window_ms = QWEN_AUDIO_CHUNK_SECONDS * 1000
        overlap_ms = QWEN_AUDIO_OVERLAP_MS
        for region in regions:
            if region.region_type != AudioRegionType.SPEECH:
                continue
            start_ms = region.start_ms
            first = True
            while start_ms < region.end_ms:
                end_ms = min(start_ms + window_ms, region.end_ms)
                final = end_ms == region.end_ms
                yield (
                    start_ms, end_ms,
                    start_ms if first else start_ms + overlap_ms // 2,
                    end_ms if final else end_ms - overlap_ms // 2,
                )
                if final:
                    break
                start_ms = end_ms - overlap_ms
                first = False
