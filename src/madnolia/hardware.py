import os
import subprocess
from functools import lru_cache

from madnolia.constants import CPU_DEVICE, GPU_VENDOR_PRIORITY, WINDOWS_VIDEO_ADAPTER_COMMAND
from madnolia.types.common import DetectedAnalysisHardware, InferenceBackend


@lru_cache(maxsize=1)
def detect_analysis_hardware() -> DetectedAnalysisHardware:
    adapters = _windows_video_adapters()
    for vendor_id, vendor, backend, device in GPU_VENDOR_PRIORITY:
        if any(vendor_id in adapter for adapter in adapters) and _backend_available(backend):
            return DetectedAnalysisHardware(InferenceBackend(backend), device, vendor)
    return DetectedAnalysisHardware(InferenceBackend.FASTER_WHISPER, CPU_DEVICE, None)


def _windows_video_adapters() -> list[str]:
    if os.name != "nt":
        return []
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_VIDEO_ADAPTER_COMMAND],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return []
    return [line.upper() for line in result.stdout.splitlines()]


def _backend_available(backend: str) -> bool:
    if backend == InferenceBackend.VULKAN:
        from madnolia.vulkan_transcription import _whisper_executable

        try:
            _whisper_executable()
            return True
        except FileNotFoundError:
            return False
    if backend == InferenceBackend.FASTER_WHISPER:
        import ctranslate2

        try:
            return (
                ctranslate2.get_cuda_device_count() > 0
                and bool(ctranslate2.get_supported_compute_types("cuda"))
            )
        except (OSError, RuntimeError, ValueError):
            return False
    import openvino as ov

    try:
        return "GPU" in ov.Core().available_devices
    except (OSError, RuntimeError):
        return False
