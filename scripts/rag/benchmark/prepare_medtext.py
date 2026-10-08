#!/usr/bin/env python3
"""Prepare the pinned MedRAG Textbooks + StatPearls chunks for parity runs.

StatPearls XML extraction is delegated to the exact pinned MedRAG source file;
this script only streams archive members so the multi-gigabyte archive is never
expanded into a second full directory tree.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Any


MEDRAG_SHA = "7599a728a28789fd601728c08d313b1148051f41"
TEXTBOOKS_SHA = "9c72838920a1323ffa867467d3f7aa7b36b0f994"
NCBI_URL = "https://ftp.ncbi.nlm.nih.gov/pub/litarch/3d/12/statpearls_NBK430685.tar.gz"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def git_value(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


def load_upstream_extractor(medrag_root: Path):
    # Keep the pinned source checkout read-only even when importing its module.
    sys.dont_write_bytecode = True
    module_path = medrag_root / "src" / "data" / "statpearls.py"
    spec = importlib.util.spec_from_file_location("pinned_medrag_statpearls", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load pinned extractor at {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.extract


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--medrag-root", type=Path, required=True)
    parser.add_argument("--textbooks-root", type=Path, required=True)
    parser.add_argument("--statpearls-archive", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    args = parser.parse_args()

    medrag_root = args.medrag_root.resolve()
    textbooks_root = args.textbooks_root.resolve()
    archive_path = args.statpearls_archive.resolve()
    output_root = args.output_root.resolve()

    actual_medrag_sha = git_value(medrag_root, "rev-parse", "HEAD")
    if actual_medrag_sha != MEDRAG_SHA:
        raise SystemExit(f"pinned MedRAG SHA mismatch: expected {MEDRAG_SHA}, got {actual_medrag_sha}")
    if git_value(medrag_root, "status", "--porcelain"):
        raise SystemExit("pinned MedRAG checkout is dirty; refusing to use it as an extraction reference")

    actual_textbooks_sha = git_value(textbooks_root, "rev-parse", "HEAD")
    if actual_textbooks_sha != TEXTBOOKS_SHA:
        raise SystemExit(f"Textbooks SHA mismatch: expected {TEXTBOOKS_SHA}, got {actual_textbooks_sha}")
    if not archive_path.is_file():
        raise SystemExit(f"StatPearls archive is missing: {archive_path}")

    statpearls_output = output_root / "statpearls" / "chunk"
    if statpearls_output.exists() and any(statpearls_output.iterdir()):
        raise SystemExit(f"refusing to mix with existing StatPearls chunks: {statpearls_output}")
    statpearls_output.mkdir(parents=True, exist_ok=True)

    extractor = load_upstream_extractor(medrag_root)
    archive_hash = sha256(archive_path)
    file_names: set[str] = set()
    article_count = 0
    chunk_count = 0
    chunk_bytes = 0

    with tempfile.TemporaryDirectory(prefix="hc-rag-002-statpearls-") as temp_dir:
        with tarfile.open(archive_path, mode="r|gz") as archive:
            for member in archive:
                if not member.isfile() or not member.name.endswith(".nxml"):
                    continue
                filename = Path(member.name).name
                if filename in file_names:
                    raise RuntimeError(f"duplicate NXML basename in source archive: {filename}")
                file_names.add(filename)
                source = archive.extractfile(member)
                if source is None:
                    raise RuntimeError(f"cannot read NXML archive member: {member.name}")
                temp_nxml = Path(temp_dir) / filename
                with source, temp_nxml.open("wb") as target:
                    shutil.copyfileobj(source, target, length=1024 * 1024)
                # The pinned function derives stable chunk IDs from the filename.
                try:
                    saved_lines = extractor(str(temp_nxml))
                finally:
                    temp_nxml.unlink(missing_ok=True)
                if saved_lines:
                    destination = statpearls_output / f"{filename.removesuffix('.nxml')}.jsonl"
                    encoded = "\n".join(saved_lines).encode("utf-8")
                    destination.write_bytes(encoded)
                    article_count += 1
                    chunk_count += len(saved_lines)
                    chunk_bytes += len(encoded)
                if len(file_names) % 1000 == 0:
                    print(f"processed_nxml={len(file_names)} chunks={chunk_count}", flush=True)

    textbooks_chunks = textbooks_root / "chunk"
    if not textbooks_chunks.is_dir():
        raise SystemExit(f"Textbooks chunk directory is missing: {textbooks_chunks}")

    statpearls_files = sorted(statpearls_output.glob("*.jsonl"))
    if len(statpearls_files) != article_count:
        raise RuntimeError("StatPearls output file count does not match extracted article count")

    summary: dict[str, Any] = {
        "medrag": {"repository": "https://github.com/gzxiong/MedRAG", "revision": actual_medrag_sha},
        "textbooks": {
            "repository": "https://huggingface.co/datasets/MedRAG/textbooks",
            "revision": actual_textbooks_sha,
            "chunkFiles": len(list(textbooks_chunks.glob("*.jsonl"))),
            "chunkDirectory": str(textbooks_chunks),
        },
        "statpearls": {
            "source": NCBI_URL,
            "revision": None,
            "retrievedAt": "recorded separately from source HTTP Last-Modified",
            "archiveSha256": archive_hash,
            "nxmlCount": len(file_names),
            "documentCount": article_count,
            "chunkCount": chunk_count,
            "chunkBytes": chunk_bytes,
            "chunkDirectory": str(statpearls_output),
            "extractor": "pinned MedRAG src/data/statpearls.py::extract",
        },
    }
    output_root.mkdir(parents=True, exist_ok=True)
    manifest_path = output_root / "source-preparation.json"
    manifest_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
