import pytest
from fastapi.testclient import TestClient

from madnolia import hardware, viewer
from madnolia.types.common import DetectedAnalysisHardware, InferenceBackend


@pytest.mark.parametrize(
    ("adapters", "available", "expected"),
    [
        (["PCI\\VEN_8086", "PCI\\VEN_1002", "PCI\\VEN_10DE"], {"faster-whisper", "vulkan", "openvino"}, (InferenceBackend.FASTER_WHISPER, "CUDA", "NVIDIA")),
        (["PCI\\VEN_8086", "PCI\\VEN_1002"], {"vulkan", "openvino"}, (InferenceBackend.VULKAN, "VULKAN", "AMD")),
        (["PCI\\VEN_8086"], {"openvino"}, (InferenceBackend.OPENVINO, "GPU", "Intel")),
        (["PCI\\VEN_10DE", "PCI\\VEN_8086"], {"openvino"}, (InferenceBackend.OPENVINO, "GPU", "Intel")),
        ([], set(), (InferenceBackend.FASTER_WHISPER, "CPU", None)),
    ],
)
def test_gpu_detection_prefers_available_backend(monkeypatch, adapters, available, expected):
    hardware.detect_analysis_hardware.cache_clear()
    monkeypatch.setattr(hardware, "_windows_video_adapters", lambda: adapters)
    monkeypatch.setattr(hardware, "_backend_available", lambda backend: backend in available)
    selected = hardware.detect_analysis_hardware()
    assert (selected.backend, selected.device, selected.gpu_vendor) == expected
    hardware.detect_analysis_hardware.cache_clear()


def test_hardware_api_exposes_default(monkeypatch):
    detected = DetectedAnalysisHardware(InferenceBackend.VULKAN, "VULKAN", "AMD")
    monkeypatch.setattr(viewer, "detect_analysis_hardware", lambda: detected)
    assert TestClient(viewer.app).get("/api/analysis-hardware").json() == {
        "backend": "vulkan",
        "device": "VULKAN",
        "gpu_vendor": "AMD",
    }
