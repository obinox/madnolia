import os
import socket
import sys
import webbrowser
from pathlib import Path
from threading import Thread
from time import sleep

from madnolia.constants import (
    DEFAULT_INPUT_DIR,
    DEFAULT_VIEWER_HOST,
    DEFAULT_VIEWER_PORT,
    GENERAL_CACHE_DIR,
    HUGGINGFACE_CACHE_DIR,
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


def main() -> None:
    cuda_directory_handle = None
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    if getattr(sys, "frozen", False):
        root = Path(sys.executable).resolve().parent
        os.chdir(root)
        cuda_libraries = root / "_internal" / "cuda"
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
    if getattr(sys, "frozen", False) and sys.argv[1:] == ["viewer"]:
        Thread(target=_open_viewer, daemon=True).start()
    from madnolia.cli import main as cli_main

    cli_main()
    if cuda_directory_handle is not None:
        cuda_directory_handle.close()


if __name__ == "__main__":
    main()
