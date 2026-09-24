import hashlib
import os
import wave
from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

import av

from madnolia.constants import AUDIO_CACHE_DIR, AUDIO_CACHE_VERSION
from madnolia.storage import write_json
from madnolia.types.common import CachedAudioManifest, MediaProgressCallback, MediaSource


def inspect_media(source_id: str, path: Path) -> MediaSource:
    with av.open(str(path)) as container:
        audio_stream = next(iter(container.streams.audio), None)
        video_stream = next(iter(container.streams.video), None)
        if audio_stream is None:
            raise ValueError("오디오 스트림이 없습니다.")
        duration_ms = int((container.duration or 0) / 1000)
        fps = (
            float(video_stream.average_rate) if video_stream and video_stream.average_rate else None
        )
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


def get_cached_audio(
    path: Path,
    progress_callback: MediaProgressCallback | None = None,
) -> Path:
    cache_path = _audio_cache_path(path)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if cache_path.is_file():
        _record_audio_source(path, cache_path)
        if progress_callback:
            progress_callback(1.0)
        return cache_path
    temporary = cache_path.with_name(f"{cache_path.stem}.{uuid4().hex}.tmp")
    try:
        if progress_callback:
            _extract_audio_uncached(path, temporary, progress_callback)
        else:
            _extract_audio_uncached(path, temporary)
        os.replace(temporary, cache_path)
    finally:
        temporary.unlink(missing_ok=True)
    _record_audio_source(path, cache_path)
    return cache_path


def _record_audio_source(source: Path, audio: Path) -> None:
    manifest_path = audio.with_suffix(".json")
    if manifest_path.is_file():
        return
    original = source.resolve()
    stat = original.stat()
    manifest = CachedAudioManifest(
        source_video_path=str(original),
        wav_path=str(audio.resolve()),
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns,
    )
    temporary = manifest_path.with_name(f"{manifest_path.stem}.{uuid4().hex}.json.tmp")
    try:
        write_json(temporary, asdict(manifest))
        os.replace(temporary, manifest_path)
    finally:
        temporary.unlink(missing_ok=True)


def _extract_audio_uncached(
    path: Path,
    output_path: Path,
    progress_callback: MediaProgressCallback | None = None,
) -> None:
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    with av.open(str(path)) as container, wave.open(str(output_path), "wb") as output:
        audio_stream = next(iter(container.streams.audio), None)
        if audio_stream is None:
            raise ValueError("오디오 스트림이 없습니다.")
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        last_fraction = 0.0
        for frame in container.decode(audio_stream):
            resampled = resampler.resample(frame)
            for audio_frame in resampled:
                output.writeframes(audio_frame.to_ndarray().tobytes())
            if progress_callback and frame.time is not None and container.duration:
                fraction = min(1.0, max(0.0, frame.time * 1_000_000 / container.duration))
                if fraction - last_fraction >= 0.01:
                    progress_callback(fraction)
                    last_fraction = fraction
        for audio_frame in resampler.resample(None):
            output.writeframes(audio_frame.to_ndarray().tobytes())
        if progress_callback:
            progress_callback(1.0)


def _audio_cache_path(path: Path) -> Path:
    resolved = path.resolve()
    stat = resolved.stat()
    identity = f"{AUDIO_CACHE_VERSION}\0{resolved}\0{stat.st_size}\0{stat.st_mtime_ns}"
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    return AUDIO_CACHE_DIR / f"{digest}.wav"
