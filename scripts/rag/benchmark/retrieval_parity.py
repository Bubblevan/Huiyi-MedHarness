#!/usr/bin/env python3
"""Compare pinned MedRAG and Huiyi MedCPT retrieval on sanitized validation input."""

from __future__ import annotations

import argparse
import builtins
import hashlib
import json
import sys
from itertools import zip_longest
from pathlib import Path
from statistics import mean, median
from typing import Any


if sys.version_info < (3, 10):
    # The pinned MedRAG research environment is Python 3.9, while the Huiyi
    # health-engine requires Python >=3.11 and uses zip(strict=True). Keep the
    # comparison on the same pinned model stack by providing Python 3.10's
    # strict-zip behavior locally to this one process.
    _native_zip = builtins.zip

    def _zip_with_strict(*iterables: Any, strict: bool = False):
        if not strict:
            return _native_zip(*iterables)
        sentinel = object()

        def iterate():
            for row in zip_longest(*iterables, fillvalue=sentinel):
                if any(value is sentinel for value in row):
                    raise ValueError("zip() arguments have different lengths")
                yield row

        return iterate()

    builtins.zip = _zip_with_strict


def spearman(left: list[str], right: list[str]) -> float:
    right_rank = {item: rank for rank, item in enumerate(right)}
    common = [item for item in left if item in right_rank]
    if len(common) < 2:
        return 1.0 if left == right else 0.0
    n = len(common)
    squared = sum((rank - right_rank[item]) ** 2 for rank, item in enumerate(common))
    return 1.0 - 6.0 * squared / (n * (n * n - 1))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def stable_id(corpus: str, raw_id: str) -> str:
    source, raw_index = raw_id.rsplit("_", 1)
    return f"{corpus}:{source}:{raw_index}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--medrag-root", type=Path, required=True)
    parser.add_argument("--corpus-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--query-encoder", type=Path, required=True)
    parser.add_argument("--inference-jsonl", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--top-k", type=int, default=32)
    args = parser.parse_args()

    sys.dont_write_bytecode = True
    sys.path.insert(0, str(args.medrag_root.resolve()))
    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "health-engine" / "src"))
    import src.utils as medrag_utils
    from huiyi_health_engine.rag.corpus import CorpusRepository
    from huiyi_health_engine.rag.retriever import MedCptRetriever

    # Pinned upstream resolves its canonical HF model name through the network.
    # Route that same identifier to the already pinned local snapshot so the
    # comparison remains offline and uses the exact same model files.
    upstream_sentence_transformer = medrag_utils.CustomizeSentenceTransformer
    query_encoder_path = str(args.query_encoder.resolve())

    class LocalMedCptSentenceTransformer(upstream_sentence_transformer):
        def __init__(self, model_name_or_path: str, *model_args: Any, **kwargs: Any):
            if model_name_or_path == "ncbi/MedCPT-Query-Encoder":
                model_name_or_path = query_encoder_path
            super().__init__(model_name_or_path, *model_args, **kwargs)

    medrag_utils.CustomizeSentenceTransformer = LocalMedCptSentenceTransformer

    corpus_root = args.corpus_root.resolve()
    prepared = CorpusRepository(corpus_root, args.manifest.resolve()).load()
    upstream = medrag_utils.RetrievalSystem(
        retriever_name="MedCPT",
        corpus_name="MedText",
        db_dir=str(corpus_root),
        HNSW=False,
        cache=False,
    )
    huiyi = MedCptRetriever(
        prepared,
        str(args.query_encoder.resolve()),
        device="cuda",
        query_max_length=512,
    )
    owners: dict[str, set[str]] = {}
    for source in prepared.indices:
        for source_document_id, _chunk_id in source.chunks:
            owners.setdefault(source_document_id, set()).add(source.corpus)
    duplicates = [source_id for source_id, source_names in owners.items() if len(source_names) != 1]
    if duplicates:
        raise RuntimeError(f"MedText has ambiguous cross-corpus chunk filenames, for example {duplicates[0]}")
    owner_by_file = {
        source_document_id: next(iter(source_names))
        for source_document_id, source_names in owners.items()
    }

    cases: list[dict[str, Any]] = []
    for line in args.inference_jsonl.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        case = json.loads(line)
        if not isinstance(case, dict) or set(case) != {"id", "question", "options"}:
            raise ValueError("retrieval parity accepts only id/question/options cases")
        query = case["question"]
        upstream_hits, upstream_scores = upstream.retrieve(query, k=args.top_k, id_only=True)
        upstream_ids: list[str] = []
        for hit in upstream_hits:
            raw_id = hit["id"]
            source_name, _ = raw_id.rsplit("_", 1)
            corpus = owner_by_file.get(source_name)
            if corpus is None:
                raise RuntimeError(f"upstream returned unknown chunk source {source_name}")
            upstream_ids.append(stable_id(corpus, raw_id))
        huiyi_candidates = huiyi.search(query, args.top_k, 1)
        huiyi_ids = [candidate.chunk.stable_id for candidate in huiyi_candidates]
        huiyi_scores = [candidate.score for candidate in huiyi_candidates]
        if len(upstream_ids) != len(huiyi_ids):
            raise RuntimeError(f"top-k result count differs for case {case['id']}")
        common = set(upstream_ids).intersection(huiyi_ids)
        upstream_score_by_id = dict(zip(upstream_ids, upstream_scores, strict=True))
        huiyi_score_by_id = dict(zip(huiyi_ids, huiyi_scores, strict=True))
        score_deltas = [abs(upstream_score_by_id[item] - huiyi_score_by_id[item]) for item in common]
        overlap = len(common) / args.top_k
        cases.append({
            "id": case["id"],
            "top1Match": bool(upstream_ids and huiyi_ids and upstream_ids[0] == huiyi_ids[0]),
            "topKOverlap": overlap,
            "rankAgreement": spearman(upstream_ids, huiyi_ids),
            "maxAbsoluteScoreDelta": max(score_deltas, default=0.0),
            "upstreamIds": upstream_ids,
            "huiyiIds": huiyi_ids,
        })

    top1_rate = mean(float(case["top1Match"]) for case in cases) if cases else 0.0
    overlaps = [case["topKOverlap"] for case in cases]
    agreements = [case["rankAgreement"] for case in cases]
    deltas = [case["maxAbsoluteScoreDelta"] for case in cases]
    result = {
        "upstream": {"repository": "https://github.com/gzxiong/MedRAG", "revision": "7599a728a28789fd601728c08d313b1148051f41"},
        "harnessCorpusVersion": prepared.version,
        "queryEncoder": {"model": prepared.query_encoder_model, "revision": prepared.query_encoder_revision},
        "topK": args.top_k,
        "caseCount": len(cases),
        "inferenceInputSha256": sha256(args.inference_jsonl),
        "metrics": {
            "top1MatchRate": top1_rate,
            "meanTopKOverlap": mean(overlaps) if overlaps else 0.0,
            "minimumTopKOverlap": min(overlaps) if overlaps else 0.0,
            "meanRankAgreement": mean(agreements) if agreements else 0.0,
            "medianRankAgreement": median(agreements) if agreements else 0.0,
            "maxAbsoluteScoreDelta": max(deltas, default=0.0),
        },
        "gate": {
            "top1Match100Percent": top1_rate == 1.0,
            "topKOverlapAtLeast99Percent": bool(overlaps and min(overlaps) >= 0.99),
            "scoreDeltaAtFloatingPointScale": bool(deltas and max(deltas) <= 1e-5),
        },
        "cases": cases,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"metrics": result["metrics"], "gate": result["gate"], "output": str(args.output)}, indent=2))


if __name__ == "__main__":
    main()
