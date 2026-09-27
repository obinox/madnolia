import json
import os
import queue
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from tkinter import Tk, messagebox, ttk
from typing import BinaryIO

from madnolia.constants import (
    APPLICATION_ID,
    DEFAULT_VIEWER_HOST,
    DEFAULT_VIEWER_PORT,
    HEALTH_ENDPOINT,
    INSTALLED_LOG_DIRECTORY,
    LAUNCHER_ENVIRONMENT_VARIABLE,
    LAUNCHER_LOCK_FILE,
    LAUNCHER_READY_TIMEOUT_SECONDS,
)
from madnolia.portable import runtime_root


def data_directory() -> Path:
    if getattr(sys, "frozen", False):
        return runtime_root(Path(sys.executable).resolve().parent)
    return Path.cwd()


def viewer_url() -> str:
    return f"http://{DEFAULT_VIEWER_HOST}:{DEFAULT_VIEWER_PORT}"


def probe_health(timeout: float = 0.5) -> dict[str, object] | None:
    try:
        with urllib.request.urlopen(f"{viewer_url()}{HEALTH_ENDPOINT}", timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError):
        return None
    if (
        not isinstance(payload, dict)
        or payload.get("app") != APPLICATION_ID
        or payload.get("status") != "ok"
    ):
        return None
    return payload


def matches_installed_data(payload: dict[str, object], root: Path) -> bool:
    try:
        reported_root = Path(str(payload["data_root"])).resolve()
        return reported_root == root.resolve()
    except (KeyError, OSError, RuntimeError):
        return False


def launch_server(executable_root: Path, root: Path, log_file: Path) -> subprocess.Popen[bytes]:
    executable = executable_root / "Madnolia.exe"
    env = os.environ.copy()
    env[LAUNCHER_ENVIRONMENT_VARIABLE] = "1"
    log_file.parent.mkdir(parents=True, exist_ok=True)
    with log_file.open("ab", buffering=0) as output:
        if getattr(sys, "frozen", False):
            command = [str(executable), "viewer"]
        else:
            command = [sys.executable, "-m", "madnolia.portable", "viewer"]
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            return subprocess.Popen(
                command,
                cwd=root,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.STDOUT,
                creationflags=creation_flags,
            )
        except OSError:
            output.write(traceback.format_exc().encode("utf-8", errors="replace"))
            raise


