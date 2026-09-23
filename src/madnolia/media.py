import hashlib
import os
import shutil
import wave
from pathlib import Path

import av

from madnolia.constants import AUDIO_CACHE_DIR, AUDIO_CACHE_VERSION
from madnolia.types.common import MediaSource


def inspect_media(source_id: str, path: Path) -> MediaSource:
    with av.open(str(path)) as container:
        audio_stream = next(iter(container.streams.audio), None)
        video_stream = next(iter(container.streams.video), None)
        if audio_stream is None:
            raise ValueError("오디오 스트림이 없습니다.")
        duration_ms = int((container.duration or 0) / 1000)
        fps = float(video_stream.average_rate) if video_stream and video_stream.average_rate else None
        return MediaSource(
            source_id=source_id,
            path=str(path.resolve()),
            duration_ms=duration_ms,
            audio_sample_rate=audio_stream.codec_context.sample_rate,
            audio_channels=audio_stream.codec_context.channels,
            video_width=video_stream.codec_context.width if video_stream else None,
            video_height=video_stream.codec_context.height if video_stream else None,
            video_fps=fps,
        )


def extract_audio(path: Path, output_path: Path) -> None:
    cache_path = _audio_cache_path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if cache_path.is_file():
        _link_or_copy(cache_path, output_path)
        print(f"WAV 캐시 재사용: {cache_path}", flush=True)
        return
    _extract_audio_uncached(path, output_path)
    try:
        os.link(output_path, cache_path)
    except OSError:
        shutil.copy2(output_path, cache_path)


def _extract_audio_uncached(path: Path, output_path: Path) -> None:
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    with av.open(str(path)) as container, wave.open(str(output_path), "wb") as output:
        audio_stream = next(iter(container.streams.audio), None)
        if audio_stream is None:
            raise ValueError("오디오 스트림이 없습니다.")
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        for frame in container.decode(audio_stream):
            resampled = resampler.resample(frame)
            for audio_frame in resampled:
                output.writeframes(audio_frame.to_ndarray().tobytes())
        for audio_frame in resampler.resample(None):
            output.writeframes(audio_frame.to_ndarray().tobytes())


def _audio_cache_path(path: Path) -> Path:
    resolved = path.resolve()
    stat = resolved.stat()
    identity = f"{AUDIO_CACHE_VERSION}\0{resolved}\0{stat.st_size}\0{stat.st_mtime_ns}"
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    return AUDIO_CACHE_DIR / f"{digest}.wav"


def _link_or_copy(source: Path, destination: Path) -> None:
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)
