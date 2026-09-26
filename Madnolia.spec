import os
from pathlib import Path
from sysconfig import get_paths

from PyInstaller.utils.hooks import collect_all, collect_submodules


root = Path(SPECPATH)
datas = []
binaries = []
hiddenimports = collect_submodules("madnolia")

for package in ("openvino", "openvino_genai", "openvino_tokenizers", "ctranslate2", "g2pk", "nltk"):
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
    [str(root / "src" / "madnolia" / "portable.py")],
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
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Madnolia",
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="Madnolia",
)
