#!/usr/bin/env python3
"""Write a deterministic provenance manifest for already-prepared MedRAG assets."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import faiss


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def file_record(root: Path, path: Path) -> dict[str, str]:
    return {"path": path.relative_to(root).as_posix(), "sha256": sha256(path)}


def build_manifest(args: argparse.Namespace) -> dict[str, object]:
    root = args.corpus_root.resolve()
    sources: list[dict[str, object]] = []
    indices: list[dict[str, object]] = []
    index_hash_items: list[tuple[str, str]] = []
    asset_digests: list[str] = []

    for name in args.corpora:
        corpus_root = root / name
        chunk_root = corpus_root / "chunk"
        index_root = corpus_root / "index" / "ncbi" / "MedCPT-Article-Encoder"
        chunk_paths = sorted(chunk_root.glob("*.jsonl"))
        index_path = index_root / "faiss.index"
        metadata_path = index_root / "metadatas.jsonl"
        if not chunk_paths or not index_path.is_file() or not metadata_path.is_file():
            raise SystemExit(f"{name}: prepared chunks, FAISS index, or metadata are missing")

        chunk_records = []
        chunk_count = 0
        for path in chunk_paths:
            record_count = sum(1 for line in path.open(encoding="utf-8") if line.strip())
            chunk_count += record_count
            file_info = file_record(root, path)
            chunk_records.append(file_info)
            asset_digests.append(f"{file_info['path']}\t{file_info['sha256']}")
        sources.append({
            "name": name,
            "revision": args.textbooks_revision if name == "textbooks" else args.statpearls_revision if name == "statpearls" else None,
            "documentCount": len(chunk_paths),
            "chunkCount": chunk_count,
            "chunkFiles": chunk_records,
        })

        index = faiss.read_index(str(index_path))
        if index.ntotal != chunk_count:
            raise SystemExit(f"{name}: index has {index.ntotal} vectors but chunks contain {chunk_count} rows")
        index_files = [file_record(root, index_path), file_record(root, metadata_path)]
        index_hash_items.extend((item["path"], item["sha256"]) for item in index_files)
        asset_digests.extend(f"{item['path']}\t{item['sha256']}" for item in index_files)
        indices.append({
            "corpus": name,
            "indexType": "faiss.IndexFlatIP",
            "vectorCount": int(index.ntotal),
            "indexPath": index_path.relative_to(root).as_posix(),
            "metadataPath": metadata_path.relative_to(root).as_posix(),
            "files": index_files,
        })

    canonical_index = "\n".join(f"{path}\t{digest}" for path, digest in sorted(index_hash_items)) + "\n"
    index_hash = hashlib.sha256(canonical_index.encode()).hexdigest()
    canonical_assets = "\n".join(sorted(asset_digests)) + "\n"
    version_hash = hashlib.sha256((canonical_assets + index_hash).encode()).hexdigest()[:16]
    return {
        "schemaVersion": 1,
        "corpusVersion": f"medtext-local-{version_hash}",
        "sourceRepository": "MedRAG/MedText sample prepared by repro/imedrag-small-20261007",
        "sources": sources,
        "retriever": {
            "name": "MedCPT",
            "queryEncoderModel": args.query_encoder_model,
            "queryEncoderRevision": args.query_encoder_revision,
            "articleEncoderModel": args.article_encoder_model,
            "articleEncoderRevision": args.article_encoder_revision,
        },
        "indices": indices,
        "indexHash": index_hash,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--corpora", nargs="+", default=["textbooks", "statpearls"])
    parser.add_argument("--textbooks-revision")
    parser.add_argument("--statpearls-revision")
    parser.add_argument("--query-encoder-model", required=True)
    parser.add_argument("--query-encoder-revision", required=True)
    parser.add_argument("--article-encoder-model", required=True)
    parser.add_argument("--article-encoder-revision", required=True)
    args = parser.parse_args()
    manifest = build_manifest(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(args.output),
        "corpusVersion": manifest["corpusVersion"],
        "sources": [{"name": source["name"], "documentCount": source["documentCount"], "chunkCount": source["chunkCount"]} for source in manifest["sources"]],
        "indexHash": manifest["indexHash"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
