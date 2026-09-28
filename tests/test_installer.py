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


def test_bundle_check_rejects_host_cmudict_when_bundle_corpus_is_missing(
    tmp_path: Path,
) -> None:
    import faster_whisper
    from faster_whisper import vad

    package_root = Path(faster_whisper.__file__).resolve().parent
    original_loader = vad.SileroVADModel
    vad.get_vad_model.cache_clear()
    try:
        vad.SileroVADModel = lambda path: path
        source_asset = Path(vad.get_vad_model()).resolve()
    finally:
        vad.SileroVADModel = original_loader
        vad.get_vad_model.cache_clear()

    bundle = tmp_path / "bundle"
    asset = bundle / "_internal" / source_asset.relative_to(package_root.parent)
    asset.parent.mkdir(parents=True)
    asset.write_bytes(source_asset.read_bytes())

    result = subprocess.run(
        [sys.executable, "installer/check_bundle.py", "--bundle", str(bundle)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "cmudict" in result.stderr


@pytest.mark.skipif(sys.platform != "win32", reason="Windows installer")
@pytest.mark.parametrize("failure", [None, "checksum", "missing", "traversal"])
@pytest.mark.parametrize("commands_unavailable", [False, True])
def test_install_upgrade_preserves_previous_on_failure(
    tmp_path: Path, failure: str | None, commands_unavailable: bool
) -> None:
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
    powershell = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]
    if commands_unavailable:
        installer = Path("installer/InstallPayload.ps1").resolve().as_posix().replace("'", "''")
        bootstrap = tmp_path / "run-installer.ps1"
        bootstrap.write_text(
            f"function Get-FileHash {{ throw 'Get-FileHash is unavailable' }}\n"
            f"function Expand-Archive {{ throw 'Expand-Archive is unavailable' }}\n"
            f". '{installer}' -DownloadDirectory $args[0] -Destination $args[1]\n"
            "exit $LASTEXITCODE\n",
            encoding="utf-8",
        )
        command = [*powershell, "-File", str(bootstrap), str(output), str(destination)]
    else:
        command = [*powershell, "-File", "installer/InstallPayload.ps1",
                   "-DownloadDirectory", str(output), "-Destination", str(destination)]
    result = subprocess.run(
        command,
        capture_output=True,
        check=False,
    )
    error_log = output / "install-error.txt"
    diagnostic = result.stderr.decode(errors="replace")
    if error_log.exists():
        diagnostic += error_log.read_text(encoding="utf-8", errors="replace")
    assert user_data.read_text(encoding="utf-8") == "keep"
    assert not (destination / "escape.txt").exists()
    if failure:
        assert result.returncode != 0
        assert result.stderr
        if failure == "checksum":
            assert "Checksum mismatch" in diagnostic
        elif failure == "missing":
            assert "Application file missing" in diagnostic
        else:
            assert "Archive contains an unsafe path" in diagnostic
        assert (runtime / "previous.txt").read_text(encoding="utf-8") == "previous"
    else:
        assert result.returncode == 0, diagnostic
        assert (runtime / "installed.marker").read_text(encoding="utf-8") == "1.2.3"
        assert (runtime / "Madnolia.exe").read_text(encoding="utf-8") == "new server"
        assert not (destination / "runtime.previous").exists()
