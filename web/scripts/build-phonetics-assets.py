from __future__ import annotations

import gzip
import json
import shutil
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DICTIONARY = ROOT / ".venv" / "Lib" / "site-packages" / "mecab_ko_dic" / "dictionary"
OUTPUT = ROOT / "web" / "src" / "browser" / "phonetics" / "assets" / "ko-dic"
G2PK = ROOT / "web" / "src" / "browser" / "phonetics" / "g2pk"
G2P_EN = ROOT / ".venv" / "Lib" / "site-packages" / "g2p_en"
OUTPUT_EN = ROOT / "web" / "src" / "browser" / "phonetics" / "assets" / "en-g2p"
OUTPUT_JA = ROOT / "web" / "src" / "browser" / "phonetics" / "assets" / "ja-g2p"
FILES = ("char.bin", "dicrc", "matrix.bin", "sys.dic", "unk.dic")
PYTHON_LIB = ROOT / ".venv" / "Lib" / "site-packages"
NLTK_DATA = ROOT / "_internal" / "nltk_data"


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        source = DICTIONARY / name
        if not source.is_file():
            raise FileNotFoundError(source)
        with source.open("rb") as input_file, (OUTPUT / f"{name}.gzbin").open("wb") as compressed_file:
            with gzip.GzipFile(fileobj=compressed_file, mode="wb", compresslevel=9, mtime=0) as output_file:
                output_file.write(input_file.read())
    sys.path.insert(0, str(PYTHON_LIB))
    import nltk
    from nltk.corpus import cmudict

    with tempfile.TemporaryDirectory() as temp_data:
        corpus_dir = Path(temp_data) / "corpora"
        corpus_dir.mkdir()
        shutil.copy2(NLTK_DATA / "corpora" / "cmudict.zip", corpus_dir / "cmudict.zip")
        nltk.data.path = [temp_data]
        dictionary = {word.lower(): variants[0] for word, variants in cmudict.dict().items() if variants}
    (G2PK / "cmudict.json").write_text(json.dumps(dictionary, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    import numpy as np

    OUTPUT_EN.mkdir(parents=True, exist_ok=True)
    checkpoint = np.load(G2P_EN / "checkpoint20.npz")
    with (OUTPUT_EN / "checkpoint20.bin").open("wb") as output_file:
        for name in ("enc_emb", "enc_w_ih", "enc_w_hh", "enc_b_ih", "enc_b_hh", "dec_emb", "dec_w_ih", "dec_w_hh", "dec_b_ih", "dec_b_hh", "fc_w", "fc_b"):
            output_file.write(np.asarray(checkpoint[name], dtype="<f4", order="C").tobytes())
    from pykakasi.kanji import Itaiji, Kanwa
    from pykakasi.scripts import H2

    OUTPUT_JA.mkdir(parents=True, exist_ok=True)
    kanwa = {
        chr(codepoint): {
            word: [[reading, sorted(context) if context is not None else None] for reading, context in readings]
            for word, readings in entries.items()
        }
        for codepoint, entries in Kanwa()._jisyo_table.items()
    }
    itaiji = {chr(source): target for source, target in Itaiji()._itaijidict.items()}
    hepburn = {key: value for key, value in H2("a")._kanadict._dict.items() if isinstance(key, str)}
    japanese_data = json.dumps({"kanwa": kanwa, "itaiji": itaiji, "hepburn": hepburn}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with (OUTPUT_JA / "pykakasi.json.gzbin").open("wb") as compressed_file:
        with gzip.GzipFile(fileobj=compressed_file, mode="wb", compresslevel=9, mtime=0) as output_file:
            output_file.write(japanese_data)


if __name__ == "__main__":
    main()
