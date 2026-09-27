import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest


def _payload(tmp_path: Path, entries: dict[str, str]) -> Path:
    archive = tmp_path / "application.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        for name, value in entries.items():
            bundle.writestr(name, value)
    output = tmp_path / "package"
    subprocess.run(
        [sys.executable, "installer/package_release.py", "--archive", str(archive),
         "--output", str(output), "--repository", "owner/madnolia", "--tag", "v1.2.3"],
        check=True,
    )
    return output


def test_release_manifest_matches_download_bytes(tmp_path: Path) -> None:
    output = _payload(tmp_path, {"readme.txt": "payload"})
    manifest = json.loads((output / "payload.json").read_text(encoding="utf-8"))
    part = manifest["parts"][0]
    assert part["sha256"] == hashlib.sha256((output / part["name"]).read_bytes()).hexdigest()
    metadata = (output / "PayloadMetadata.iss").read_text(encoding="utf-8")
    assert f"/owner/madnolia/releases/download/v1.2.3/{part['name']}" in metadata
    assert part["sha256"] in metadata


@pytest.mark.skipif(sys.platform != "win32", reason="Windows installer")
@pytest.mark.parametrize("failure", [None, "checksum", "missing", "traversal"])
def test_install_upgrade_preserves_previous_on_failure(tmp_path: Path, failure: str | None) -> None:
    entries = {
        "Madnolia.exe": "new server",
        "MadnoliaLauncher.exe": "new launcher",
        "web/dist/index.html": "new UI",
    }
    if failure == "missing":
        del entries["MadnoliaLauncher.exe"]
    if failure == "traversal":
        entries["../escape.txt"] = "unsafe"
    output = _payload(tmp_path, entries)
    if failure == "checksum":
        (output / "Madnolia-windows-x64.part000").write_bytes(b"corrupt")
    destination = tmp_path / "app"
    runtime = destination / "runtime"
    runtime.mkdir(parents=True)
    (runtime / "previous.txt").write_text("previous", encoding="utf-8")
    user_data = tmp_path / "user-data.txt"
    user_data.write_text("keep", encoding="utf-8")
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-File", "installer/InstallPayload.ps1", "-DownloadDirectory", str(output),
         "-Destination", str(destination)],
        capture_output=True,
        check=False,
    )
    assert user_data.read_text(encoding="utf-8") == "keep"
    assert not (destination / "escape.txt").exists()
    if failure:
        assert result.returncode != 0
        assert (runtime / "previous.txt").read_text(encoding="utf-8") == "previous"
    else:
        assert result.returncode == 0, result.stderr
        assert (runtime / "installed.marker").read_text(encoding="utf-8") == "1.2.3"
        assert (runtime / "Madnolia.exe").read_text(encoding="utf-8") == "new server"
        assert not (destination / "runtime.previous").exists()
