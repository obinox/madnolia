import json
import os
import shutil
from dataclasses import asdict, replace
from datetime import datetime
from pathlib import Path
from uuid import uuid4

import numpy as np

from madnolia.acoustic_features import analyze_phone_acoustics
from madnolia.acoustic_units import (
    HubertUnitEncoder,
    apply_acoustic_unit_ids,
    cluster_acoustic_units,
    extract_phone_embeddings,
)
from madnolia.alignment import align_phone_occurrences, estimate_phone_occurrences
from madnolia.constants import (
    ANALYSIS_PROGRESS_ALIGNMENT,
    ANALYSIS_PROGRESS_AUDIO,
    ANALYSIS_PROGRESS_FEATURES,
    ANALYSIS_PROGRESS_MEDIA,
    ANALYSIS_PROGRESS_STORAGE,
    ANALYSIS_PROGRESS_TRANSCRIPTION_END,
    CUDA_DEVICE,
    SCHEMA_VERSION,
    SUPPORTED_VIDEO_EXTENSIONS,
    XPU_DEVICE,
)
from madnolia.ctc_alignment import PhonemeCtcAligner
from madnolia.hierarchy import segment_sentences
from madnolia.media import get_cached_audio, inspect_media
from madnolia.phonetics import KoreanPhonetics
from madnolia.projects import analysis_audio_path
from madnolia.qwen_transcription import QwenASRTranscriber
from madnolia.storage import (
    load_analysis,
    publish_analysis_version,
)
from madnolia.transcription import LocalWhisperTranscriber, OpenVINOWhisperTranscriber
from madnolia.types.common import (
    AlignmentMode,
    AnalysisCancelled,
    AnalysisProgressCallback,
    AnalysisResult,
    InferenceBackend,
    ProjectManifest,
    Transcriber,
    TranscriptCandidate,
    TranscriptionResult,
)


