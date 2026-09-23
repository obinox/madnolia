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

    first = tmp_path / "first" / "audio.wav"
    second = tmp_path / "second" / "audio.wav"
    media.extract_audio(source, first)
    media.extract_audio(source, second)

    assert calls == [source]
    assert first.read_bytes() == b"wav"
    assert second.read_bytes() == b"wav"


def test_extract_audio_invalidates_cache_when_source_changes(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")
    calls: list[Path] = []

    def fake_extract(path: Path, output_path: Path) -> None:
        calls.append(path)
        output_path.write_bytes(b"wav")

    monkeypatch.setattr(media, "AUDIO_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(media, "_extract_audio_uncached", fake_extract)

    media.extract_audio(source, tmp_path / "first" / "audio.wav")
    source.write_bytes(b"changed video")
    media.extract_audio(source, tmp_path / "second" / "audio.wav")

    assert calls == [source, source]
