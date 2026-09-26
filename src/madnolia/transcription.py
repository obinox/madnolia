import hashlib
import json
import os
import queue
import subprocess
import sys
import threading
import wave
from dataclasses import asdict
from pathlib import Path
from time import monotonic

import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.vad import VadOptions, get_speech_timestamps
from huggingface_hub import snapshot_download

from madnolia.constants import (
    MODEL_CACHE_DIR,
    OPENVINO_AUDIO_CHUNK_SECONDS,
    OPENVINO_AUDIO_OVERLAP_SECONDS,
    OPENVINO_CHUNK_POLL_SECONDS,
    OPENVINO_CONTEXT_MAX_GAP_MS,
    OPENVINO_CONTEXT_WORDS,
    OPENVINO_CPU_CHUNK_TIMEOUT_SECONDS,
    OPENVINO_GPU_CHUNK_TIMEOUT_SECONDS,
    OPENVINO_MAX_NEW_TOKENS,
    OPENVINO_MIN_NEW_TOKENS,
    OPENVINO_MODEL_REPOSITORIES,
    OPENVINO_NEW_TOKENS_PER_SECOND,
    OPENVINO_REPEATED_WORD_MIN_COUNT,
    OPENVINO_REPEATED_WORD_RATIO,
    OPENVINO_WORKER_STARTUP_TIMEOUT_SECONDS,
    TRANSCRIPTION_CHECKPOINT_DIR,
    TRANSCRIPTION_CHECKPOINT_VERSION,
    VAD_MERGE_GAP_MS,
    VAD_MIN_SILENCE_DURATION_MS,
    VAD_MIN_SPEECH_DURATION_MS,
    VAD_SPEECH_PAD_MS,
    VAD_THRESHOLD,
)
from madnolia.types.common import (
    AnalysisCancelled,
    AnalysisCheckpoint,
    AudioRegion,
    AudioRegionType,
    TranscriptionChunkFailure,
    TranscriptionProgressCallback,
    TranscriptionResult,
    TranscriptWord,
)


class LocalWhisperTranscriber:
    def __init__(self, model_name: str) -> None:
        local = MODEL_CACHE_DIR / "faster-whisper" / model_name
        self._model = WhisperModel(
            str(local) if (local / "model.bin").is_file() else model_name,
            device="cpu",
            compute_type="int8",
        )

    def transcribe(
        self,
        audio_path: Path,
        audio_regions: list[AudioRegion] | None = None,
        progress_callback: TranscriptionProgressCallback | None = None,
    ) -> TranscriptionResult:
        segments, info = self._model.transcribe(
            str(audio_path),
            language="ko",
            beam_size=5,
            word_timestamps=True,
            vad_filter=True,
        )
        words: list[TranscriptWord] = []
        speech_regions: list[AudioRegion] = []
        transcript_parts: list[str] = []
        duration_ms = _audio_duration_ms(audio_path)
        for segment in segments:
            if progress_callback:
                progress_callback(min(1.0, segment.end * 1000 / max(duration_ms, 1)))
            transcript_parts.append(segment.text.strip())
            speech_regions.append(
                AudioRegion(
                    region_type=AudioRegionType.SPEECH,
                    start_ms=round(segment.start * 1000),
                    end_ms=round(segment.end * 1000),
                )
            )
            for word in segment.words or []:
                text = word.word.strip()
                if not text:
                    continue
                words.append(
                    TranscriptWord(
                        text=text,
                        start_ms=round(word.start * 1000),
                        end_ms=round(word.end * 1000),
                        confidence=max(0.0, min(1.0, word.probability)),
                    )
                )
        if progress_callback:
            progress_callback(1.0)
        return TranscriptionResult(
            transcript=" ".join(part for part in transcript_parts if part),
            language_probability=info.language_probability,
            audio_regions=_complete_audio_regions(duration_ms, speech_regions),
            words=words,
        )