class IngestionPipeline:
    def __init__(
        self,
        model_name: str,
        backend: InferenceBackend,
        device: str,
        candidate_models: list[str] | None = None,
        alignment_mode: AlignmentMode = AlignmentMode.ESTIMATED,
        discover_acoustic_units: bool = False,
    ) -> None:
        self._model_name = model_name
        self._backend = backend
        self._device = device
        self._alignment_mode = alignment_mode
        self._discover_acoustic_units = discover_acoustic_units
        self._candidate_models = [
            candidate_model
            for candidate_model in dict.fromkeys(candidate_models or [])
            if candidate_model != model_name
        ]

    def run(
        self,
        input_dir: Path,
        output_root: Path,
        selected_file: Path | None = None,
        on_progress: AnalysisProgressCallback | None = None,
    ) -> Path:
        def report(stage: str, percent: float) -> None:
            if on_progress:
                on_progress(stage, percent)

        if not input_dir.is_dir():
            raise ValueError(f"입력 폴더가 없습니다: {input_dir}")
        video_paths = sorted(
            path
            for path in input_dir.iterdir()
            if path.is_file() and path.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS
        )
        if selected_file is not None:
            selected_path = selected_file.resolve()
            video_paths = [path for path in video_paths if path.resolve() == selected_path]
        if not video_paths:
            raise ValueError(f"분석할 영상이 없습니다: {input_dir}")
        if len(video_paths) != 1:
            raise ValueError("영상 하나를 선택해 분석해야 합니다.")
        report("영상 확인", ANALYSIS_PROGRESS_MEDIA)
        phonetics = KoreanPhonetics()
        now = datetime.now().astimezone()
        project_id = f"proj_{now.strftime('%Y%m%d_%H%M%S')}_{uuid4().hex[:8]}"
        project_dir = output_root / project_id
        project_dir.mkdir(parents=True, exist_ok=False)
        results: list[AnalysisResult] = []
        embedding_sets: list[np.ndarray] = []
        audio_files: dict[str, str] = {}
        centroids: np.ndarray | None = None
        try:
            for index, video_path in enumerate(video_paths):
                source_id = f"source_{index}_{uuid4().hex[:12]}"
                source = inspect_media(source_id, video_path)
                progress_callback = None
                if on_progress:
                    progress_callback = lambda fraction: report(
                        "오디오 추출",
                        ANALYSIS_PROGRESS_MEDIA
                        + (ANALYSIS_PROGRESS_AUDIO - ANALYSIS_PROGRESS_MEDIA) * fraction,
                    )
                audio_path = get_cached_audio(video_path, progress_callback)
                audio_files[source_id] = Path(
                    os.path.relpath(audio_path.resolve(), project_dir.resolve())
                ).as_posix()
                report("오디오 추출 완료 · 모델 준비", ANALYSIS_PROGRESS_AUDIO)

                def transcription_progress(fraction: float, candidate_index: int) -> None:
                    total = 1 + len(self._candidate_models)
                    span = ANALYSIS_PROGRESS_TRANSCRIPTION_END - ANALYSIS_PROGRESS_AUDIO
                    percent = ANALYSIS_PROGRESS_AUDIO + (
                        span * (candidate_index + max(0.0, min(1.0, fraction))) / total
                    )
                    report("음성 전사", percent)

                transcription = self._create_transcriber(self._model_name).transcribe(
                    audio_path,
                    progress_callback=lambda fraction: transcription_progress(fraction, 0),
                )
                sentences = segment_sentences(transcription.words)
                transcript_candidates = [
                    _transcript_candidate(0, self._model_name, transcription, self._backend)
                ]
                for candidate_index, model_name in enumerate(self._candidate_models, start=1):
                    candidate = self._create_transcriber(model_name).transcribe(
                        audio_path,
                        transcription.audio_regions,
                        progress_callback=lambda fraction, candidate_index=candidate_index: (
                            transcription_progress(fraction, candidate_index)
                        ),
                    )
                    transcript_candidates.append(
                        _transcript_candidate(candidate_index, model_name, candidate, self._backend)
                    )
                report("발음 정렬", ANALYSIS_PROGRESS_ALIGNMENT)
                if self._alignment_mode == AlignmentMode.CTC:
                    phones = align_phone_occurrences(
                        source_id,
                        audio_path,
                        transcription.words,
                        sentences,
                        phonetics,
                        PhonemeCtcAligner(device=self._auxiliary_device),
                        checkpoint=lambda: report("발음 정렬", ANALYSIS_PROGRESS_ALIGNMENT),
                    )
                else:
                    phones = estimate_phone_occurrences(
                        source_id,
                        transcription.words,
                        phonetics,
                        sentences,
                    )
                acoustic_features = analyze_phone_acoustics(
                    audio_path,
                    phones,
                    checkpoint=lambda: report("음향 특성 계산", ANALYSIS_PROGRESS_FEATURES),
                )
                report("음향 특성 계산", ANALYSIS_PROGRESS_FEATURES)
                if self._discover_acoustic_units:
                    embedding_sets.append(
                        extract_phone_embeddings(
                            audio_path,
                            phones,
                            HubertUnitEncoder(device=self._auxiliary_device),
                            checkpoint=lambda: report("음향 단위 분석", ANALYSIS_PROGRESS_FEATURES),
                        )
                    )
                result = AnalysisResult(
                    source=source,
                    transcript=transcription.transcript,
                    language="ko",
                    language_probability=transcription.language_probability,
                    audio_regions=transcription.audio_regions,
                    sentences=sentences,
                    words=transcription.words,
                    phones=phones,
                    acoustic_features=acoustic_features,
                    transcript_candidates=transcript_candidates,
                )
                results.append(result)
            if self._discover_acoustic_units:
                unit_ids, centroids = cluster_acoustic_units(
                    embedding_sets,
                    checkpoint=lambda: report("음향 단위 군집화", ANALYSIS_PROGRESS_FEATURES),
                )
                results = [
                    replace(
                        result,
                        acoustic_features=apply_acoustic_unit_ids(
                            result.acoustic_features,
                            source_unit_ids,
                        ),
                    )
                    for result, source_unit_ids in zip(results, unit_ids, strict=True)
                ]
            report("분석 결과 저장", ANALYSIS_PROGRESS_STORAGE)
            project = ProjectManifest(
                project_id=project_id,
                schema_version=SCHEMA_VERSION,
                created_at=now.isoformat(),
                model_name=self._model_name,
                inference_backend=self._backend,
                inference_device=self._device,
                alignment_mode=self._alignment_mode,
                language="ko",
                sources=[result.source for result in results],
                analysis_files=[],
                database_file="",
                candidate_models=self._candidate_models,
                acoustic_unit_centroids_file=None,
                audio_files=audio_files,
            )
            publish_analysis_version(project_dir, results, project.to_dict(), centroids)
        except AnalysisCancelled:
            output_root_resolved = output_root.resolve()
            project_dir_resolved = project_dir.resolve()
            if project_dir_resolved.parent == output_root_resolved:
                shutil.rmtree(project_dir_resolved)
            raise
        return project_dir

    def _create_transcriber(self, model_name: str) -> Transcriber:
        if self._backend == InferenceBackend.OPENVINO:
            return OpenVINOWhisperTranscriber(model_name, self._device)
        if self._backend == InferenceBackend.QWEN_ASR:
            return QwenASRTranscriber(model_name, self._device)
        return LocalWhisperTranscriber(model_name, self._device)

    @property
    def _auxiliary_device(self) -> str:
        if self._device.upper() == CUDA_DEVICE:
            return "CPU"
        if self._device.upper() == XPU_DEVICE:
            return "GPU"
        return self._device


