import io
import json
import queue
import wave
from pathlib import Path
from types import SimpleNamespace

import pytest

from madnolia import transcription
from madnolia.pipeline import IngestionPipeline
from madnolia.transcription import _complete_audio_regions, _context_prompt, _speech_windows
from madnolia.types.common import (
    AnalysisCancelled,
    AudioRegion,
    AudioRegionType,
    InferenceBackend,
    TranscriptionChunkFailure,
    TranscriptWord,
)


def test_cuda_transcription_and_gpu_auxiliary_fallback(tmp_path, monkeypatch):
    created = []
    monkeypatch.setattr(transcription, "MODEL_CACHE_DIR", tmp_path)
    monkeypatch.setattr(
        transcription,
        "WhisperModel",
        lambda *args, **kwargs: created.append((args, kwargs)),
    )
    pipeline = IngestionPipeline("small", InferenceBackend.FASTER_WHISPER, "CUDA")
    assert pipeline._auxiliary_device == "CPU"
    assert IngestionPipeline("small", InferenceBackend.OPENVINO, "GPU")._auxiliary_device == "GPU"
    assert IngestionPipeline("qwen3-asr-0.6b", InferenceBackend.QWEN_ASR, "XPU")._auxiliary_device == "GPU"
    transcription.LocalWhisperTranscriber("small", "CUDA")
    assert created[0][1] == {"device": "cuda", "compute_type": "auto"}


def test_audio_regions_cover_full_timeline() -> None:
    speech_regions = [
        AudioRegion(AudioRegionType.SPEECH, 100, 200),
        AudioRegion(AudioRegionType.SPEECH, 500, 600),
    ]
    regions = _complete_audio_regions(1000, speech_regions)
    assert regions == [
        AudioRegion(AudioRegionType.NON_SPEECH, 0, 100),
        AudioRegion(AudioRegionType.SPEECH, 100, 600),
        AudioRegion(AudioRegionType.NON_SPEECH, 600, 1000),
    ]


def test_short_speech_region_is_one_exact_window() -> None:
    region = AudioRegion(AudioRegionType.SPEECH, 1000, 6000)
    assert list(_speech_windows([region])) == [(1000, 6000, 1000, 6000)]


def test_long_speech_region_has_contiguous_ownership() -> None:
    region = AudioRegion(AudioRegionType.SPEECH, 1000, 61_000)
    assert list(_speech_windows([region])) == [
        (1000, 31_000, 1000, 28_500),
        (26_000, 56_000, 28_500, 53_500),
        (51_000, 61_000, 53_500, 61_000),
    ]


def test_context_prompt_is_cleared_after_long_gap() -> None:
    words = [TranscriptWord("이전", 1000, 1200, None)]
    assert _context_prompt(words, 2000) == "이전"
    assert _context_prompt(words, 20_000) == ""


def test_chunk_checkpoint_resumes_and_retries_only_failed_chunk(tmp_path, monkeypatch):
    audio_path = tmp_path / "sample.wav"
    with wave.open(str(audio_path), "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\0\0" * 64000)
    monkeypatch.setattr(transcription, "TRANSCRIPTION_CHECKPOINT_DIR", tmp_path / "checkpoints")
    monkeypatch.setattr(
        transcription,
        "_speech_windows",
        lambda regions: iter([(0, 2000, 0, 2000), (2000, 4000, 2000, 4000)]),
    )
    attempts = []
    closed = []
    state = {"fail": True}

    class FakeWorker:
        def __init__(self, model_dir, device, callback):
            self.device = device

        def run(self, command, callback):
            attempts.append((command["start_ms"], self.device))
            if command["start_ms"] == 2000 and state["fail"]:
                raise TimeoutError("stuck")
            return {"words": [{"text": "hello", "start_ms": 0, "end_ms": 500}]}

        def close(self):
            closed.append(self.device)

    monkeypatch.setattr(transcription, "_OpenVINOWorker", FakeWorker)
    transcriber = transcription.OpenVINOWhisperTranscriber.__new__(
        transcription.OpenVINOWhisperTranscriber
    )
    transcriber._model_name = "large-v3"
    transcriber._model_dir = tmp_path
    transcriber._device = "GPU"
    regions = [AudioRegion(AudioRegionType.SPEECH, 0, 4000)]
    with pytest.raises(TranscriptionChunkFailure, match="2/2 at 0.03 min"):
        transcriber.transcribe(audio_path, regions)
    assert attempts == [(0, "GPU"), (2000, "GPU"), (2000, "GPU"), (2000, "CPU")]
    assert closed == ["GPU", "GPU", "CPU"]
    assert list((tmp_path / "checkpoints").rglob("failure.json"))
    attempts.clear()
    state["fail"] = False
    result = transcriber.transcribe(audio_path, regions)
    assert attempts == [(2000, "GPU")]
    assert [word.start_ms for word in result.words] == [0, 2000]
    assert not list((tmp_path / "checkpoints").rglob("failure.json"))


