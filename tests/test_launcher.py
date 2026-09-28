import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from madnolia import launcher, portable
from madnolia.constants import (
    APPLICATION_ID,
    DEFAULT_INPUT_DIR,
    GENERAL_CACHE_DIR,
    HUGGINGFACE_CACHE_DIR,
    INSTALLED_DATA_DIRECTORY,
    INSTALLED_MODE_MARKER,
    LAUNCHER_ENVIRONMENT_VARIABLE,
    LAUNCHER_LOCK_FILE,
    NLTK_DATA_DIR,
    TORCH_CACHE_DIR,
)


def test_launcher_data_directory_uses_windows_user_data(monkeypatch, tmp_path: Path) -> None:
    executable_root = tmp_path / "app"
    executable_root.mkdir()
    (executable_root / INSTALLED_MODE_MARKER).touch()
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "user"))
    monkeypatch.setattr(launcher.sys, "frozen", True, raising=False)
    monkeypatch.setattr(launcher.sys, "executable", str(executable_root / "MadnoliaLauncher.exe"))

    assert launcher.data_directory() == tmp_path / "user" / INSTALLED_DATA_DIRECTORY


def test_portable_launcher_matches_server_data_directory(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(launcher.sys, "frozen", True, raising=False)
    monkeypatch.setattr(launcher.sys, "executable", str(tmp_path / "MadnoliaLauncher.exe"))

    assert launcher.data_directory() == tmp_path


def test_installed_runtime_uses_user_data_and_portable_runtime_stays_local(tmp_path: Path) -> None:
    executable_root = tmp_path / "install"
    local_app_data = tmp_path / "user"
    executable_root.mkdir()

    assert portable.runtime_root(executable_root, local_app_data) == executable_root
    (executable_root / INSTALLED_MODE_MARKER).touch()

    assert portable.runtime_root(executable_root, local_app_data) == (
        local_app_data / INSTALLED_DATA_DIRECTORY
    )


def test_existing_server_must_report_matching_install_data_root(tmp_path: Path) -> None:
    root = tmp_path / "Madnolia"
    payload = {"app": APPLICATION_ID, "data_root": str(root)}

    assert launcher.matches_installed_data(payload, root)
    assert not launcher.matches_installed_data(payload, tmp_path / "Other")
    assert not launcher.matches_installed_data({"app": APPLICATION_ID}, root)


def test_probe_health_accepts_only_madnolia_identity(monkeypatch) -> None:
    response = MagicMock()
    response.__enter__.return_value = response
    payload = {"status": "ok", "app": APPLICATION_ID, "data_root": "/data"}
    response.read.return_value = json.dumps(payload).encode()
    monkeypatch.setattr(launcher.urllib.request, "urlopen", lambda *_args, **_kwargs: response)

    assert launcher.probe_health() == payload


def test_probe_health_rejects_other_local_service(monkeypatch) -> None:
    response = MagicMock()
    response.__enter__.return_value = response
    response.read.return_value = b'{"status":"ok"}'
    monkeypatch.setattr(launcher.urllib.request, "urlopen", lambda *_args, **_kwargs: response)

    assert launcher.probe_health() is None


@pytest.mark.parametrize("installed", [False, True])
def test_frozen_runtime_selects_persistent_paths_and_preserves_cli(
    monkeypatch, tmp_path: Path, installed: bool
) -> None:
    executable_root = tmp_path / "application"
    executable_root.mkdir()
    local_app_data = tmp_path / "user"
    expected_root = local_app_data / INSTALLED_DATA_DIRECTORY if installed else executable_root
    if installed:
        (executable_root / INSTALLED_MODE_MARKER).touch()
    internal_root = tmp_path / "internal"
    torch_library_root = internal_root / "torch" / "lib"
    torch_library_root.mkdir(parents=True)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("LOCALAPPDATA", str(local_app_data))
    monkeypatch.setenv(LAUNCHER_ENVIRONMENT_VARIABLE, "1")
    for name in ("HF_HOME", "TORCH_HOME", "NLTK_DATA", "XDG_CACHE_HOME"):
        monkeypatch.setenv(name, "original")
    monkeypatch.setattr(portable.sys, "frozen", True, raising=False)
    monkeypatch.setattr(portable.sys, "executable", str(executable_root / "Madnolia.exe"))
    monkeypatch.setattr(portable.sys, "_MEIPASS", str(internal_root), raising=False)
    monkeypatch.setattr(portable.sys, "argv", ["Madnolia.exe", "viewer", "--port", "9000"])
    dll_handles = [MagicMock(), MagicMock()]
    add_dll_directory = MagicMock(side_effect=dll_handles)
    monkeypatch.setattr(portable.os, "add_dll_directory", add_dll_directory)
    cli = MagicMock()
    monkeypatch.setitem(portable.sys.modules, "madnolia.cli", cli)

    portable.main()

    cli.main.assert_called_once_with()
    assert add_dll_directory.call_args_list == [
        ((str(internal_root),),), ((str(torch_library_root),),),
    ]
    for handle in dll_handles:
        handle.close.assert_called_once_with()
    assert portable.os.environ["PATH"].startswith(
        f"{torch_library_root}{portable.os.pathsep}{internal_root}{portable.os.pathsep}"
    )
    assert portable.sys.argv[1:] == ["viewer", "--port", "9000"]
    assert Path.cwd() == expected_root
    assert DEFAULT_INPUT_DIR.is_dir()
    assert portable.os.environ["HF_HOME"] == str(expected_root / HUGGINGFACE_CACHE_DIR)
    assert portable.os.environ["TORCH_HOME"] == str(expected_root / TORCH_CACHE_DIR)
    assert portable.os.environ["NLTK_DATA"] == str(expected_root / NLTK_DATA_DIR)
    assert portable.os.environ["XDG_CACHE_HOME"] == str(expected_root / GENERAL_CACHE_DIR)
    assert portable.web_directory() == executable_root / "web/dist"


def test_development_web_files_follow_current_directory(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(portable.sys, "frozen", False, raising=False)

    assert portable.web_directory() == tmp_path / "web/dist"


def test_launcher_starts_hidden_server_with_separate_logs(monkeypatch, tmp_path: Path) -> None:
    executable_root = tmp_path / "app"
    root = tmp_path / "data"
    log_file = root / "logs/madnolia.log"
    monkeypatch.setattr(launcher.sys, "frozen", True, raising=False)
    popen = MagicMock()
    monkeypatch.setattr(launcher.subprocess, "Popen", popen)

    assert launcher.launch_server(executable_root, root, log_file) is popen.return_value

    assert popen.call_args.args[0] == [str(executable_root / "Madnolia.exe"), "viewer"]
    options = popen.call_args.kwargs
    assert options["cwd"] == root
    assert options["env"][LAUNCHER_ENVIRONMENT_VARIABLE] == "1"
    assert options["stdin"] == launcher.subprocess.DEVNULL
    assert options["stderr"] == launcher.subprocess.STDOUT
    assert options["stdout"].name == str(log_file)
    assert options["creationflags"] == getattr(launcher.subprocess, "CREATE_NO_WINDOW", 0)


def test_shutdown_stops_owned_windows_process_tree(monkeypatch) -> None:
    process = MagicMock()
    process.poll.return_value = None
    process.pid = 4321
    monkeypatch.setattr(launcher.os, "name", "nt")
    run = MagicMock()
    monkeypatch.setattr(launcher.subprocess, "run", run)

    launcher.stop_server(process)

    assert run.call_args.args[0] == ["taskkill", "/PID", "4321", "/T", "/F"]
    process.wait.assert_called_once_with(timeout=5)


@pytest.mark.skipif(launcher.os.name != "nt", reason="Windows launcher startup lock")
def test_startup_lock_serializes_concurrent_launchers(tmp_path: Path) -> None:
    path = tmp_path / LAUNCHER_LOCK_FILE
    first = launcher.acquire_startup_lock(path)
    assert first is not None
    try:
        assert launcher.acquire_startup_lock(path) is None
    finally:
        first.close()
    next_launch = launcher.acquire_startup_lock(path)
    assert next_launch is not None
    next_launch.close()