def finalize_project(
    project_dir: Path,
    model_name: str,
    backend: InferenceBackend,
    device: str,
    alignment_mode: AlignmentMode = AlignmentMode.ESTIMATED,
) -> Path:
    manifest_path = project_dir / "project.json"
    previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else None
    analysis_paths = _active_analysis_paths(project_dir, previous, "*.json")
    results = [load_analysis(path) for path in analysis_paths]
    centroids = _load_active_centroids(project_dir, previous)
    created_at = (
        previous.get("created_at")
        if previous is not None
        else datetime.fromtimestamp(project_dir.stat().st_ctime).astimezone().isoformat()
    )
    manifest = dict(previous or {})
    manifest.update(
        {
            "project_id": project_dir.name,
            "schema_version": SCHEMA_VERSION,
            "created_at": created_at,
            "model_name": model_name,
            "inference_backend": backend.value,
            "inference_device": device,
            "alignment_mode": alignment_mode.value,
            "language": "ko",
            "sources": [asdict(result.source) for result in results],
            "candidate_models": list(
                dict.fromkeys(
                    candidate.model_name
                    for result in results
                    for candidate in result.transcript_candidates
                    if candidate.model_name != model_name
                )
            ),
            "audio_files": dict((previous or {}).get("audio_files", {})),
        }
    )
    publish_analysis_version(project_dir, results, manifest, centroids)
    return project_dir


def realign_project(
    project_dir: Path,
    device: str,
    discover_acoustic_units: bool,
) -> Path:
    manifest_path = project_dir / "project.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(manifest_path)
    previous = json.loads(manifest_path.read_text(encoding="utf-8"))
    analysis_paths = _active_analysis_paths(project_dir, previous, "source_*.json")
    phonetics = KoreanPhonetics()
    results: list[AnalysisResult] = []
    embedding_sets: list[np.ndarray] = []
    for analysis_path in analysis_paths:
        result = load_analysis(analysis_path)
        sentences = result.sentences or segment_sentences(result.words)
        audio_path = analysis_audio_path(project_dir, result.source.source_id)
        phones = align_phone_occurrences(
            result.source.source_id,
            audio_path,
            result.words,
            sentences,
            phonetics,
            PhonemeCtcAligner(device=device),
        )
        features = analyze_phone_acoustics(audio_path, phones)
        if discover_acoustic_units:
            embedding_sets.append(
                extract_phone_embeddings(audio_path, phones, HubertUnitEncoder(device=device))
            )
        results.append(
            replace(
                result,
                sentences=sentences,
                phones=phones,
                acoustic_features=features,
            )
        )
    centroids = None
    if discover_acoustic_units:
        unit_ids, centroids = cluster_acoustic_units(embedding_sets)
        results = [
            replace(
                result,
                acoustic_features=apply_acoustic_unit_ids(result.acoustic_features, source_units),
            )
            for result, source_units in zip(results, unit_ids, strict=True)
        ]
    manifest = dict(previous)
    manifest.update(
        {
            "schema_version": SCHEMA_VERSION,
            "alignment_mode": AlignmentMode.CTC.value,
            "sources": [asdict(result.source) for result in results],
        }
    )
    publish_analysis_version(project_dir, results, manifest, centroids)
    return project_dir


def _active_analysis_paths(
    project_dir: Path,
    manifest: dict[str, object] | None,
    legacy_pattern: str,
) -> list[Path]:
    if manifest is None:
        paths = sorted((project_dir / "analysis").glob(legacy_pattern))
    else:
        analysis_files = manifest.get("analysis_files")
        if not isinstance(analysis_files, list) or not analysis_files:
            raise ValueError(f"Active manifest has no analysis files: {project_dir}")
        paths = [project_dir / str(relative_path) for relative_path in analysis_files]
        missing = [path for path in paths if not path.is_file()]
        if missing:
            raise FileNotFoundError(missing[0])
    if not paths:
        raise ValueError(f"No analysis JSON files: {project_dir}")
    return paths


def _load_active_centroids(
    project_dir: Path,
    manifest: dict[str, object] | None,
) -> np.ndarray | None:
    if manifest is None:
        return None
    relative_path = manifest.get("acoustic_unit_centroids_file")
    if not relative_path:
        return None
    return np.load(project_dir / str(relative_path))


def _transcript_candidate(
    candidate_index: int,
    model_name: str,
    transcription: TranscriptionResult,
    backend: InferenceBackend,
) -> TranscriptCandidate:
    return TranscriptCandidate(
        candidate_id=f"{'qwen' if backend == InferenceBackend.QWEN_ASR else 'whisper'}_{candidate_index}_{model_name}",
        model_name=model_name,
        transcript=transcription.transcript,
        language_probability=transcription.language_probability,
        words=transcription.words,
        sentences=segment_sentences(transcription.words),
    )
