import wave
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.vad import VadOptions, get_speech_timestamps
from huggingface_hub import snapshot_download

from madnolia.constants import (
    MODEL_CACHE_DIR,
    OPENVINO_AUDIO_CHUNK_SECONDS,
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
    TranscriptionResult,
    TranscriptWord,
)


class LocalWhisperTranscriber:
    def __init__(self, model_name: str) -> None:
        self._model = WhisperModel(model_name, device="cpu", compute_type="int8")

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
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
        for segment in segments:
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
        duration_ms = _audio_duration_ms(audio_path)
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

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
        transcript_parts: list[str] = []
        words: list[TranscriptWord] = []
        speech_regions: list[AudioRegion] = []
        for chunk_index, (offset_ms, samples) in enumerate(_read_audio_chunks(audio_path), start=1):
            if chunk_index == 1 or chunk_index % 10 == 0:
                print(
                    f"OpenVINO 음성 청크 {chunk_index} 처리 중 ({offset_ms // 60000}분 지점)",
                    flush=True,
                )
            speech_timestamps = get_speech_timestamps(
                samples,
                VadOptions(
                    threshold=VAD_THRESHOLD,
                    min_speech_duration_ms=VAD_MIN_SPEECH_DURATION_MS,
                    min_silence_duration_ms=VAD_MIN_SILENCE_DURATION_MS,
                    speech_pad_ms=VAD_SPEECH_PAD_MS,
                ),
            )
            for timestamp in speech_timestamps:
                speech_start_ms = offset_ms + round(timestamp["start"] * 1000 / 16000)
                speech_end_ms = offset_ms + round(timestamp["end"] * 1000 / 16000)
                speech_regions.append(
                    AudioRegion(
                        region_type=AudioRegionType.SPEECH,
                        start_ms=speech_start_ms,
                        end_ms=speech_end_ms,
                    )
                )
                result = self._pipeline.generate(
                    samples[timestamp["start"] : timestamp["end"]],
                    language="ko",
                    task="transcribe",
                    return_timestamps=True,
                    word_timestamps=True,
                )
                text = result.texts[0].strip() if result.texts else ""
                if text:
                    transcript_parts.append(text)
                result_words = (
                    result.words[0]
                    if result.words and isinstance(result.words[0], list)
                    else result.words
                )
                for word in result_words or []:
                    word_text = word.word.strip()
                    if not word_text:
                        continue
                    word_start_ms = speech_start_ms + round(word.start_ts * 1000)
                    word_end_ms = min(speech_end_ms, speech_start_ms + round(word.end_ts * 1000))
                    if word_end_ms <= word_start_ms:
                        continue
                    words.append(
                        TranscriptWord(
                            text=word_text,
                            start_ms=word_start_ms,
                            end_ms=word_end_ms,
                            confidence=None,
                        )
                    )
        duration_ms = _audio_duration_ms(audio_path)
        return TranscriptionResult(
            transcript=" ".join(transcript_parts),
            language_probability=None,
            audio_regions=_complete_audio_regions(duration_ms, speech_regions),
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


def _audio_duration_ms(audio_path: Path) -> int:
    with wave.open(str(audio_path), "rb") as audio:
        return round(audio.getnframes() * 1000 / audio.getframerate())


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