def stop_server(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            process.wait(timeout=5)
            return
        except subprocess.TimeoutExpired:
            pass
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def acquire_startup_lock(path: Path) -> BinaryIO | None:
    handle = path.open("a+b")
    if os.name != "nt":
        return handle
    import msvcrt

    if handle.tell() == 0:
        handle.write(b"\0")
        handle.flush()
    handle.seek(0)
    try:
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        handle.close()
        return None
    return handle


def main() -> None:
    import socket

    root = data_directory()
    logs = root / INSTALLED_LOG_DIRECTORY
    log_file = logs / "madnolia.log"
    try:
        root.mkdir(parents=True, exist_ok=True)
        logs.mkdir(parents=True, exist_ok=True)
    except OSError:
        messagebox.showerror(
            "마드놀리아", "저장 폴더를 열지 못했어요. 폴더 접근 권한과 저장 공간을 확인해 주세요."
        )
        return
    executable_root = Path(sys.executable).resolve().parent
    state: dict[str, object] = {"process": None, "closing": False, "browser_opened": False}
    state_lock = threading.Lock()
    updates = queue.SimpleQueue()

    window = Tk()
    window.title("마드놀리아")
    window.resizable(False, False)
    frame = ttk.Frame(window, padding=24)
    frame.grid(sticky="nsew")
    ttk.Label(frame, text="마드놀리아", font=("맑은 고딕", 18, "bold")).grid(
        row=0, column=0, columnspan=2, sticky="w"
    )
    status = ttk.Label(frame, text="앱을 준비하고 있어요. 잠시만 기다려 주세요.", width=54)
    status.grid(row=1, column=0, columnspan=2, pady=(14, 16), sticky="w")
    open_button = ttk.Button(frame, text="마드놀리아 열기", state="disabled")
    open_button.grid(row=2, column=0, columnspan=2, sticky="ew")
    ttk.Button(frame, text="내 데이터 폴더", command=lambda: os.startfile(root)).grid(
        row=3, column=0, sticky="ew", pady=(10, 0), padx=(0, 5)
    )
    ttk.Button(frame, text="오류 기록 보기", command=lambda: os.startfile(logs)).grid(
        row=3, column=1, sticky="ew", pady=(10, 0), padx=(5, 0)
    )
    ttk.Button(frame, text="종료", command=lambda: close()).grid(
        row=4, column=0, columnspan=2, sticky="ew", pady=(10, 0)
    )
    ttk.Label(frame, text="분석 결과와 모델은 이 컴퓨터에 저장됩니다.").grid(
        row=5, column=0, columnspan=2, pady=(16, 0), sticky="w"
    )

    def update_status(text: str, ready: bool = False) -> None:
        if window.winfo_exists():
            status.configure(text=text)
            open_button.configure(state="normal" if ready else "disabled")

    def show_status(text: str, ready: bool = False) -> None:
        if not state["closing"]:
            updates.put((text, ready, False))

    def show_ready(text: str) -> None:
        if not state["closing"]:
            updates.put((text, True, True))

    def poll_updates() -> None:
        if state["closing"]:
            return
        while True:
            try:
                text, ready, auto_open = updates.get_nowait()
            except queue.Empty:
                break
            update_status(text, ready)
            if auto_open and not state["browser_opened"]:
                state["browser_opened"] = True
                webbrowser.open(viewer_url())
        window.after(100, poll_updates)

    def begin_server() -> None:
        payload = probe_health()
        if payload is not None:
            if matches_installed_data(payload, root):
                show_ready("마드놀리아가 실행 중이에요.")
                return
            show_status("다른 마드놀리아가 실행 중이에요. 먼저 닫은 뒤 다시 시작해 주세요.")
            return
        try:
            with socket.create_connection((DEFAULT_VIEWER_HOST, DEFAULT_VIEWER_PORT), timeout=0.2):
                show_status("이 컴퓨터의 다른 앱이 사용 중인 주소예요. 앱을 닫고 다시 시작해 주세요.")
                return
        except OSError:
            pass
        try:
            with state_lock:
                if state["closing"]:
                    return
                process = launch_server(executable_root, root, log_file)
                state["process"] = process
        except OSError:
            show_status("앱을 시작하지 못했어요. 오류 기록을 열어 확인해 주세요.")
            return
        deadline = time.monotonic() + LAUNCHER_READY_TIMEOUT_SECONDS
        while time.monotonic() < deadline and not state["closing"]:
            payload = probe_health()
            if payload is not None:
                if matches_installed_data(payload, root):
                    show_ready("준비됐어요. 앱을 열고 있어요.")
                else:
                    show_status("다른 마드놀리아가 실행 중이에요. 먼저 닫아 주세요.")
                    stop_server(process)
                return
            if process.poll() is not None:
                show_status("시작 중 문제가 생겼어요. 오류 기록을 열어 확인해 주세요.")
                return
            time.sleep(0.5)
        if not state["closing"]:
            stop_server(process)
            show_status("시작이 오래 걸리고 있어요. 오류 기록을 확인해 주세요.")

    def begin() -> None:
        deadline = time.monotonic() + LAUNCHER_READY_TIMEOUT_SECONDS
        while not state["closing"] and time.monotonic() < deadline:
            try:
                handle = acquire_startup_lock(logs / LAUNCHER_LOCK_FILE)
            except OSError:
                show_status("앱의 실행 상태를 확인하지 못했어요. 저장 폴더 접근 권한을 확인해 주세요.")
                return
            if handle is not None:
                try:
                    begin_server()
                finally:
                    handle.close()
                return
            payload = probe_health()
            if payload is not None and matches_installed_data(payload, root):
                show_ready("마드놀리아가 실행 중이에요.")
                return
            time.sleep(0.5)
        if not state["closing"]:
            show_status("다른 실행 창에서 앱을 준비하고 있어요. 잠시 후 다시 열어 주세요.")

    def open_app() -> None:
        payload = probe_health()
        if payload is not None and matches_installed_data(payload, root):
            webbrowser.open(viewer_url())
        else:
            update_status("앱 연결을 확인하지 못했어요. 다시 시작해 주세요.")
            open_button.configure(state="disabled")

    def close() -> None:
        with state_lock:
            state["closing"] = True
            process = state["process"]
        if isinstance(process, subprocess.Popen):
            stop_server(process)
        window.destroy()

    open_button.configure(command=open_app)
    window.protocol("WM_DELETE_WINDOW", close)
    window.after(100, poll_updates)
    threading.Thread(target=begin, daemon=True).start()
    window.mainloop()


if __name__ == "__main__":
    main()
