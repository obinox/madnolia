import wave
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.vad import VadOptions, get_speech_timestamps
from huggingface_hub import snapshot_download

from madnolia.constants import (
    MODEL_CACHE_DIR,
    OPENVINO_AUDIO_CHUNK_SECONDS,
    OPENVINO_AUDIO_OVERLAP_SECONDS,
    OPENVINO_CONTEXT_MAX_GAP_MS,
    OPENVINO_CONTEXT_WORDS,
    OPENVINO_MODEL_REPOSITORIES,
    VAD_MERGE_GAP_MS,
    VAD_MIN_SILENCE_DURATION_MS,
    VAD_MIN_SPEECH_DURATION_MS,
    VAD_SPEECH_PAD_MS,
    VAD_THRESHOLD,
)
from madnolia.types.common import (
    AudioRegion,
    AudioRegionType,
    TranscriptionProgressCallback,
    TranscriptionResult,
    TranscriptWord,
)


class LocalWhisperTranscriber:
    def __init__(self, model_name: str) -> None:
        local = MODEL_CACHE_DIR / "faster-whisper" / model_name
        self._model = WhisperModel(
            str(local) if (local / "model.bin").is_file() else model_name,
            device="cpu", compute_type="int8",
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
        import openvino_genai as ov_genai

        repository = OPENVINO_MODEL_REPOSITORIES.get(model_name)
        if repository is None:
            supported = ", ".join(sorted(OPENVINO_MODEL_REPOSITORIES))
            raise ValueError(f"OpenVINO 지원 모델: {supported}")
        model_dir = MODEL_CACHE_DIR / "openvino" / repository.rsplit("/", 1)[-1]
        if not (model_dir / "openvino_encoder_model.xml").exists():
            snapshot_download(repository, local_dir=model_dir)
        self._pipeline = ov_genai.WhisperPipeline(
            str(model_dir.resolve()),
            device.upper(),
            word_timestamps=True,
        )

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
        for chunk_index, (offset_ms, window_end_ms, keep_start_ms, keep_end_ms) in enumerate(
            windows, start=1
        ):
            if chunk_index == 1 or chunk_index % 12 == 0:
                print(
                    f"OpenVINO VAD 청크 {chunk_index}/{len(windows)} 처리 중 "
                    f"({offset_ms // 60000}분 지점)",
                    flush=True,
                )
            samples = _read_audio_interval(audio_path, offset_ms, window_end_ms)
            initial_prompt = _context_prompt(words, offset_ms)
            generation_options = {
                "language": "ko",
                "task": "transcribe",
                "return_timestamps": True,
                "word_timestamps": True,
            }
            if initial_prompt:
                generation_options["initial_prompt"] = initial_prompt
            result = self._pipeline.generate(samples, **generation_options)
            result_words = (
                result.words[0]
                if result.words and isinstance(result.words[0], list)
                else result.words
            )
            for word in result_words or []:
                word_text = word.word.strip()
                word_start_ms = offset_ms + round(word.start_ts * 1000)
                word_end_ms = min(window_end_ms, offset_ms + round(word.end_ts * 1000))
                word_midpoint_ms = (word_start_ms + word_end_ms) // 2
                if (
                    not word_text
                    or word_end_ms <= word_start_ms
                    or not keep_start_ms <= word_midpoint_ms < keep_end_ms
                    or not _point_in_speech(word_midpoint_ms, speech_regions)
                ):
                    continue
                words.append(
                    TranscriptWord(
                        text=word_text,
                        start_ms=word_start_ms,
                        end_ms=word_end_ms,
                        confidence=None,
                    )
                )
            if progress_callback:
                progress_callback(chunk_index / len(windows))
        if progress_callback:
            progress_callback(1.0)
        return TranscriptionResult(
            transcript=" ".join(word.text for word in words),
            language_probability=None,
            audio_regions=audio_regions,
            words=words,
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
