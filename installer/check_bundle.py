import argparse
from pathlib import Path
from zipfile import ZipFile

import faster_whisper
from faster_whisper import vad


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()

    package_root = Path(faster_whisper.__file__).resolve().parent
    original_loader = vad.SileroVADModel

    def resolve_model_path(path):
        return path

    vad.get_vad_model.cache_clear()
    try:
        vad.SileroVADModel = resolve_model_path
        source_asset = Path(vad.get_vad_model()).resolve()
    finally:
        vad.SileroVADModel = original_loader
        vad.get_vad_model.cache_clear()

    asset_relative_path = source_asset.relative_to(package_root.parent)
    bundled_asset = args.bundle.resolve() / "_internal" / asset_relative_path
    if not bundled_asset.is_file():
        raise FileNotFoundError(f"Bundled faster-whisper VAD asset is missing: {bundled_asset}")
    if bundled_asset.stat().st_size != source_asset.stat().st_size:
        raise RuntimeError(f"Bundled faster-whisper VAD asset size mismatch: {bundled_asset}")

    original_loader(str(bundled_asset))
    print(f"Verified faster-whisper VAD asset: {bundled_asset}")

    archive = args.bundle.resolve() / "_internal" / "nltk_data" / "corpora" / "cmudict.zip"
    with ZipFile(archive) as corpus:
        if corpus.testzip() is not None:
            raise RuntimeError(f"Bundled cmudict corpus is corrupt: {archive}")
        with corpus.open("cmudict/cmudict") as entries_file:
            entries = sum(1 for line in entries_file if line.strip())
    if not entries:
        raise RuntimeError(f"Bundled cmudict corpus is empty: {archive}")
    print(f"Verified bundled cmudict entries: {entries}")


if __name__ == "__main__":
    main()
