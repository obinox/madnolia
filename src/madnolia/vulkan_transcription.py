import json
import os
import re
import shutil
import subprocess
import sys
from functools import partial
from pathlib import Path
from tempfile import TemporaryDirectory

from huggingface_hub import hf_hub_download, model_info

from madnolia.constants import (
    GENERAL_CACHE_DIR,
    MODEL_CACHE_DIR,
    VULKAN_MODEL_FILES,
    VULKAN_MODEL_REPOSITORY,
)
from madnolia.transcription import _audio_duration_ms, _complete_audio_regions
from madnolia.types.common import (
    AnalysisCheckpoint,
    AudioRegion,
    AudioRegionType,
    ModelDownloadCallback,
    ModelDownloadProgressBar,
    TranscriptionProgressCallback,
    TranscriptionResult,
    TranscriptWord,
)


def ensure_vulkan_model(
    model_name: str,
    on_download: ModelDownloadCallback | None = None,
    checkpoint: AnalysisCheckpoint | None = None,
) -> Path:
    _whisper_executable()
    filename = VULKAN_MODEL_FILES.get(model_name)
    if filename is None:
        raise ValueError(f"Unsupported Vulkan model: {model_name}")
    directory = MODEL_CACHE_DIR / "vulkan"
    destination = directory / filename
    if checkpoint:
        checkpoint()
    if destination.is_file() and destination.stat().st_size > 0:
        return destination
    if on_download:
        on_download(model_name, 0.0)
    info = model_info(VULKAN_MODEL_REPOSITORY, files_metadata=True)
    expected = next(
        (item.size for item in info.siblings if item.rfilename == filename), None
    )

    def report(downloaded: int, total: int) -> None:
        if on_download:
            on_download(model_name, round(min(100, downloaded * 100 / max(total, 1)), 2))
        if checkpoint:
            checkpoint()

    directory.mkdir(parents=True, exist_ok=True)
    path = Path(
        hf_hub_download(
            VULKAN_MODEL_REPOSITORY,
            filename,
            local_dir=directory,
            tqdm_class=partial(ModelDownloadProgressBar, on_progress=report),
        )
    )
    if expected is not None and path.stat().st_size != expected:
        raise RuntimeError(f"Incomplete Vulkan model download: {filename}")
    if checkpoint:
        checkpoint()
    if on_download:
        on_download(model_name, 100.0)
    return path


class VulkanWhisperTranscriber:
    def __init__(self, model_name: str) -> None:
        self._executable = _whisper_executable()
        self._model_path = ensure_vulkan_model(model_name)

    def transcribe(
        self,
        audio_path: Path,
        audio_regions: list[AudioRegion] | None = None,
        progress_callback: TranscriptionProgressCallback | None = None,
    ) -> TranscriptionResult:
        GENERAL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(prefix="whisper-vulkan-", dir=GENERAL_CACHE_DIR) as temporary:
            prefix = Path(temporary) / "result"
            command = [
                str(self._executable),
                "-m", str(self._model_path),
                "-f", str(audio_path),
                "-l", "ko",
                "-oj",
                "-of", str(prefix),
                "-ml", "1",
                "-sow",
                "-pp",
            ]
            with (Path(temporary) / "log.txt").open("w+", encoding="utf-8") as log:
                process = subprocess.Popen(
                    command,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
                try:
                    while process.poll() is None:
                        if progress_callback:
                            log.seek(0)
                            matches = re.findall(r"progress\s*=\s*(\d+)%", log.read())
                            progress_callback(min(0.99, int(matches[-1]) / 100) if matches else 0.0)
                        try:
                            process.wait(timeout=0.5)
                        except subprocess.TimeoutExpired:
                            continue
                except BaseException:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                    raise
                if process.returncode:
                    log.seek(0)
                    raise RuntimeError(
                        f"Vulkan Whisper failed ({process.returncode}): {log.read()[-2000:]}"
                    )
            result_path = prefix.with_suffix(".json")
            if not result_path.is_file():
                raise RuntimeError("Vulkan Whisper did not produce JSON transcription")
            output = json.loads(result_path.read_text(encoding="utf-8-sig"))

        words = _parse_words(output)
        duration_ms = _audio_duration_ms(audio_path)
        if audio_regions is None:
            speech = [
                AudioRegion(AudioRegionType.SPEECH, word.start_ms, word.end_ms)
                for word in words
            ]
            audio_regions = _complete_audio_regions(duration_ms, speech)
        if progress_callback:
            progress_callback(1.0)
        return TranscriptionResult(
            transcript=" ".join(word.text for word in words),
            language_probability=None,
            audio_regions=audio_regions,
            words=words,
        )


def _parse_words(output: dict) -> list[TranscriptWord]:
    words: list[TranscriptWord] = []
    for segment in output.get("transcription", output.get("segments", [])):
        text = segment.get("text", "").strip()
        offsets = segment.get("offsets", {})
        start = offsets.get("from", segment.get("start"))
        end = offsets.get("to", segment.get("end"))
        if not text or start is None or end is None:
            continue
        start_ms = round(float(start) * 1000) if "offsets" not in segment else int(start)
        end_ms = round(float(end) * 1000) if "offsets" not in segment else int(end)
        if end_ms > start_ms:
            words.append(TranscriptWord(text, start_ms, end_ms, None))
    return words


def _whisper_executable() -> Path:
    if getattr(sys, "frozen", False):
        executable = Path(sys.executable).resolve().parent / "bin" / "whisper-cli.exe"
        if executable.is_file():
            return executable
    else:
        installed = shutil.which("whisper-cli")
        if installed:
            return Path(installed)
    raise FileNotFoundError("whisper-cli with Vulkan support is required")
