import os
from functools import lru_cache

from madnolia.constants import (
    CPU_DEVICE,
    GPU_VENDOR_PRIORITY,
    WINDOWS_DISPLAY_CLASS_GUID,
    WINDOWS_PCI_REGISTRY_PATH,
)
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
    import winreg

    adapters = []
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, WINDOWS_PCI_REGISTRY_PATH) as pci:
            for index in range(winreg.QueryInfoKey(pci)[0]):
                device_id = winreg.EnumKey(pci, index)
                if not any(vendor_id in device_id.upper() for vendor_id, *_ in GPU_VENDOR_PRIORITY):
                    continue
                with winreg.OpenKey(pci, device_id) as device:
                    for instance_index in range(winreg.QueryInfoKey(device)[0]):
                        try:
                            with winreg.OpenKey(device, winreg.EnumKey(device, instance_index)) as instance:
                                class_guid = winreg.QueryValueEx(instance, "ClassGUID")[0]
                                if class_guid.lower() == WINDOWS_DISPLAY_CLASS_GUID:
                                    adapters.append(device_id.upper())
                        except OSError:
                            continue
    except OSError:
        return []
    return adapters


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
