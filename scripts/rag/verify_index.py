#!/usr/bin/env python3
"""Verify a prepared corpus and index against the committed manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from huiyi_health_engine.rag.corpus import CorpusRepository


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    corpus = CorpusRepository(args.corpus_root, args.manifest).load()
    manifest_bytes = args.manifest.read_bytes()
    manifest = json.loads(manifest_bytes)
    asset_paths = [
        args.corpus_root / item["path"]
        for source in manifest["sources"]
        for item in source["chunkFiles"]
    ] + [
        args.corpus_root / item["path"]
        for index in manifest["indices"]
        for item in index["files"]
    ]
    report = {
        "schemaVersion": "huiyi-rag-index-verification/v1",
        "verifiedAt": datetime.now(timezone.utc).isoformat(),
        "status": "verified",
        "corpusVersion": corpus.version,
        "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "indexHash": manifest["indexHash"],
        "sourceCount": len(corpus.sources),
        "chunkCount": corpus.chunk_count,
        "verifiedAssetBytes": sum(path.stat().st_size for path in asset_paths),
        "sources": [
            {
                "name": source["name"],
                "documentCount": source["documentCount"],
                "chunkCount": source["chunkCount"],
            }
            for source in corpus.sources
        ],
        "retriever": corpus.retriever_name,
        "queryEncoderRevision": corpus.query_encoder_revision,
        "articleEncoderRevision": corpus.article_encoder_revision,
    }
    rendered = json.dumps(report, indent=2, ensure_ascii=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
