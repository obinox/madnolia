from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol

from tqdm.auto import tqdm

from madnolia.constants import (
    DEFAULT_ANALYSIS_ACOUSTIC_UNITS,
    DEFAULT_ANALYSIS_ALIGNMENT,
    DEFAULT_ANALYSIS_BACKEND,
    DEFAULT_ANALYSIS_DEVICE,
    DEFAULT_MODEL_NAME,
)

AnalysisProgressCallback = Callable[[str, float], None]
AnalysisCheckpoint = Callable[[], None]
ModelDownloadCallback = Callable[[str, float], None]
DownloadBytesCallback = Callable[[int, int], None]


class ModelDownloadProgressBar(tqdm):
    def __init__(self, *args: Any, on_progress: DownloadBytesCallback, **kwargs: Any) -> None:
        self._on_progress = on_progress
        super().__init__(*args, **kwargs)

    def update(self, n: int = 1) -> bool | None:
        updated = super().update(n)
        self._on_progress(self.n, int(self.total or 0))
        return updated


MediaProgressCallback = Callable[[float], None]
TranscriptionProgressCallback = Callable[[float], None]
TranscriptionWindow = tuple[int, int, int, int]


class AlignmentMethod(StrEnum):
    ESTIMATED_WORD = "ESTIMATED_WORD"
    CTC_FORCED = "CTC_FORCED"


class AlignmentStatus(StrEnum):
    ESTIMATED = "ESTIMATED"
    ALIGNED = "ALIGNED"
    LOW_CONFIDENCE = "LOW_CONFIDENCE"
    MISSING = "MISSING"


class InferenceBackend(StrEnum):
    FASTER_WHISPER = "faster-whisper"
    OPENVINO = "openvino"
    VULKAN = "vulkan"


@dataclass(frozen=True)
class DetectedAnalysisHardware:
    backend: InferenceBackend
    device: str
    gpu_vendor: str | None


class AlignmentMode(StrEnum):
    ESTIMATED = "estimated"
    CTC = "ctc"


class AnalysisJobStatus(StrEnum):
    RUNNING = "running"
    PAUSING = "pausing"
    PAUSED = "paused"
    STOPPING = "stopping"
    STOPPED = "stopped"
    COMPLETE = "complete"
    FAILED = "failed"


class AnalysisCancelled(Exception):
    pass


class TranscriptionChunkFailure(RuntimeError):
    pass


class AudioRegionType(StrEnum):
    SPEECH = "SPEECH"
    NON_SPEECH = "NON_SPEECH"


class UnitType(StrEnum):
    WORD = "WORD"
    SYLLABLE = "SYLLABLE"
    PHONEME = "PHONEME"
    PHONE_SEQUENCE = "PHONE_SEQUENCE"


class MatchStatus(StrEnum):
    EXACT = "EXACT"
    APPROXIMATE = "APPROXIMATE"
    MISSING = "MISSING"


class ExportTarget(StrEnum):
    JSON = "JSON"
    WAV = "WAV"
    MP4 = "MP4"
    EDL = "EDL"
    FCPXML = "FCPXML"


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
class CachedAudioManifest:
    source_video_path: str
    wav_path: str
    source_size: int
    source_mtime_ns: int


@dataclass(frozen=True)
class TranscriptWord:
    text: str
    start_ms: int
    end_ms: int
    confidence: float | None


@dataclass(frozen=True)
class TranscriptCandidate:
    candidate_id: str
    model_name: str
    transcript: str
    language_probability: float | None
    words: list[TranscriptWord]
    sentences: list["TranscriptSentence"]


@dataclass(frozen=True)
class TranscriptSentence:
    sentence_index: int
    text: str
    start_ms: int
    end_ms: int
    word_start_index: int
    word_end_index: int


@dataclass(frozen=True)
class PhoneTarget:
    sentence_index: int
    word_index: int
    grapheme: str
    pronunciation: str
    phone_id: str
    ipa: str


@dataclass(frozen=True)
class CtcPhoneBoundary:
    phone_index: int
    ipa: str
    start_ms: int | None
    end_ms: int | None
    confidence: float
    status: AlignmentStatus


@dataclass(frozen=True)
class AudioRegion:
    region_type: AudioRegionType
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class PhoneOccurrence:
    occurrence_id: str
    source_id: str
    sentence_index: int
    word_index: int
    grapheme: str
    pronunciation: str
    phone_id: str
    ipa: str
    start_ms: int
    end_ms: int
    confidence: float | None
    alignment_method: AlignmentMethod
    alignment_status: AlignmentStatus


@dataclass(frozen=True)
class PhoneAcousticFeatures:
    occurrence_id: str
    rms_db: float
    peak_db: float
    f0_hz: float | None
    voiced_probability: float
    acoustic_unit_id: int | None


