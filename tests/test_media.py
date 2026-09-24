import json
from pathlib import Path

from madnolia import media


def test_extract_audio_reuses_cache(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")
    calls: list[Path] = []

    def fake_extract(path: Path, output_path: Path) -> None:
        calls.append(path)
        output_path.write_bytes(b"wav")

    monkeypatch.setattr(media, "AUDIO_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(media, "_extract_audio_uncached", fake_extract)

    progress = []
    first = media.get_cached_audio(source)
    second = media.get_cached_audio(source, progress.append)

    assert calls == [source]
    assert first == second
    assert first.read_bytes() == b"wav"
    assert len(list((tmp_path / "cache").glob("*.wav"))) == 1
    assert not list(tmp_path.glob("**/audio.wav"))
    assert progress == [1.0]
    recorded = json.loads(first.with_suffix(".json").read_text(encoding="utf-8"))
    assert recorded["source_video_path"] == str(source.resolve())
    assert recorded["wav_path"] == str(first.resolve())


def test_extract_audio_invalidates_cache_when_source_changes(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")
    calls: list[Path] = []

    def fake_extract(path: Path, output_path: Path) -> None:
        calls.append(path)
        output_path.write_bytes(b"wav")

    monkeypatch.setattr(media, "AUDIO_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(media, "_extract_audio_uncached", fake_extract)

    first = media.get_cached_audio(source)
    source.write_bytes(b"changed video")
    second = media.get_cached_audio(source)

    assert calls == [source, source]
    assert first != second
    assert first.is_file() and second.is_file()