class OpenVINOWhisperTranscriber:
    def __init__(self, model_name: str, device: str) -> None:
        repository = OPENVINO_MODEL_REPOSITORIES.get(model_name)
        if repository is None:
            supported = ", ".join(sorted(OPENVINO_MODEL_REPOSITORIES))
            raise ValueError(f"Unsupported OpenVINO model: {supported}")
        model_dir = MODEL_CACHE_DIR / "openvino" / repository.rsplit("/", 1)[-1]
        if not (model_dir / "openvino_encoder_model.xml").exists():
            snapshot_download(repository, local_dir=model_dir)
        self._model_dir = model_dir
        self._model_name = model_name
        self._device = device.upper()

    def transcribe(
        self,
        audio_path: Path,
        audio_regions: list[AudioRegion] | None = None,
        progress_callback: TranscriptionProgressCallback | None = None,
    ) -> TranscriptionResult:
        words: list[TranscriptWord] = []
        duration_ms = _audio_duration_ms(audio_path)
        if audio_regions is None:
            audio_regions = _detect_audio_regions(audio_path, duration_ms, progress_callback)
        speech_regions = [
            region for region in audio_regions if region.region_type == AudioRegionType.SPEECH
        ]
        windows = list(_speech_windows(speech_regions))
        checkpoint_dir = _checkpoint_directory(
            audio_path, self._model_name, self._device, audio_regions, windows
        )
        checkpoint_dir.mkdir(parents=True, exist_ok=True)
        failure_path = checkpoint_dir / "failure.json"
        worker = None
        resume_ready = True
        try:
            for chunk_index, (offset_ms, window_end_ms, keep_start_ms, keep_end_ms) in enumerate(
                windows, start=1
            ):
                chunk_path = checkpoint_dir / f"{chunk_index:06d}.json"
                chunk_words = None
                if resume_ready and chunk_path.is_file():
                    try:
                        saved = json.loads(chunk_path.read_text(encoding="utf-8"))
                        if saved["window"] == list(windows[chunk_index - 1]):
                            chunk_words = [TranscriptWord(**item) for item in saved["words"]]
                    except (ValueError, KeyError, TypeError):
                        pass
                if chunk_words is None:
                    resume_ready = False
                    if chunk_index == 1 or chunk_index % 12 == 0:
                        print(
                            f"OpenVINO chunk {chunk_index}/{len(windows)} "
                            f"({offset_ms // 60000} min)",
                            flush=True,
                        )
                    command = {
                        "audio_path": str(audio_path.resolve()),
                        "start_ms": offset_ms,
                        "end_ms": window_end_ms,
                        "initial_prompt": _context_prompt(words, offset_ms),
                        "max_new_tokens": min(
                            OPENVINO_MAX_NEW_TOKENS,
                            max(
                                OPENVINO_MIN_NEW_TOKENS,
                                round(
                                    (window_end_ms - offset_ms)
                                    / 1000
                                    * OPENVINO_NEW_TOKENS_PER_SECOND
                                ),
                            ),
                        ),
                    }
                    failures: list[str] = []
                    checkpoint = (
                        (lambda index=chunk_index: progress_callback((index - 1) / len(windows)))
                        if progress_callback
                        else None
                    )
                    devices = (
                        ["GPU", "GPU", "CPU"]
                        if self._device == "GPU"
                        else [self._device, self._device]
                    )
                    for device in devices:
                        if worker is not None and worker.device != device:
                            worker.close()
                            worker = None
                        try:
                            if worker is None:
                                worker = _OpenVINOWorker(self._model_dir, device, checkpoint)
                            response = worker.run(command, checkpoint)
                            raw_words = response["words"]
                            if _repeated_transcription(raw_words):
                                raise RuntimeError("repeated transcription detected")
                            chunk_words = []
                            for item in raw_words:
                                word_text = item["text"].strip()
                                word_start_ms = offset_ms + item["start_ms"]
                                word_end_ms = min(window_end_ms, offset_ms + item["end_ms"])
                                midpoint = (word_start_ms + word_end_ms) // 2
                                if (
                                    word_text
                                    and word_end_ms > word_start_ms
                                    and keep_start_ms <= midpoint < keep_end_ms
                                    and _point_in_speech(midpoint, speech_regions)
                                ):
                                    chunk_words.append(
                                        TranscriptWord(word_text, word_start_ms, word_end_ms, None)
                                    )
                            break
                        except AnalysisCancelled:
                            raise
                        except (
                            RuntimeError,
                            TimeoutError,
                            ValueError,
                            KeyError,
                            TypeError,
                            OSError,
                            EOFError,
                        ) as exc:
                            failures.append(f"{device}: {type(exc).__name__}: {exc}")
                            if worker is not None:
                                worker.close()
                                worker = None
                    if chunk_words is None:
                        _write_checkpoint(
                            failure_path,
                            {
                                "chunk": chunk_index,
                                "total": len(windows),
                                "window": windows[chunk_index - 1],
                                "errors": failures,
                            },
                        )
                        raise TranscriptionChunkFailure(
                            f"Transcription chunk {chunk_index}/{len(windows)} "
                            f"at {offset_ms / 60000:.2f} min failed: {'; '.join(failures)}"
                        )
                    _write_checkpoint(
                        chunk_path,
                        {
                            "window": windows[chunk_index - 1],
                            "words": [asdict(item) for item in chunk_words],
                        },
                    )
                words.extend(chunk_words)
                if progress_callback:
                    progress_callback(chunk_index / len(windows))
            failure_path.unlink(missing_ok=True)
        finally:
            if worker is not None:
                worker.close()
        if progress_callback:
            progress_callback(1.0)
        return TranscriptionResult(
            transcript=" ".join(word.text for word in words),
            language_probability=None,
            audio_regions=audio_regions,
            words=words,
        )


