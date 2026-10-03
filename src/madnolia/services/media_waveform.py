import wave
from functools import lru_cache
from pathlib import Path

import numpy as np

from madnolia.types.common import WaveformData


@lru_cache(maxsize=64)
def _waveform(audio_path: Path, start_ms: int, end_ms: int, bins: int) -> WaveformData:
    with wave.open(str(audio_path), "rb") as audio:
        sample_rate = audio.getframerate()
        total_frames = audio.getnframes()
        start_frame = min(total_frames, round(start_ms * sample_rate / 1000))
        end_frame = min(total_frames, round(end_ms * sample_rate / 1000))
        frame_count = max(0, end_frame - start_frame)
        audio.setpos(start_frame)
        peaks: list[float] = []
        previous_boundary = 0
        for index in range(1, bins + 1):
            boundary = round(frame_count * index / bins)
            raw = audio.readframes(boundary - previous_boundary)
            samples = np.frombuffer(raw, dtype=np.int16)
            peak = float(np.max(np.abs(samples.astype(np.int32))) / 32768) if samples.size else 0.0
            peaks.append(peak)
            previous_boundary = boundary
    return WaveformData(start_ms=start_ms, end_ms=end_ms, peaks=peaks)
