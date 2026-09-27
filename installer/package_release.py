import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path
from urllib.parse import quote


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"v\d+\.\d+\.\d+(?:\.\d+)?", args.tag):
        parser.error("tag must be a version such as v0.2.1")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository):
        parser.error("repository must be owner/name")
    args.output.mkdir(parents=True, exist_ok=True)
    parts = []
    with args.archive.open("rb") as source:
        remaining = args.archive.stat().st_size
        while remaining:
            name = f"Madnolia-windows-x64.part{len(parts):03d}"
            digest = hashlib.sha256()
            part_remaining = min(remaining, 1_800_000_000)
            with (args.output / name).open("wb") as target:
                while part_remaining:
                    chunk = source.read(min(part_remaining, 8_388_608))
                    if not chunk:
                        raise RuntimeError("Archive changed while packaging")
                    target.write(chunk)
                    digest.update(chunk)
                    part_remaining -= len(chunk)
                    remaining -= len(chunk)
            parts.append({"name": name, "sha256": digest.hexdigest()})
    if not parts:
        parser.error("archive is empty")
    manifest = {"version": args.tag[1:], "parts": parts}
    (args.output / "payload.json").write_text(json.dumps(manifest), encoding="utf-8")
    base_url = f"https://github.com/{args.repository}/releases/download/{quote(args.tag)}"
    entries = "\n".join(
        f"  DownloadPage.Add('{base_url}/{part['name']}', '{part['name']}', "
        f"'{part['sha256']}');" for part in parts
    )
    (args.output / "PayloadMetadata.iss").write_text(
        f"procedure AddPayloadDownloads;\nbegin\n{entries}\nend;\n",
        encoding="utf-8",
    )
    (args.output / "Version.iss").write_text(
        f'#define AppVersion "{args.tag[1:]}"\n', encoding="utf-8"
    )
    hashes = "\n".join(f"{part['sha256']}  {part['name']}" for part in parts)
    (args.output / "SHA256SUMS.txt").write_text(hashes + "\n", encoding="utf-8")
    for name in ("Madnolia.iss", "InstallPayload.ps1"):
        shutil.copyfile(Path(__file__).parent / name, args.output / name)


if __name__ == "__main__":
    main()
