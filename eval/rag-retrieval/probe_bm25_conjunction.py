#!/usr/bin/env python3
"""Read-only BM25 query-operator/query-translation probe using the existing SQLite FTS5 index."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from sparse_index import Fts5Bm25Index, tokenize


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def query_expression(query: str, operator: str) -> str:
    terms = list(dict.fromkeys(tokenize(query)))
    if not terms:
        return ""
    return f" {operator} ".join('"' + term.replace('"', '""') + '"' for term in terms)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--corpus-version", required=True)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--operator", choices=("AND", "OR"), default="AND")
    parser.add_argument(
        "--query-overrides",
        type=Path,
        help="Optional complete questionId -> English search-query map bound to this exact dataset",
    )
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.top_k < 1:
        parser.error("--top-k must be positive")

    dataset = read_json(args.dataset)
    overrides: dict[str, str] = {}
    override_hash = None
    if args.query_overrides:
        override_file = read_json(args.query_overrides)
        if override_file.get("datasetId") != dataset.get("datasetId"):
            raise ValueError("query override datasetId does not match the frozen dataset")
        if override_file.get("sourceDatasetSha256") != sha256(args.dataset):
            raise ValueError("query override sourceDatasetSha256 does not match the frozen dataset")
        overrides = {
            item["questionId"]: item["englishSearchQuery"]
            for item in override_file.get("queryExpansions", [])
            if isinstance(item, dict)
            and isinstance(item.get("questionId"), str)
            and isinstance(item.get("englishSearchQuery"), str)
        }
        expected_ids = {item["questionId"] for item in dataset.get("questions", [])}
        if set(overrides) != expected_ids or len(overrides) != len(override_file.get("queryExpansions", [])):
            raise ValueError("query overrides must contain exactly one nonempty entry per frozen question")
        if any(not query.strip() or "\ufffd" in query for query in overrides.values()):
            raise ValueError("query overrides contain an empty string or replacement character")
        override_hash = sha256(args.query_overrides)
    index = Fts5Bm25Index(args.index, args.corpus_version, args.manifest_sha256)
    queries = []
    for question in dataset["questions"]:
        started = time.perf_counter()
        retrieval_query = overrides.get(question["questionId"], question["query"])
        expression = query_expression(retrieval_query, args.operator)
        if expression:
            rows = index.connection.execute(
                "SELECT m.document_id,m.source,m.title,bm25(sparse_docs,3.0,1.0) AS rank_score "
                "FROM sparse_docs JOIN sparse_meta AS m ON m.rowid=sparse_docs.rowid "
                "WHERE sparse_docs MATCH ? ORDER BY rank_score ASC,m.document_id ASC LIMIT ?",
                (expression, args.top_k),
            ).fetchall()
        else:
            rows = []
        results = [
            {
                "documentId": row[0],
                "source": row[1],
                "title": row[2],
                "score": float(-row[3]),
                "rank": rank,
            }
            for rank, row in enumerate(rows, start=1)
        ]
        queries.append(
            {
                "questionId": question["questionId"],
                "status": "ok",
                "retrievalQuery": retrieval_query,
                "latencyMs": round((time.perf_counter() - started) * 1000, 1),
                "plannerCalls": 0,
                "plannerInputTokens": 0,
                "plannerOutputTokens": 0,
                "abstained": False,
                "results": results,
            }
        )
    index.close()

    result = {
        "schemaVersion": "huiyi-rag-retrieval-run/v1",
        "datasetId": dataset["datasetId"],
        "corpusVersion": args.corpus_version,
        "method": f"bm25-{args.operator.lower()}-{'english-expanded-' if overrides else ''}probe",
        "candidateBudget": args.top_k,
        "candidatePolicy": "single-channel FTS5; same local index; read-only probe; query overrides are lexical translations only" if overrides else "single-channel FTS5; frozen query; same local index; read-only probe",
        "retrieverConfig": {
            "engine": "SQLite FTS5 bm25",
            "tokenizer": "latin-word-casefold+cjk-character-bigram-v1",
            "matchOperator": args.operator,
            "titleWeight": 3.0,
            "bodyWeight": 1.0,
            "queryVariant": "gpt-6-luna English lexical translation" if overrides else "frozen original query",
        },
        "queries": queries,
        "inputHashes": {
            "dataset": sha256(args.dataset),
            "index": sha256(args.index),
            "probeScript": sha256(Path(__file__).resolve()),
            **({"queryOverrides": override_hash} if override_hash else {}),
        },
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "operator": args.operator,
                "questionCount": len(queries),
                "nonemptyQueryCount": sum(bool(item["results"]) for item in queries),
                "returnedCandidates": sum(len(item["results"]) for item in queries),
                "datasetSha256": result["inputHashes"]["dataset"],
                "indexSha256": result["inputHashes"]["index"],
                "out": str(args.out),
            },
            ensure_ascii=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
