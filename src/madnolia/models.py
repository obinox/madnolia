from fnmatch import fnmatch
from functools import partial
from pathlib import Path

from huggingface_hub import hf_hub_download, model_info

from madnolia.constants import (
    ACOUSTIC_MODEL_INPUT_SAMPLES,
    CTC_MODEL_DIR,
    CTC_MODEL_REPOSITORY,
    CTC_OPENVINO_MODEL_PATH,
    FASTER_WHISPER_MODEL_REPOSITORIES,
    HUBERT_MODEL_REPOSITORY,
    HUBERT_OPENVINO_MODEL_PATH,
    MODEL_CACHE_DIR,
    OPENVINO_MODEL_REPOSITORIES,
)
from madnolia.types.common import (
    AlignmentMode,
    AnalysisCheckpoint,
    InferenceBackend,
    ModelDownloadCallback,
    ModelDownloadProgressBar,
)
from madnolia.vulkan_transcription import ensure_vulkan_model


def ensure_analysis_models(
    model_name: str,
    backend: InferenceBackend,
    candidate_models: list[str],
    alignment_mode: AlignmentMode,
    acoustic_units: bool,
    on_download: ModelDownloadCallback | None = None,
    checkpoint: AnalysisCheckpoint | None = None,
) -> None:
    for name in dict.fromkeys([model_name, *candidate_models]):
        if checkpoint:
            checkpoint()
        if backend == InferenceBackend.OPENVINO:
            repository = OPENVINO_MODEL_REPOSITORIES[name]
            directory = MODEL_CACHE_DIR / "openvino" / repository.rsplit("/", 1)[-1]
            required = (
                "openvino_encoder_model.xml",
                "openvino_decoder_model.xml",
                "openvino_tokenizer.xml",
                "openvino_detokenizer.xml",
            )
            metadata = (
                "config.json",
                "generation_config.json",
                "preprocessor_config.json",
                "tokenizer.json",
            )
            if not all((directory / item).is_file() for item in metadata) or not all(
                (directory / item).is_file() and (directory / item).with_suffix(".bin").is_file()
                for item in required
            ):
                _download_repository(
                    repository,
                    directory,
                    name,
                    ("openvino_*.xml", "openvino_*.bin", "*.json", "*.txt"),
                    on_download,
                    checkpoint,
                )
        elif backend == InferenceBackend.VULKAN:
            ensure_vulkan_model(name, on_download, checkpoint)
        else:
            repository = FASTER_WHISPER_MODEL_REPOSITORIES.get(name)
            if repository is None:
                continue
            directory = MODEL_CACHE_DIR / "faster-whisper" / name
            if not (directory / "model.bin").is_file() or not (directory / "config.json").is_file():
                _download_repository(
                    repository,
                    directory,
                    name,
                    ("*.bin", "*.json", "*.txt"),
                    on_download,
                    checkpoint,
                )
    if alignment_mode == AlignmentMode.CTC:
        _ensure_torch_model(
            CTC_MODEL_REPOSITORY,
            CTC_MODEL_DIR,
            CTC_OPENVINO_MODEL_PATH,
            "CTC 정렬",
            True,
            on_download,
            checkpoint,
        )
    if acoustic_units:
        _ensure_torch_model(
            HUBERT_MODEL_REPOSITORY,
            MODEL_CACHE_DIR / "huggingface" / "hubert-base-ls960",
            HUBERT_OPENVINO_MODEL_PATH,
            "HuBERT 음향 분석",
            False,
            on_download,
            checkpoint,
        )


def _ensure_torch_model(
    repository: str,
    source: Path,
    destination: Path,
    name: str,
    ctc: bool,
    on_download: ModelDownloadCallback | None,
    checkpoint: AnalysisCheckpoint | None,
) -> None:
    converted = destination.is_file() and destination.with_suffix(".bin").is_file()
    if converted and (not ctc or (source / "vocab.json").is_file()):
        return
    if converted:
        _download_repository(repository, source, name, ("vocab.json",), on_download, checkpoint)
        return
    cached = next(
        (item for item in ("model.safetensors", "pytorch_model.bin") if (source / item).is_file()),
        None,
    )
    complete = (
        cached
        and (source / "config.json").is_file()
        and (not ctc or (source / "vocab.json").is_file())
    )
    info = None if complete else model_info(repository, files_metadata=True)
    available = {item.rfilename for item in info.siblings} if info else set()
    weights = cached or (
        "model.safetensors" if "model.safetensors" in available else "pytorch_model.bin"
    )
    files = {"config.json", weights}
    if ctc:
        files.add("vocab.json")
    if not complete:
        _download_repository(repository, source, name, tuple(files), on_download, checkpoint, info)
    if checkpoint:
        checkpoint()
    if on_download:
        on_download(f"{name} 변환", 0.0)
    import openvino as ov
    import torch
    from transformers import AutoModel, AutoModelForCTC

    model = (AutoModelForCTC if ctc else AutoModel).from_pretrained(source, local_files_only=True)
    model.eval()
    with torch.no_grad():
        converted_model = ov.convert_model(
            model,
            example_input=torch.zeros((1, ACOUSTIC_MODEL_INPUT_SAMPLES)),
        )
    converted_model.reshape({converted_model.input(0): [1, -1]})
    if checkpoint:
        checkpoint()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name("openvino_model.partial.xml")
    ov.save_model(converted_model, temporary)
    temporary.replace(destination)
    temporary.with_suffix(".bin").replace(destination.with_suffix(".bin"))
    if on_download:
        on_download(f"{name} 변환", 100.0)


def _download_repository(
    repository: str,
    directory: Path,
    name: str,
    patterns: tuple[str, ...],
    on_download: ModelDownloadCallback | None,
    checkpoint: AnalysisCheckpoint | None,
    info=None,
) -> None:
    if on_download:
        on_download(name, 0.0)
    if checkpoint:
        checkpoint()
    info = info or model_info(repository, files_metadata=True)
    files = [
        item
        for item in info.siblings
        if any(fnmatch(item.rfilename, pattern) for pattern in patterns)
    ]
    if not files:
        raise ValueError(f"모델 파일이 없습니다: {repository}")
    total = sum(item.size or 1 for item in files)
    completed = 0
    for item in files:
        if checkpoint:
            checkpoint()
        size = item.size or 1
        path = directory / item.rfilename
        if path.is_file() and (item.size is None or path.stat().st_size == item.size):
            completed += size
            continue

        def report(
            downloaded: int,
            expected: int,
            file_size: int = size,
            known_size: bool = item.size is not None,
            prior: int = completed,
        ) -> None:
            if on_download:
                fraction = (
                    min(file_size, downloaded)
                    if known_size
                    else min(1, downloaded / max(expected, 1))
                )
                on_download(name, round((prior + fraction) * 100 / total, 2))
            if checkpoint:
                checkpoint()

        hf_hub_download(
            repository,
            item.rfilename,
            local_dir=directory,
            tqdm_class=partial(ModelDownloadProgressBar, on_progress=report),
        )
        completed += size
        if on_download:
            on_download(name, round(completed * 100 / total, 2))
    if on_download:
        on_download(name, 100.0)
