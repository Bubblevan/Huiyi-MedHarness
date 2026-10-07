#!/usr/bin/env python3
"""Verify a prepared corpus and index against the committed manifest."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from huiyi_health_engine.rag.corpus import CorpusRepository


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    corpus = CorpusRepository(args.corpus_root, args.manifest).load()
    print(json.dumps({
        "status": "verified",
        "corpusVersion": corpus.version,
        "sourceCount": len(corpus.sources),
        "chunkCount": corpus.chunk_count,
        "retriever": corpus.retriever_name,
        "queryEncoderRevision": corpus.query_encoder_revision,
        "articleEncoderRevision": corpus.article_encoder_revision,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
