import os
import socket
import sys
import webbrowser
from pathlib import Path
from threading import Thread
from time import sleep

from madnolia.constants import (
    CUDA_BUNDLE_DIRECTORY,
    DEFAULT_INPUT_DIR,
    DEFAULT_VIEWER_HOST,
    DEFAULT_VIEWER_PORT,
    GENERAL_CACHE_DIR,
    HUGGINGFACE_CACHE_DIR,
    INSTALLED_DATA_DIRECTORY,
    INSTALLED_MODE_MARKER,
    LAUNCHER_ENVIRONMENT_VARIABLE,
    NLTK_DATA_DIR,
    OPENVINO_WORKER_ARGUMENT,
    TORCH_CACHE_DIR,
)


def _open_viewer() -> None:
    for _ in range(100):
        try:
            with socket.create_connection((DEFAULT_VIEWER_HOST, DEFAULT_VIEWER_PORT), timeout=0.2):
                webbrowser.open(f"http://{DEFAULT_VIEWER_HOST}:{DEFAULT_VIEWER_PORT}")
                return
        except OSError:
            sleep(0.2)


def runtime_root(executable_root: Path, local_app_data: Path | None = None) -> Path:
    if not (executable_root / INSTALLED_MODE_MARKER).is_file():
        return executable_root
    if local_app_data is None:
        local_app_data = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
    return local_app_data / INSTALLED_DATA_DIRECTORY


def web_directory() -> Path:
    root = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path.cwd()
    return root / "web/dist"


def main() -> None:
    cuda_directory_handle = None
    dll_directory_handles = []
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    if getattr(sys, "frozen", False):
        executable_root = Path(sys.executable).resolve().parent
        root = runtime_root(executable_root)
        root.mkdir(parents=True, exist_ok=True)
        os.chdir(root)
        internal_root = Path(getattr(sys, "_MEIPASS", executable_root / "_internal"))
        for directory in (internal_root, internal_root / "torch" / "lib"):
            if directory.is_dir():
                os.environ["PATH"] = f"{directory}{os.pathsep}{os.environ.get('PATH', '')}"
                dll_directory_handles.append(os.add_dll_directory(str(directory)))
        cuda_libraries = executable_root / CUDA_BUNDLE_DIRECTORY
        if cuda_libraries.is_dir():
            os.environ["PATH"] = f"{cuda_libraries}{os.pathsep}{os.environ.get('PATH', '')}"
            cuda_directory_handle = os.add_dll_directory(str(cuda_libraries))
        os.environ["HF_HOME"] = str((root / HUGGINGFACE_CACHE_DIR).resolve())
        os.environ["TORCH_HOME"] = str((root / TORCH_CACHE_DIR).resolve())
        os.environ["NLTK_DATA"] = str((root / NLTK_DATA_DIR).resolve())
        os.environ["XDG_CACHE_HOME"] = str((root / GENERAL_CACHE_DIR).resolve())
        DEFAULT_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    if len(sys.argv) > 1 and sys.argv[1] == OPENVINO_WORKER_ARGUMENT:
        from madnolia.transcription_worker import run_openvino_worker

        run_openvino_worker(Path(sys.argv[2]), sys.argv[3])
        return
    if len(sys.argv) == 1:
        sys.argv.append("viewer")
    if (
        getattr(sys, "frozen", False)
        and sys.argv[1:] == ["viewer"]
        and os.environ.get(LAUNCHER_ENVIRONMENT_VARIABLE) != "1"
    ):
        Thread(target=_open_viewer, daemon=True).start()
    from madnolia.cli import main as cli_main

    cli_main()
    if cuda_directory_handle is not None:
        cuda_directory_handle.close()
    for handle in dll_directory_handles:
        handle.close()


if __name__ == "__main__":
    main()