def test_worker_cancellation_is_not_retried(tmp_path, monkeypatch):
    audio_path = tmp_path / "sample.wav"
    with wave.open(str(audio_path), "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\0\0" * 16000)
    monkeypatch.setattr(transcription, "TRANSCRIPTION_CHECKPOINT_DIR", tmp_path / "checkpoints")

    class CancellingWorker:
        device = "GPU"

        def __init__(self, model_dir, device, callback):
            callback()

        def close(self):
            pass

    monkeypatch.setattr(transcription, "_OpenVINOWorker", CancellingWorker)
    transcriber = transcription.OpenVINOWhisperTranscriber.__new__(
        transcription.OpenVINOWhisperTranscriber
    )
    transcriber._model_name = "large-v3"
    transcriber._model_dir = tmp_path
    transcriber._device = "GPU"

    def cancel(fraction):
        raise AnalysisCancelled()

    with pytest.raises(AnalysisCancelled):
        transcriber.transcribe(audio_path, [AudioRegion(AudioRegionType.SPEECH, 0, 1000)], cancel)
    assert not list((tmp_path / "checkpoints").rglob("failure.json"))


def test_worker_response_wait_times_out_and_checks_cancellation(monkeypatch):
    monkeypatch.setattr(transcription, "OPENVINO_CHUNK_POLL_SECONDS", 0.001)

    class LiveProcess:
        def poll(self):
            return None

    worker = transcription._OpenVINOWorker.__new__(transcription._OpenVINOWorker)
    worker.device = "GPU"
    worker._responses = queue.Queue()
    worker._process = LiveProcess()
    checks = []
    with pytest.raises(TimeoutError, match="timed out"):
        worker._receive(0.01, lambda: checks.append(True))
    assert checks


def test_worker_request_json_escapes_korean_path_and_context():
    payload = {
        "audio_path": "C:\\Users\\test\\\uC790\uB8CC\\\uC74C\uC131.wav",
        "start_ms": 123,
        "end_ms": 456,
        "initial_prompt": "\uC548\uB155\uD558\uC138\uC694 \uBB38\uC7A5",
        "max_new_tokens": 64,
    }
    wire = io.StringIO()

    worker = transcription._OpenVINOWorker.__new__(transcription._OpenVINOWorker)
    worker.device = "CPU"
    worker._process = SimpleNamespace(stdin=wire)
    worker._receive = lambda timeout, callback: {"words": []}
    worker.run(payload, None)

    request = wire.getvalue().strip()
    assert request.isascii()
    assert json.loads(request) == payload


def test_worker_decodes_utf8_request_with_cp949_console(monkeypatch):
    import sys

    from madnolia import transcription_worker

    prompt = "\uD55C\uAD6D\uC5B4 \uBB38\uC7A5"
    audio_path = "C:\\Users\\test\\\uC790\uB8CC\\\uC74C\uC131.wav"
    request = json.dumps(
        {
            "audio_path": audio_path,
            "start_ms": 10,
            "end_ms": 20,
            "initial_prompt": prompt,
            "max_new_tokens": 64,
        },
        ensure_ascii=False,
    )
    stdin = io.TextIOWrapper(io.BytesIO((request + "\n").encode("utf-8")), encoding="cp949")
    stdout = io.StringIO()
    seen = {}
    response_text = "\uC74C\uC131 \uC778\uC2DD \uACB0\uACFC"

    def generate(samples, **options):
        seen["prompt"] = options["initial_prompt"]
        return SimpleNamespace(
            words=[SimpleNamespace(word=response_text, start_ts=0.1, end_ts=0.5)]
        )

    def read_audio_interval(*args):
        seen["audio_args"] = args
        return []

    monkeypatch.setitem(
        sys.modules,
        "openvino_genai",
        SimpleNamespace(
            WhisperPipeline=lambda *args, **kwargs: SimpleNamespace(generate=generate)
        ),
    )
    monkeypatch.setattr(transcription_worker, "_read_audio_interval", read_audio_interval)
    monkeypatch.setattr(transcription_worker.sys, "stdin", stdin)
    monkeypatch.setattr(transcription_worker.sys, "stdout", stdout)

    transcription_worker.run_openvino_worker(Path("model"), "CPU")

    assert seen["prompt"] == prompt
    assert seen["audio_args"] == (Path(audio_path), 10, 20)
    response_lines = stdout.getvalue().splitlines()
    assert all(line.isascii() for line in response_lines)
    responses = [json.loads(line) for line in response_lines]
    assert responses == [
        {"ready": True},
        {"words": [{"text": response_text, "start_ms": 100, "end_ms": 500}]},
    ]
