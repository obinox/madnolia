import json
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, r".runtime-audit/review-final-bundle/_internal")
from faster_whisper.audio import decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps, get_vad_model

root = Path("web/tests/fixtures")
root.mkdir(parents=True, exist_ok=True)
model = get_vad_model()


def probabilities(audio):
    window = 512
    padded = np.pad(audio, (0, window - audio.shape[0] % window))
    return model(padded).reshape(-1).tolist()


def record(name, audio):
    audio = audio.astype(np.float32)
    prob = probabilities(audio)
    regions = get_speech_timestamps(audio, VadOptions(threshold=0.5, min_speech_duration_ms=250, min_silence_duration_ms=500, speech_pad_ms=200))
    return {"name": name, "audio_length_samples": len(audio), "probabilities": prob, "speech_samples": regions}


jfk = decode_audio(r".runtime-audit/final-full-asr-smoke/jfk.wav", sampling_rate=16000)
duration = 3 * 16000
t = np.arange(duration, dtype=np.float32) / 16000
tone = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
cases = [record("silence", np.zeros(duration, dtype=np.float32)), record("tone_220hz", tone), record("jfk_english_speech", jfk)]
chunk_size = 30 * 16000
chunk_audio = [
    np.concatenate((jfk, np.zeros(chunk_size - len(jfk), dtype=np.float32))),
    np.concatenate((jfk, np.zeros(5 * 16000, dtype=np.float32))),
]
chunk_reset = {
    "name": "jfk_restarted_at_30s_boundary",
    "audio_length_samples": sum(map(len, chunk_audio)),
    "chunks": [
        {
            "audio_length_samples": len(audio),
            "probabilities": probabilities(audio),
            "speech_samples": get_speech_timestamps(audio, VadOptions(threshold=0.5, min_speech_duration_ms=250, min_silence_duration_ms=500, speech_pad_ms=200)),
        }
        for audio in chunk_audio
    ],
}
(root / "silero-vad-reference.json").write_text(json.dumps({"model": "Silero VAD v6 / faster-whisper 1.2.1", "sample_rate": 16000, "cases": cases, "chunk_reset_case": chunk_reset}, separators=(",", ":")))
