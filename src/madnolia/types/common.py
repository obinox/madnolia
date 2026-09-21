from dataclasses import asdict, dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol


class AlignmentMethod(StrEnum):
    ESTIMATED_WORD = "ESTIMATED_WORD"
    CTC_FORCED = "CTC_FORCED"


class InferenceBackend(StrEnum):
    FASTER_WHISPER = "faster-whisper"
    OPENVINO = "openvino"


class AudioRegionType(StrEnum):
    SPEECH = "SPEECH"
    NON_SPEECH = "NON_SPEECH"


@dataclass(frozen=True)
class MediaSource:
    source_id: str
    path: str
    duration_ms: int
    audio_sample_rate: int
    audio_channels: int
    video_width: int | None
    video_height: int | None
    video_fps: float | None


@dataclass(frozen=True)
class TranscriptWord:
    text: str
    start_ms: int
    end_ms: int
    confidence: float | None


@dataclass(frozen=True)
class AudioRegion:
    region_type: AudioRegionType
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class PhoneOccurrence:
    occurrence_id: str
    source_id: str
    word_index: int
    grapheme: str
    pronunciation: str
    phone_id: str
    ipa: str
    start_ms: int
    end_ms: int
    confidence: float | None
    alignment_method: AlignmentMethod


@dataclass(frozen=True)
class AnalysisResult:
    source: MediaSource
    transcript: str
    language: str
    language_probability: float | None
    audio_regions: list[AudioRegion]
    words: list[TranscriptWord]
    phones: list[PhoneOccurrence]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ProjectManifest:
    project_id: str
    schema_version: str
    created_at: str
    model_name: str
    inference_backend: InferenceBackend
    inference_device: str
    language: str
    sources: list[MediaSource]
    analysis_files: list[str]
    database_file: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class Transcriber(Protocol):
    def transcribe(self, audio_path: Path) -> "TranscriptionResult":
        ...


@dataclass(frozen=True)
class TranscriptionResult:
    transcript: str
    language_probability: float | None
    audio_regions: list[AudioRegion]
    words: list[TranscriptWord]


@dataclass(frozen=True)
class ProjectSummary:
    project_id: str
    created_at: str
    model_name: str
    inference_backend: str
    inference_device: str
    source_count: int
    total_duration_ms: int


@dataclass(frozen=True)
class AnalysisOverview:
    source_id: str
    transcript: str
    audio_regions: list[AudioRegion]
    word_count: int
    phone_count: int


@dataclass(frozen=True)
class TimelineSlice:
    start_ms: int
    end_ms: int
    audio_regions: list[AudioRegion]
    words: list[TranscriptWord]
    phones: list[PhoneOccurrence]


@dataclass(frozen=True)
class WaveformData:
    start_ms: int
    end_ms: int
    peaks: list[float]