class _OpenVINOWorker:
    def __init__(
        self,
        model_dir: Path,
        device: str,
        callback: AnalysisCheckpoint | None,
    ) -> None:
        self.device = device
        self._responses: queue.Queue[str] = queue.Queue()
        self._process = subprocess.Popen(
            [
                sys.executable,
                "-u",
                "-m",
                "madnolia.transcription_worker",
                str(model_dir.resolve()),
                device,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        self._reader = threading.Thread(target=self._read_responses, daemon=True)
        self._reader.start()
        try:
            response = self._receive(OPENVINO_WORKER_STARTUP_TIMEOUT_SECONDS, callback)
            if response.get("ready") is not True:
                raise RuntimeError("OpenVINO worker did not initialize")
        except BaseException:
            self.close()
            raise

    def _read_responses(self) -> None:
        assert self._process.stdout is not None
        try:
            for line in self._process.stdout:
                self._responses.put(line)
        finally:
            self._responses.put("")

    def _receive(self, timeout: float, callback: AnalysisCheckpoint | None) -> dict:
        elapsed = 0.0
        while elapsed < timeout:
            if callback:
                callback()
            started = monotonic()
            try:
                line = self._responses.get(
                    timeout=min(OPENVINO_CHUNK_POLL_SECONDS, timeout - elapsed)
                )
                if not line:
                    raise RuntimeError(f"OpenVINO worker exited: {self._process.poll()}")
                response = json.loads(line)
                if "error" in response:
                    raise RuntimeError(response["error"])
                return response
            except queue.Empty:
                pass
            elapsed += monotonic() - started
            if self._process.poll() is not None and self._responses.empty():
                raise RuntimeError(f"OpenVINO worker exited: {self._process.returncode}")
        raise TimeoutError(f"OpenVINO {self.device} worker timed out after {timeout}s")

    def run(self, command: dict, callback: AnalysisCheckpoint | None) -> dict:
        assert self._process.stdin is not None
        self._process.stdin.write(json.dumps(command, ensure_ascii=False) + "\n")
        self._process.stdin.flush()
        timeout = (
            OPENVINO_GPU_CHUNK_TIMEOUT_SECONDS
            if self.device == "GPU"
            else OPENVINO_CPU_CHUNK_TIMEOUT_SECONDS
        )
        return self._receive(timeout, callback)

    def close(self) -> None:
        if self._process.poll() is None:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(self._process.pid), "/T", "/F"],
                    capture_output=True,
                    check=False,
                )
            if self._process.poll() is None:
                self._process.terminate()
            try:
                self._process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=2)
        if self._process.stdin is not None:
            self._process.stdin.close()
        if self._process.stdout is not None:
            self._process.stdout.close()


def _checkpoint_directory(
    audio_path: Path,
    model_name: str,
    device: str,
    regions: list[AudioRegion],
    windows: list[tuple[int, int, int, int]],
) -> Path:
    stat = audio_path.stat()
    identity = {
        "version": TRANSCRIPTION_CHECKPOINT_VERSION,
        "audio": str(audio_path.resolve()),
        "size": stat.st_size,
        "modified_ns": stat.st_mtime_ns,
        "model": model_name,
        "device": device,
        "chunk_seconds": OPENVINO_AUDIO_CHUNK_SECONDS,
        "overlap_seconds": OPENVINO_AUDIO_OVERLAP_SECONDS,
        "context_words": OPENVINO_CONTEXT_WORDS,
        "context_gap_ms": OPENVINO_CONTEXT_MAX_GAP_MS,
        "max_tokens": OPENVINO_MAX_NEW_TOKENS,
        "tokens_per_second": OPENVINO_NEW_TOKENS_PER_SECOND,
        "regions": [asdict(region) for region in regions],
        "windows": windows,
    }
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode("utf-8")).hexdigest()
    return TRANSCRIPTION_CHECKPOINT_DIR / digest


