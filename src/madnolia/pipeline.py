import json
import os
import shutil
from dataclasses import replace
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
    SCHEMA_VERSION,
    SUPPORTED_VIDEO_EXTENSIONS,
)
from madnolia.ctc_alignment import PhonemeCtcAligner
from madnolia.hierarchy import segment_sentences
from madnolia.media import get_cached_audio, inspect_media
from madnolia.phonetics import KoreanPhonetics
from madnolia.projects import analysis_audio_path
from madnolia.storage import (
    initialize_database,
    load_analysis,
    save_analysis,
    save_project,
    write_json,
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
        analysis_dir = project_dir / "analysis"
        project_dir.mkdir(parents=True, exist_ok=False)
        connection = initialize_database(project_dir / "corpus.sqlite3")
        results: list[AnalysisResult] = []
        embedding_sets: list[np.ndarray] = []
        analysis_files: list[str] = []
        audio_files: dict[str, str] = {}
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
                transcript_candidates = [_transcript_candidate(0, self._model_name, transcription)]
                for candidate_index, model_name in enumerate(self._candidate_models, start=1):
                    candidate = self._create_transcriber(model_name).transcribe(
                        audio_path,
                        transcription.audio_regions,
                        progress_callback=lambda fraction, candidate_index=candidate_index: (
                            transcription_progress(fraction, candidate_index)
                        ),
                    )
                    transcript_candidates.append(
                        _transcript_candidate(candidate_index, model_name, candidate)
                    )
                report("발음 정렬", ANALYSIS_PROGRESS_ALIGNMENT)
                if self._alignment_mode == AlignmentMode.CTC:
                    phones = align_phone_occurrences(
                        source_id,
                        audio_path,
                        transcription.words,
                        sentences,
                        phonetics,
                        PhonemeCtcAligner(device=self._device),
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
                            HubertUnitEncoder(device=self._device),
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
            acoustic_unit_centroids_file = None
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
                centroids_path = analysis_dir / "acoustic_unit_centroids.npy"
                centroids_path.parent.mkdir(parents=True, exist_ok=True)
                np.save(centroids_path, centroids)
                acoustic_unit_centroids_file = centroids_path.relative_to(project_dir).as_posix()
            for result in results:
                report("분석 결과 저장", ANALYSIS_PROGRESS_STORAGE)
                result_path = analysis_dir / f"{result.source.source_id}.json"
                write_json(result_path, result.to_dict())
                save_analysis(connection, result)
                analysis_files.append(result_path.relative_to(project_dir).as_posix())
        except AnalysisCancelled:
            connection.close()
            shutil.rmtree(project_dir)
            raise
        finally:
            connection.close()
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
            analysis_files=analysis_files,
            database_file="corpus.sqlite3",
            candidate_models=self._candidate_models,
            acoustic_unit_centroids_file=acoustic_unit_centroids_file,
            audio_files=audio_files,
        )
        save_project(project_dir / "project.json", project)
        return project_dir

    def _create_transcriber(self, model_name: str) -> Transcriber:
        if self._backend == InferenceBackend.OPENVINO:
            return OpenVINOWhisperTranscriber(model_name, self._device)
        return LocalWhisperTranscriber(model_name)


def finalize_project(
    project_dir: Path,
    model_name: str,
    backend: InferenceBackend,
    device: str,
    alignment_mode: AlignmentMode = AlignmentMode.ESTIMATED,
) -> Path:
    analysis_paths = sorted((project_dir / "analysis").glob("*.json"))
    if not analysis_paths:
        raise ValueError(f"분석 JSON이 없습니다: {project_dir}")
    results = [load_analysis(path) for path in analysis_paths]
    previous_path = project_dir / "project.json"
    previous = (
        json.loads(previous_path.read_text(encoding="utf-8")) if previous_path.is_file() else {}
    )
    audio_files = previous.get("audio_files", {})
    connection = initialize_database(project_dir / "corpus.sqlite3")
    try:
        for result in results:
            save_analysis(connection, result)
    finally:
        connection.close()
    created_at = datetime.fromtimestamp(project_dir.stat().st_ctime).astimezone()
    project = ProjectManifest(
        project_id=project_dir.name,
        schema_version=SCHEMA_VERSION,
        created_at=created_at.isoformat(),
        model_name=model_name,
        inference_backend=backend,
        inference_device=device,
        alignment_mode=alignment_mode,
        language="ko",
        sources=[result.source for result in results],
        analysis_files=[path.relative_to(project_dir).as_posix() for path in analysis_paths],
        database_file="corpus.sqlite3",
        candidate_models=list(
            dict.fromkeys(
                candidate.model_name
                for result in results
                for candidate in result.transcript_candidates
                if candidate.model_name != model_name
            )
        ),
        acoustic_unit_centroids_file=None,
        audio_files=audio_files,
    )
    save_project(project_dir / "project.json", project)
    return project_dir


def realign_project(
    project_dir: Path,
    device: str,
    discover_acoustic_units: bool,
) -> Path:
    analysis_paths = sorted((project_dir / "analysis").glob("source_*.json"))
    if not analysis_paths:
        raise ValueError(f"분석 JSON이 없습니다: {project_dir}")
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
    centroids_file = None
    if discover_acoustic_units:
        unit_ids, centroids = cluster_acoustic_units(embedding_sets)
        results = [
            replace(
                result,
                acoustic_features=apply_acoustic_unit_ids(result.acoustic_features, source_units),
            )
            for result, source_units in zip(results, unit_ids, strict=True)
        ]
        centroids_path = project_dir / "analysis" / "acoustic_unit_centroids.npy"
        np.save(centroids_path, centroids)
        centroids_file = centroids_path.relative_to(project_dir).as_posix()
    connection = initialize_database(project_dir / "corpus.sqlite3")
    try:
        for analysis_path, result in zip(analysis_paths, results, strict=True):
            write_json(analysis_path, result.to_dict())
            save_analysis(connection, result)
    finally:
        connection.close()
    manifest_path = project_dir / "project.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["schema_version"] = SCHEMA_VERSION
    manifest["alignment_mode"] = AlignmentMode.CTC.value
    manifest["acoustic_unit_centroids_file"] = centroids_file
    write_json(manifest_path, manifest)
    return project_dir


def _transcript_candidate(
    candidate_index: int,
    model_name: str,
    transcription: TranscriptionResult,
) -> TranscriptCandidate:
    return TranscriptCandidate(
        candidate_id=f"whisper_{candidate_index}_{model_name}",
        model_name=model_name,
        transcript=transcription.transcript,
        language_probability=transcription.language_probability,
        words=transcription.words,
        sentences=segment_sentences(transcription.words),
    )
