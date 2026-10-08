#!/usr/bin/env python3
"""Build upstream-equivalent MedCPT FAISS indices for prepared MedText chunks."""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MEDRAG_SHA = "7599a728a28789fd601728c08d313b1148051f41"
TEXTBOOKS_SHA = "9c72838920a1323ffa867467d3f7aa7b36b0f994"
QUERY_MODEL = "ncbi/MedCPT-Query-Encoder"
QUERY_REVISION = "d83a36cc6b8e3a5c5e9d9d6ba156808c1643dcbc"
ARTICLE_MODEL = "ncbi/MedCPT-Article-Encoder"
ARTICLE_REVISION = "d05a736da4bb84ee4057b7f7999485be6ed85465"


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def aggregate(entries: list[tuple[str, str]]) -> str:
    canonical = "\n".join(f"{path}\t{sha}" for path, sha in sorted(entries)) + "\n"
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def git_value(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


def scan_chunks(root: Path, corpus: str) -> tuple[list[dict[str, str]], int, int, str]:
    chunk_dir = root / corpus / "chunk"
    files = sorted(chunk_dir.glob("*.jsonl"))
    if not files:
        raise RuntimeError(f"no chunk files found for {corpus}: {chunk_dir}")
    manifest_files: list[dict[str, str]] = []
    hash_entries: list[tuple[str, str]] = []
    chunk_count = 0
    documents: set[str] = set()
    for path in files:
        relative = path.relative_to(root).as_posix()
        sha = digest(path)
        manifest_files.append({"path": relative, "sha256": sha})
        hash_entries.append((relative, sha))
        documents.add(path.stem)
        with path.open("r", encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, start=1):
                if not line.strip():
                    continue
                item = json.loads(line)
                if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                    raise RuntimeError(f"invalid chunk id: {path}:{line_number}")
                chunk_count += 1
    return manifest_files, len(documents), chunk_count, aggregate(hash_entries)


def build_one(corpus_root: Path, corpus: str, article_snapshot: Path, medrag_root: Path, embed, construct_index) -> dict[str, Any]:
    chunk_dir = corpus_root / corpus / "chunk"
    index_dir = corpus_root / corpus / "index" / "ncbi" / "MedCPT-Article-Encoder"
    index_path = index_dir / "faiss.index"
    metadata_path = index_dir / "metadatas.jsonl"
    if not index_path.is_file() or not metadata_path.is_file():
        dimension = embed(
            chunk_dir=str(chunk_dir),
            index_dir=str(index_dir),
            model_name=str(article_snapshot),
        )
        construct_index(
            index_dir=str(index_dir),
            model_name=ARTICLE_MODEL,
            h_dim=dimension,
            HNSW=False,
        )

    faiss_files = [index_path, metadata_path]
    for path in faiss_files:
        if not path.is_file():
            raise RuntimeError(f"MedRAG index build did not produce {path}")
    import faiss

    vector_count = int(faiss.read_index(str(index_path)).ntotal)
    embedding_dir = index_dir / "embedding"
    if embedding_dir.is_dir():
        shutil.rmtree(embedding_dir)
    return {
        "corpus": corpus,
        "indexPath": index_path.relative_to(corpus_root).as_posix(),
        "metadataPath": metadata_path.relative_to(corpus_root).as_posix(),
        "vectorCount": vector_count,
        "files": [
            {"path": path.relative_to(corpus_root).as_posix(), "sha256": digest(path)}
            for path in faiss_files
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--medrag-root", type=Path, required=True)
    parser.add_argument("--textbooks-root", type=Path, required=True)
    parser.add_argument("--corpus-root", type=Path, required=True)
    parser.add_argument("--article-encoder", type=Path, required=True)
    parser.add_argument("--query-encoder", type=Path, required=True)
    parser.add_argument("--statpearls-archive", type=Path, required=True)
    parser.add_argument("--manifest-out", type=Path, required=True)
    args = parser.parse_args()

    medrag_root = args.medrag_root.resolve()
    textbooks_root = args.textbooks_root.resolve()
    corpus_root = args.corpus_root.resolve()
    article_snapshot = args.article_encoder.resolve()
    query_snapshot = args.query_encoder.resolve()
    archive_path = args.statpearls_archive.resolve()
    manifest_out = args.manifest_out.resolve()

    actual_medrag_sha = git_value(medrag_root, "rev-parse", "HEAD")
    if actual_medrag_sha != MEDRAG_SHA or git_value(medrag_root, "status", "--porcelain"):
        raise SystemExit("MedRAG checkout must be clean at the pinned HC-RAG-002 SHA")
    actual_textbooks_sha = git_value(textbooks_root, "rev-parse", "HEAD")
    if actual_textbooks_sha != TEXTBOOKS_SHA:
        raise SystemExit(f"Textbooks SHA mismatch: expected {TEXTBOOKS_SHA}, got {actual_textbooks_sha}")
    if not article_snapshot.is_dir() or not query_snapshot.is_dir():
        raise SystemExit("both local MedCPT model snapshots must be present")
    if article_snapshot.name != ARTICLE_REVISION or query_snapshot.name != QUERY_REVISION:
        raise SystemExit("MedCPT snapshot directory names do not match the audited revisions")
    if not archive_path.is_file():
        raise SystemExit("the downloaded NCBI StatPearls archive is required for provenance")
    if git_value(medrag_root, "status", "--porcelain"):
        raise SystemExit("refusing to import a dirty MedRAG checkout")

    books_source = textbooks_root / "chunk"
    books_target = corpus_root / "textbooks" / "chunk"
    if not books_target.exists():
        books_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(books_source, books_target)
    elif sorted(path.name for path in books_target.glob("*.jsonl")) != sorted(path.name for path in books_source.glob("*.jsonl")):
        raise SystemExit("prepared Textbooks files differ from the pinned source file list")

    sys.dont_write_bytecode = True
    sys.path.insert(0, str(medrag_root))
    upstream = importlib.import_module("src.utils")
    embed = upstream.embed
    construct_index = upstream.construct_index

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    if os.environ.get("CUDA_VISIBLE_DEVICES") == "":
        raise SystemExit("CUDA_VISIBLE_DEVICES is empty; refusing a CPU index build")

    index_specs = [
        build_one(corpus_root, corpus, article_snapshot, medrag_root, embed, construct_index)
        for corpus in ("textbooks", "statpearls")
    ]

    sources: list[dict[str, Any]] = []
    archive_stat = archive_path.stat()
    archive_provenance = {
        "source": "https://ftp.ncbi.nlm.nih.gov/pub/litarch/3d/12/statpearls_NBK430685.tar.gz",
        "revision": None,
        "retrievedAtUtc": datetime.fromtimestamp(archive_stat.st_mtime, tz=timezone.utc).isoformat(),
        "lastModifiedUtc": "2026-10-04T07:25:26+00:00",
        "archiveSha256": digest(archive_path),
    }
    for corpus, source_info in (
        ("textbooks", {"repository": "https://huggingface.co/datasets/MedRAG/textbooks", "revision": actual_textbooks_sha}),
        ("statpearls", archive_provenance),
    ):
        files, document_count, chunk_count, chunk_hash = scan_chunks(corpus_root, corpus)
        sources.append({
            "name": corpus,
            "sourceType": "medical_reference",
            **source_info,
            "documentCount": document_count,
            "chunkCount": chunk_count,
            "chunkContentHash": chunk_hash,
            "chunkFiles": files,
        })
    index_entries = [
        (file["path"], file["sha256"])
        for index_spec in index_specs
        for file in index_spec["files"]
    ]
    corpus_hash = aggregate([
        (f"{source['name']}/{item['path']}", item["sha256"])
        for source in sources
        for item in source["chunkFiles"]
    ])
    manifest: dict[str, Any] = {
        "corpusVersion": f"medtext-2026-10-07-{corpus_hash[:16]}",
        "corpus": "MedText",
        "corpusHash": corpus_hash,
        "upstream": {"repository": "https://github.com/gzxiong/MedRAG", "revision": actual_medrag_sha},
        "retriever": {
            "name": "MedCPT",
            "queryEncoderModel": QUERY_MODEL,
            "queryEncoderRevision": QUERY_REVISION,
            "articleEncoderModel": ARTICLE_MODEL,
            "articleEncoderRevision": ARTICLE_REVISION,
            "sentenceTransformersVersion": "2.2.2",
            "indexType": "faiss.IndexFlatIP",
            "normalization": "none",
        },
        "sources": sources,
        "indices": index_specs,
        "indexHash": aggregate(index_entries),
    }
    manifest_out.parent.mkdir(parents=True, exist_ok=True)
    manifest_out.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "corpusVersion": manifest["corpusVersion"],
        "corpusHash": manifest["corpusHash"],
        "indexHash": manifest["indexHash"],
        "sources": [{"name": s["name"], "documentCount": s["documentCount"], "chunkCount": s["chunkCount"], "chunkContentHash": s["chunkContentHash"]} for s in sources],
        "indices": [{"corpus": i["corpus"], "indexPath": i["indexPath"]} for i in index_specs],
        "manifest": str(manifest_out),
    }, indent=2))


if __name__ == "__main__":
    main()
