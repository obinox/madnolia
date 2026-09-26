import json
import subprocess
import wave

import pytest

from madnolia import vulkan_transcription
from madnolia.types.common import AudioRegion, AudioRegionType


def test_vulkan_transcription_reads_word_timestamps(tmp_path, monkeypatch):
    audio_path = tmp_path / "audio.wav"
    with wave.open(str(audio_path), "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\0\0" * 32000)

    class FakeProcess:
        returncode = 0

        def poll(self):
            return 0

    def fake_popen(command, **kwargs):
        prefix = command[command.index("-of") + 1]
        with open(prefix + ".json", "w", encoding="utf-8") as output:
            json.dump(
                {
                    "transcription": [
                        {"text": " 안녕", "offsets": {"from": 100, "to": 500}},
                        {"text": " 하세요", "offsets": {"from": 510, "to": 900}},
                    ]
                },
                output,
            )
        return FakeProcess()

    monkeypatch.setattr(vulkan_transcription, "GENERAL_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(vulkan_transcription.subprocess, "Popen", fake_popen)
    transcriber = vulkan_transcription.VulkanWhisperTranscriber.__new__(
        vulkan_transcription.VulkanWhisperTranscriber
    )
    transcriber._model_path = tmp_path / "model.bin"
    transcriber._executable = tmp_path / "whisper-cli.exe"
    progress = []
    result = transcriber.transcribe(audio_path, progress_callback=progress.append)

    assert result.transcript == "안녕 하세요"
    assert [(word.start_ms, word.end_ms) for word in result.words] == [(100, 500), (510, 900)]
    assert result.audio_regions == [
        AudioRegion(AudioRegionType.NON_SPEECH, 0, 100),
        AudioRegion(AudioRegionType.SPEECH, 100, 900),
        AudioRegion(AudioRegionType.NON_SPEECH, 900, 2000),
    ]
    assert progress[-1] == 1.0


def test_vulkan_transcription_cancellation_terminates_process(tmp_path, monkeypatch):
    audio_path = tmp_path / "audio.wav"
    with wave.open(str(audio_path), "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\0\0" * 16000)

    class FakeProcess:
        returncode = None
        terminated = False

        def poll(self):
            return 0 if self.terminated else None

        def wait(self, timeout=None):
            if not self.terminated:
                raise subprocess.TimeoutExpired("whisper-cli", timeout)
            self.returncode = -1
            return -1

        def terminate(self):
            self.terminated = True

    process = FakeProcess()
    monkeypatch.setattr(vulkan_transcription, "GENERAL_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(vulkan_transcription.subprocess, "Popen", lambda *a, **kw: process)
    transcriber = vulkan_transcription.VulkanWhisperTranscriber.__new__(
        vulkan_transcription.VulkanWhisperTranscriber
    )
    transcriber._model_path = tmp_path / "model.bin"
    transcriber._executable = tmp_path / "whisper-cli.exe"

    def cancel(_progress):
        raise ValueError("cancelled")

    with pytest.raises(ValueError, match="cancelled"):
        transcriber.transcribe(audio_path, progress_callback=cancel)
    assert process.terminated


def test_missing_vulkan_binary_does_not_download_model(monkeypatch):
    def missing_binary():
        raise FileNotFoundError("missing whisper-cli")

    def unexpected_download(*args, **kwargs):
        raise AssertionError("model downloaded before executable validation")

    monkeypatch.setattr(vulkan_transcription, "_whisper_executable", missing_binary)
    monkeypatch.setattr(vulkan_transcription, "ensure_vulkan_model", unexpected_download)
    with pytest.raises(FileNotFoundError, match="missing whisper-cli"):
        vulkan_transcription.VulkanWhisperTranscriber("small")


def test_model_prefetch_checks_binary_before_hub_request(monkeypatch):
    def missing_binary():
        raise FileNotFoundError("missing whisper-cli")

    def unexpected_hub_request(*args, **kwargs):
        raise AssertionError("hub requested before executable validation")

    monkeypatch.setattr(vulkan_transcription, "_whisper_executable", missing_binary)
    monkeypatch.setattr(vulkan_transcription, "model_info", unexpected_hub_request)
    with pytest.raises(FileNotFoundError, match="missing whisper-cli"):
        vulkan_transcription.ensure_vulkan_model("small")
