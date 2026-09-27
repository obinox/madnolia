import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from madnolia import viewer


def test_upload_streams_video_and_lists_it(monkeypatch, tmp_path):
    monkeypatch.setattr(viewer, "DEFAULT_INPUT_DIR", tmp_path)
    client = TestClient(viewer.app)

    response = client.post("/api/videos", files={"file": ("sample.MP4", b"video-data")})

    assert response.status_code == 200
    assert response.json() == {"filename": "sample.MP4"}
    assert (tmp_path / "sample.MP4").read_bytes() == b"video-data"
    assert client.get("/api/videos").json() == ["sample.MP4"]
    assert not list(tmp_path.glob(".upload-*.part"))


def test_duplicate_upload_gets_unique_name_without_replacing_original(monkeypatch, tmp_path):
    monkeypatch.setattr(viewer, "DEFAULT_INPUT_DIR", tmp_path)
    (tmp_path / "sample.mp4").write_bytes(b"original")
    client = TestClient(viewer.app)

    response = client.post("/api/videos", files={"file": ("sample.mp4", b"new-video")})

    assert response.status_code == 200
    uploaded_name = response.json()["filename"]
    assert uploaded_name != "sample.mp4"
    assert (tmp_path / "sample.mp4").read_bytes() == b"original"
    assert (tmp_path / uploaded_name).read_bytes() == b"new-video"


@pytest.mark.parametrize("filename", ["../escape.mp4", r"C:\\escape.mp4", "CON.mp4", "bad?.mp4", "notes.txt"])
def test_upload_rejects_unsafe_names_and_unsupported_extensions(monkeypatch, tmp_path, filename):
    monkeypatch.setattr(viewer, "DEFAULT_INPUT_DIR", tmp_path)

    upload = SimpleNamespace(filename=filename, read=AsyncMock(), close=AsyncMock())
    with pytest.raises(HTTPException) as error:
        asyncio.run(viewer.upload_video(make_request(), upload))

    assert error.value.status_code == 400
    assert list(tmp_path.iterdir()) == []


def test_upload_failure_removes_temporary_file(monkeypatch, tmp_path):
    monkeypatch.setattr(viewer, "DEFAULT_INPUT_DIR", tmp_path)

    broken_upload = SimpleNamespace(
        filename="sample.mp4",
        read=AsyncMock(side_effect=OSError("read failed")),
        close=AsyncMock(),
    )
    with pytest.raises(HTTPException) as error:
        asyncio.run(viewer.upload_video(make_request(), broken_upload))

    assert error.value.status_code == 500
    assert list(tmp_path.iterdir()) == []


def make_request(origin=None):
    headers = [(b"origin", origin.encode())] if origin else []
    return Request({
        "type": "http", "method": "POST", "path": "/api/videos", "headers": headers,
        "scheme": "http", "server": ("testserver", 80), "client": ("testclient", 1),
        "query_string": b"", "root_path": "",
    })