@dataclass(frozen=True)
class AnalysisResult:
    source: MediaSource
    transcript: str
    language: str
    language_probability: float | None
    audio_regions: list[AudioRegion]
    sentences: list[TranscriptSentence]
    words: list[TranscriptWord]
    phones: list[PhoneOccurrence]
    acoustic_features: list[PhoneAcousticFeatures]
    transcript_candidates: list[TranscriptCandidate]

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
    alignment_mode: AlignmentMode
    language: str
    sources: list[MediaSource]
    analysis_files: list[str]
    database_file: str
    candidate_models: list[str]
    acoustic_unit_centroids_file: str | None
    audio_files: dict[str, str] = field(default_factory=dict)
    nickname: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class Transcriber(Protocol):
    def transcribe(
        self,
        audio_path: Path,
        audio_regions: list[AudioRegion] | None = None,
        progress_callback: TranscriptionProgressCallback | None = None,
    ) -> "TranscriptionResult": ...


@dataclass(frozen=True)
class TranscriptionResult:
    transcript: str
    language_probability: float | None
    audio_regions: list[AudioRegion]
    words: list[TranscriptWord]


@dataclass(frozen=True)
class ProjectSummary:
    project_id: str
    name: str
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
    sentences: list[TranscriptSentence]
    words: list[TranscriptWord]
    transcript_candidates: list[TranscriptCandidate]
    word_count: int
    phone_count: int


@dataclass(frozen=True)
class TimelineSlice:
    start_ms: int
    end_ms: int
    audio_regions: list[AudioRegion]
    words: list[TranscriptWord]
    phones: list[PhoneOccurrence]
    acoustic_features: list[PhoneAcousticFeatures]


@dataclass(frozen=True)
class WaveformData:
    start_ms: int
    end_ms: int
    peaks: list[float]


@dataclass(frozen=True)
class QueryPhone:
    target_index: int
    grapheme: str
    phone_id: str
    ipa: str
    exact_available: bool


@dataclass(frozen=True)
class UnitCandidate:
    candidate_id: str
    target_start_index: int
    target_end_index: int
    target_ipa: list[str]
    matched_ipa: list[str]
    occurrence_ids: list[str]
    source_id: str
    source_start_ms: int
    source_end_ms: int
    unit_type: UnitType
    match_status: MatchStatus
    similarity: float
    score: float


@dataclass(frozen=True)
class CandidateSearchResult:
    target_text: str
    target_pronunciation: str
    target_phones: list[QueryPhone]
    candidates: list[UnitCandidate]


@dataclass(frozen=True)
class SearchRequest:
    text: str
    max_candidates_per_start: int = 8


@dataclass(frozen=True)
class TimelineSegment:
    segment_id: str
    candidate_id: str
    target_start_index: int
    target_end_index: int
    source_id: str
    source_start_ms: int
    source_end_ms: int
    timeline_start_ms: int
    timeline_end_ms: int
    match_status: MatchStatus
    target_ipa: list[str]
    matched_ipa: list[str]
    gap_before_ms: int = 0
    stretch_percent: int = 100


@dataclass(frozen=True)
class CompositionProject:
    composition_id: str
    corpus_project_id: str
    name: str
    target_text: str
    target_pronunciation: str
    created_at: str
    updated_at: str
    crossfade_ms: int
    segments: list[TimelineSegment]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SaveCompositionRequest:
    name: str
    target_text: str
    target_pronunciation: str
    crossfade_ms: int
    segments: list[TimelineSegment]


@dataclass(frozen=True)
class CreateCollageRequest:
    project_id: str
    composition: SaveCompositionRequest


@dataclass(frozen=True)
class CreateProjectRequest:
    name: str
    analysis_ids: list[str]


@dataclass(frozen=True)
class CreateAnalysisRequest:
    filename: str
    model_name: str = DEFAULT_MODEL_NAME
    backend: InferenceBackend = field(
        default_factory=lambda: InferenceBackend(DEFAULT_ANALYSIS_BACKEND)
    )
    device: str = DEFAULT_ANALYSIS_DEVICE
    alignment_mode: AlignmentMode = field(
        default_factory=lambda: AlignmentMode(DEFAULT_ANALYSIS_ALIGNMENT)
    )
    candidate_models: list[str] = field(default_factory=list)
    acoustic_units: bool = DEFAULT_ANALYSIS_ACOUSTIC_UNITS
    nickname: str = ""


@dataclass(frozen=True)
class RenameAnalysisRequest:
    nickname: str


@dataclass
class AnalysisJob:
    job_id: str
    filename: str
    status: str
    percent: float
    stage: str
    analysis_id: str | None = None
    error: str | None = None
    download_model: str | None = None
    download_percent: float | None = None