def _write_checkpoint(path: Path, payload: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def _repeated_transcription(words: list[dict]) -> bool:
    texts = [item["text"].strip() for item in words if item["text"].strip()]
    return (
        len(texts) >= OPENVINO_REPEATED_WORD_MIN_COUNT
        and max(texts.count(text) for text in set(texts)) / len(texts)
        >= OPENVINO_REPEATED_WORD_RATIO
    )


def _read_audio_chunks(audio_path: Path):
    with wave.open(str(audio_path), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 16000:
            raise ValueError("OpenVINO 입력 오디오는 16kHz mono 16-bit PCM이어야 합니다.")
        frames_per_chunk = OPENVINO_AUDIO_CHUNK_SECONDS * audio.getframerate()
        offset_frames = 0
        while raw_audio := audio.readframes(frames_per_chunk):
            samples = np.frombuffer(raw_audio, dtype=np.int16).astype(np.float32) / 32768.0
            yield round(offset_frames * 1000 / audio.getframerate()), samples
            offset_frames += len(samples)


def _read_audio_interval(audio_path: Path, start_ms: int, end_ms: int) -> np.ndarray:
    with wave.open(str(audio_path), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 16000:
            raise ValueError("OpenVINO 입력 오디오는 16kHz mono 16-bit PCM이어야 합니다.")
        sample_rate = audio.getframerate()
        start_frame = min(audio.getnframes(), round(start_ms * sample_rate / 1000))
        end_frame = min(audio.getnframes(), round(end_ms * sample_rate / 1000))
        audio.setpos(start_frame)
        raw_audio = audio.readframes(max(0, end_frame - start_frame))
    return np.frombuffer(raw_audio, dtype=np.int16).astype(np.float32) / 32768.0


def _audio_duration_ms(audio_path: Path) -> int:
    with wave.open(str(audio_path), "rb") as audio:
        return round(audio.getnframes() * 1000 / audio.getframerate())


def _detect_audio_regions(
    audio_path: Path,
    duration_ms: int,
    progress_callback: TranscriptionProgressCallback | None = None,
) -> list[AudioRegion]:
    speech_regions: list[AudioRegion] = []
    options = VadOptions(
        threshold=VAD_THRESHOLD,
        min_speech_duration_ms=VAD_MIN_SPEECH_DURATION_MS,
        min_silence_duration_ms=VAD_MIN_SILENCE_DURATION_MS,
        speech_pad_ms=VAD_SPEECH_PAD_MS,
    )
    for offset_ms, samples in _read_audio_chunks(audio_path):
        if progress_callback:
            progress_callback(0.0)
        for timestamp in get_speech_timestamps(samples, options):
            speech_regions.append(
                AudioRegion(
                    region_type=AudioRegionType.SPEECH,
                    start_ms=offset_ms + round(timestamp["start"] * 1000 / 16000),
                    end_ms=offset_ms + round(timestamp["end"] * 1000 / 16000),
                )
            )
    return _complete_audio_regions(duration_ms, speech_regions)


def _speech_windows(regions: list[AudioRegion]):
    window_ms = OPENVINO_AUDIO_CHUNK_SECONDS * 1000
    overlap_ms = OPENVINO_AUDIO_OVERLAP_SECONDS * 1000
    stride_ms = window_ms - overlap_ms
    half_overlap_ms = overlap_ms // 2
    for region in regions:
        offset_ms = region.start_ms
        first = True
        while offset_ms < region.end_ms:
            window_end_ms = min(region.end_ms, offset_ms + window_ms)
            final = window_end_ms >= region.end_ms
            keep_start_ms = offset_ms if first else offset_ms + half_overlap_ms
            keep_end_ms = window_end_ms if final else window_end_ms - half_overlap_ms
            yield offset_ms, window_end_ms, keep_start_ms, keep_end_ms
            if final:
                break
            offset_ms += stride_ms
            first = False


def _context_prompt(words: list[TranscriptWord], chunk_start_ms: int) -> str:
    if not words or chunk_start_ms - words[-1].end_ms > OPENVINO_CONTEXT_MAX_GAP_MS:
        return ""
    return " ".join(word.text for word in words[-OPENVINO_CONTEXT_WORDS:])


def _point_in_speech(time_ms: int, regions: list[AudioRegion]) -> bool:
    return any(region.start_ms <= time_ms < region.end_ms for region in regions)


def _complete_audio_regions(
    duration_ms: int,
    speech_regions: list[AudioRegion],
) -> list[AudioRegion]:
    merged: list[AudioRegion] = []
    for region in sorted(speech_regions, key=lambda item: item.start_ms):
        if merged and region.start_ms - merged[-1].end_ms <= VAD_MERGE_GAP_MS:
            previous = merged[-1]
            merged[-1] = AudioRegion(
                region_type=AudioRegionType.SPEECH,
                start_ms=previous.start_ms,
                end_ms=max(previous.end_ms, region.end_ms),
            )
        else:
            merged.append(region)
    completed: list[AudioRegion] = []
    cursor_ms = 0
    for region in merged:
        if region.start_ms > cursor_ms:
            completed.append(
                AudioRegion(
                    region_type=AudioRegionType.NON_SPEECH,
                    start_ms=cursor_ms,
                    end_ms=region.start_ms,
                )
            )
        completed.append(region)
        cursor_ms = region.end_ms
    if cursor_ms < duration_ms:
        completed.append(
            AudioRegion(
                region_type=AudioRegionType.NON_SPEECH,
                start_ms=cursor_ms,
                end_ms=duration_ms,
            )
        )
    return completed
