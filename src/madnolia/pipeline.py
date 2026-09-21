from datetime import datetime
from pathlib import Path
from uuid import uuid4

from madnolia.alignment import estimate_phone_occurrences
from madnolia.constants import SCHEMA_VERSION, SUPPORTED_VIDEO_EXTENSIONS
from madnolia.media import extract_audio, inspect_media
from madnolia.phonetics import KoreanPhonetics
from madnolia.storage import (
    initialize_database,
    load_analysis,
    save_analysis,
    save_project,
    write_json,
)
from madnolia.transcription import LocalWhisperTranscriber, OpenVINOWhisperTranscriber
from madnolia.types.common import AnalysisResult, InferenceBackend, ProjectManifest, Transcriber


class IngestionPipeline:
    def __init__(self, model_name: str, backend: InferenceBackend, device: str) -> None:
        self._model_name = model_name
        self._backend = backend
        self._device = device

    def run(self, input_dir: Path, output_root: Path, selected_file: Path | None = None) -> Path:
        if not input_dir.is_dir():
            raise ValueError(f"입력 폴더가 없습니다: {input_dir}")
        video_paths = sorted(
            path for path in input_dir.iterdir()
            if path.is_file() and path.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS
        )
        if selected_file is not None:
            selected_path = selected_file.resolve()
            video_paths = [path for path in video_paths if path.resolve() == selected_path]
        if not video_paths:
            raise ValueError(f"분석할 영상이 없습니다: {input_dir}")
        transcriber = self._create_transcriber()
        phonetics = KoreanPhonetics()
        now = datetime.now().astimezone()
        project_id = f"proj_{now.strftime('%Y%m%d_%H%M%S')}"
        project_dir = output_root / project_id
        audio_dir = project_dir / "audio"
        analysis_dir = project_dir / "analysis"
        project_dir.mkdir(parents=True, exist_ok=False)
        connection = initialize_database(project_dir / "corpus.sqlite3")
        results: list[AnalysisResult] = []
        analysis_files: list[str] = []
        try:
            for index, video_path in enumerate(video_paths):
                source_id = f"source_{index}_{uuid4().hex[:12]}"
                source = inspect_media(source_id, video_path)
                audio_path = audio_dir / f"{source_id}.wav"
                extract_audio(video_path, audio_path)
                transcription = transcriber.transcribe(audio_path)
                phones = estimate_phone_occurrences(source_id, transcription.words, phonetics)
                result = AnalysisResult(
                    source=source,
                    transcript=transcription.transcript,
                    language="ko",
                    language_probability=transcription.language_probability,
                    audio_regions=transcription.audio_regions,
                    words=transcription.words,
                    phones=phones,
                )
                result_path = analysis_dir / f"{source_id}.json"
                write_json(result_path, result.to_dict())
                save_analysis(connection, result)
                results.append(result)
                analysis_files.append(result_path.relative_to(project_dir).as_posix())
        finally:
            connection.close()
        project = ProjectManifest(
            project_id=project_id,
            schema_version=SCHEMA_VERSION,
            created_at=now.isoformat(),
            model_name=self._model_name,
            inference_backend=self._backend,
            inference_device=self._device,
            language="ko",
            sources=[result.source for result in results],
            analysis_files=analysis_files,
            database_file="corpus.sqlite3",
        )
        save_project(project_dir / "project.json", project)
        return project_dir

    def _create_transcriber(self) -> Transcriber:
        if self._backend == InferenceBackend.OPENVINO:
            return OpenVINOWhisperTranscriber(self._model_name, self._device)
        return LocalWhisperTranscriber(self._model_name)


def finalize_project(
    project_dir: Path,
    model_name: str,
    backend: InferenceBackend,
    device: str,
) -> Path:
    analysis_paths = sorted((project_dir / "analysis").glob("*.json"))
    if not analysis_paths:
        raise ValueError(f"분석 JSON이 없습니다: {project_dir}")
    results = [load_analysis(path) for path in analysis_paths]
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
        language="ko",
        sources=[result.source for result in results],
        analysis_files=[path.relative_to(project_dir).as_posix() for path in analysis_paths],
        database_file="corpus.sqlite3",
    )
    save_project(project_dir / "project.json", project)
    return project_dir
