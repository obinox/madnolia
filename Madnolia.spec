import os
from pathlib import Path
from sysconfig import get_paths

from PyInstaller.utils.hooks import collect_all, collect_submodules


root = Path(SPECPATH)
datas = []
binaries = []
hiddenimports = collect_submodules("madnolia")
hiddenimports += collect_submodules("transformers.models.qwen3_asr")

for package in (
    "faster_whisper",
    "openvino",
    "openvino_genai",
    "openvino_tokenizers",
    "ctranslate2",
    "g2pk",
    "g2p_en",
    "jamo",
    "nltk",
    "pykakasi",
    "pyworld",
):
    package_datas, package_binaries, package_hiddenimports = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hiddenimports

if os.environ.get("MADNOLIA_INCLUDE_CUDA", "1") == "1":
    cuda_packages = Path(get_paths()["purelib"]) / "nvidia"
    for component in ("cublas", "cudnn", "cuda_runtime"):
        for library in (cuda_packages / component / "bin").glob("*.dll"):
            if library.name != "nvblas64_12.dll":
                binaries.append((str(library), "cuda"))

hiddenimports += [
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.lifespan.on",
]

a = Analysis(
    [
        str(root / "src" / "madnolia" / "portable.py"),
        str(root / "src" / "madnolia" / "launcher.py"),
    ],
    pathex=[str(root / "src")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
a.binaries = [item for item in a.binaries if not item[0].startswith("nvidia\\")]
pyz = PYZ(a.pure)
console_scripts = [entry for entry in a.scripts if Path(entry[1]).name != "launcher.py"]
launcher_scripts = [entry for entry in a.scripts if Path(entry[1]).name != "portable.py"]
console_exe = EXE(
    pyz,
    console_scripts,
    [],
    exclude_binaries=True,
    name="Madnolia",
    console=True,
)
launcher_exe = EXE(
    pyz,
    launcher_scripts,
    [],
    exclude_binaries=True,
    name="MadnoliaLauncher",
    console=False,
)
coll = COLLECT(
    console_exe,
    launcher_exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="Madnolia",
)
