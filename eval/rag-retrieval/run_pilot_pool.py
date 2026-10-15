#!/usr/bin/env python3
"""Run bounded Dense/BM25/RRF/reranker candidate pooling for a frozen H2 DEV or HOLDOUT split."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import random
import time
from pathlib import Path
from typing import Any

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from score import combine_serial_stage_latency_ms
from sparse_index import Fts5Bm25Index


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _as_result(document_id: str, source: str, score: float, rank: int, title: str) -> dict[str, Any]:
    return {"documentId": document_id, "source": source, "score": float(score), "rank": rank, "title": title}


def _rrf(lists: list[list[dict[str, Any]]], limit: int, constant: int = 60) -> list[dict[str, Any]]:
    fused: dict[str, dict[str, Any]] = {}
    for method_results in lists:
        for rank, item in enumerate(method_results, start=1):
            candidate = fused.setdefault(item["documentId"], {**item, "rrfScore": 0.0, "candidateMethods": []})
            candidate["rrfScore"] += 1.0 / (constant + rank)
            method = item.get("method")
            if isinstance(method, str) and method not in candidate["candidateMethods"]:
                candidate["candidateMethods"].append(method)
    ordered = sorted(fused.values(), key=lambda item: (-item["rrfScore"], item["documentId"]))[:limit]
    return [_as_result(item["documentId"], item["source"], item["rrfScore"], rank, item["title"]) for rank, item in enumerate(ordered, start=1)]


def _rerank(
    query: str,
    candidates: list[dict[str, Any]],
    corpus: Any,
    chunks_by_source: dict[str, Any],
    tokenizer: Any,
    model: Any,
    device: str,
    batch_size: int,
) -> tuple[list[dict[str, Any]], float]:
    pairs = []
    for candidate in candidates:
        source, source_document_id, chunk_id = candidate["documentId"].split(":", 2)
        chunk = chunks_by_source[source].chunks[(source_document_id, int(chunk_id))]
        pairs.append((candidate, chunk.content))
    scores: list[float] = []
    started = time.perf_counter()
    model.eval()
    with torch.inference_mode():
        for offset in range(0, len(pairs), batch_size):
            batch = pairs[offset : offset + batch_size]
            encoded = tokenizer(
                [query] * len(batch),
                [item[1] for item in batch],
                padding=True,
                truncation=True,
                max_length=512,
                return_tensors="pt",
            )
            encoded = {key: value.to(device) for key, value in encoded.items()}
            logits = model(**encoded).logits.reshape(-1).float().cpu().tolist()
            scores.extend(float(score) for score in logits)
    elapsed_ms = (time.perf_counter() - started) * 1000
    reranked = []
    for (candidate, _content), score in zip(pairs, scores, strict=True):
        reranked.append({**candidate, "score": score})
    reranked.sort(key=lambda item: (-item["score"], item["documentId"]))
    return [{**item, "rank": rank} for rank, item in enumerate(reranked, start=1)], round(elapsed_ms, 1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--corpus-root", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--verification", required=True, type=Path)
    parser.add_argument("--query-encoder", required=True, type=Path)
    parser.add_argument("--bm25-index", required=True, type=Path)
    parser.add_argument("--reranker", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    parser.add_argument("--reranker-batch-size", type=int, default=8)
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    engine_src = repo_root / "services" / "health-engine" / "src"
    import sys

    sys.path.insert(0, str(engine_src))
    from huiyi_health_engine.rag.corpus import CorpusRepository
    from huiyi_health_engine.rag.retriever import Qwen3EmbeddingRetriever

    for env_key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
        import os

        os.environ[env_key] = "1"
    if args.top_k < 1 or args.reranker_batch_size < 1:
        parser.error("top-k and reranker-batch-size must be positive")
    if args.device == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested but is unavailable")
        free_vram, total_vram = torch.cuda.mem_get_info()
        if free_vram < 8 * (1024**3):
            raise RuntimeError("less than 8 GiB of free VRAM; stopping before model load")
    dataset_raw = args.dataset.read_bytes()
    dataset = json.loads(dataset_raw.decode("utf-8"))
    manifest_raw = args.manifest.read_bytes()
    manifest = json.loads(manifest_raw.decode("utf-8"))
    dataset_hash = hashlib.sha256(dataset_raw).hexdigest()
    manifest_hash = hashlib.sha256(manifest_raw).hexdigest()
    verified = json.loads(args.verification.read_text(encoding="utf-8"))
    if verified.get("status") != "verified" or verified.get("manifestSha256") != manifest_hash:
        raise RuntimeError("the five-source Qwen manifest does not match the verified index artifact")
    if dataset.get("corpusVersion") != manifest.get("corpusVersion"):
        raise RuntimeError("draft dataset corpusVersion differs from the selected corpus manifest")
    if dataset.get("split") not in {"dev", "holdout"}:
        raise RuntimeError("candidate pooling requires an explicitly split DEV or HOLDOUT dataset")

    corpus = CorpusRepository(args.corpus_root, args.manifest, verify_hashes=False).load()
    if corpus.version != manifest["corpusVersion"] or corpus.retriever_name != "Qwen3-Embedding-0.6B":
        raise RuntimeError("loaded corpus does not match the intended Qwen3 five-source manifest")
    sparse = Fts5Bm25Index(args.bm25_index, corpus.version, manifest_hash)

    dense = Qwen3EmbeddingRetriever(corpus, str(args.query_encoder), device=args.device)
    chunk_bundles = {bundle.corpus: bundle for bundle in corpus.indices}
    method_queries: dict[str, list[dict[str, Any]]] = {"dense": [], "bm25": [], "rrf": [], "rrf-reranker": []}
    packet_questions = []
    all_pool_count = 0
    retrieval_started = time.perf_counter()
    for question in dataset["questions"]:
        question_id = question["questionId"]
        query = question["query"]
        dense_started = time.perf_counter()
        dense_candidates = dense.search(query, args.top_k, 1)
        dense_ms = round((time.perf_counter() - dense_started) * 1000, 1)
        dense_results = [
            {**_as_result(item.chunk.stable_id, item.chunk.corpus, item.score, rank, item.chunk.title), "method": "dense"}
            for rank, item in enumerate(dense_candidates, start=1)
        ]
        bm_started = time.perf_counter()
        bm25_results = sparse.search(query, args.top_k)
        bm25_ms = round((time.perf_counter() - bm_started) * 1000, 1)
        bm25_results = [{**_as_result(item["documentId"], item["source"], item["score"], item["rank"], item["title"]), "method": "bm25"} for item in bm25_results]
        fused = _rrf([dense_results, bm25_results], args.top_k)
        method_queries["dense"].append({"questionId": question_id, "status": "ok", "latencyMs": dense_ms, "plannerCalls": 0, "plannerInputTokens": 0, "plannerOutputTokens": 0, "abstained": False, "results": [{k: v for k, v in item.items() if k != "method"} for item in dense_results]})
        method_queries["bm25"].append({"questionId": question_id, "status": "ok", "latencyMs": bm25_ms, "plannerCalls": 0, "plannerInputTokens": 0, "plannerOutputTokens": 0, "abstained": False, "results": [{k: v for k, v in item.items() if k != "method"} for item in bm25_results]})
        method_queries["rrf"].append({"questionId": question_id, "status": "ok", "latencyMs": round(dense_ms + bm25_ms, 1), "plannerCalls": 0, "plannerInputTokens": 0, "plannerOutputTokens": 0, "abstained": False, "results": fused})

        union: dict[str, dict[str, Any]] = {}
        for method_name, results in (("dense", dense_results), ("bm25", bm25_results)):
            for item in results:
                candidate = union.setdefault(item["documentId"], {k: item[k] for k in ["documentId", "source", "title"]})
                candidate.setdefault("candidateMethods", []).append(method_name)
        blind_items = []
        for document_id, candidate in union.items():
            source, source_document_id, chunk_id = document_id.split(":", 2)
            chunk = chunk_bundles[source].chunks[(source_document_id, int(chunk_id))]
            blind_seed = hashlib.sha256(f"h2-pilot-blind-v1|{dataset_hash}|{question_id}|{document_id}".encode()).hexdigest()
            blind_items.append({
                "blindOrderKey": blind_seed,
                "candidateId": "C-" + blind_seed[:12],
                "documentId": document_id,
                "source": source,
                "title": chunk.title,
                "snippet": chunk.content[:2500],
                "snippetTruncated": len(chunk.content) > 2500,
                "sourceUri": chunk.source_uri,
            })
        blind_items.sort(key=lambda item: item["blindOrderKey"])
        for item in blind_items:
            item.pop("blindOrderKey")
        pool_items = [
            {"documentId": item["documentId"], "source": item["source"], "candidateMethods": union[item["documentId"]]["candidateMethods"]}
            for item in blind_items
        ]
        packet_questions.append({
            "questionId": question_id,
            "query": query,
            "language": question["language"],
            "taskCategory": question["taskCategory"],
            "answerability": "pending",
            "candidatePool": blind_items,
            "qrels": [],
            "annotations": [],
            "reviewStatus": "pending",
        })
        question["candidatePool"] = pool_items
        all_pool_count += len(pool_items)
    retrieval_seconds = round(time.perf_counter() - retrieval_started, 3)
    sparse.close()

    for method, rows in method_queries.items():
        if method == "rrf-reranker":
            continue
        run = {
            "schemaVersion": "huiyi-rag-retrieval-run/v1",
            "datasetId": dataset["datasetId"],
            "corpusVersion": corpus.version,
            "method": method,
            "candidateBudget": args.top_k,
            "decisionThreshold": None,
            "manifestSha256": manifest_hash,
            "datasetSha256": dataset_hash,
            "model": {"name": corpus.retriever_name, "revision": corpus.query_encoder_revision} if method == "dense" else None,
            "retrieverConfig": {"topK": args.top_k, "rrfConstant": 60 if method == "rrf" else None, "tokenizer": "latin-word-casefold+cjk-character-bigram-v1" if method == "bm25" else None},
            "runnerSha256": _sha256(Path(__file__)),
            "queries": rows,
        }
        _write_json(args.out_dir / f"run-{method}.json", run)

    annotation_packet = {
        "schemaVersion": "huiyi-rag-annotation-packet/v1",
        "datasetId": dataset["datasetId"],
        "corpusVersion": corpus.version,
        "manifestSha256": manifest_hash,
        "instruction": "盲化候选；只按固定标注协议评 query 与候选片段。不要推断候选来自哪个检索方法。",
        "reviewStatus": "pending_two_independent_reviewers",
        "questions": packet_questions,
    }
    _write_json(args.out_dir / "annotation-packet.blinded.json", annotation_packet)
    _write_json(args.out_dir / "candidate-pool.private.json", {
        "schemaVersion": "huiyi-rag-candidate-pool/v1",
        "datasetSha256": dataset_hash,
        "manifestSha256": manifest_hash,
        "corpusVersion": corpus.version,
        "topKPerChannel": args.top_k,
        "candidateCount": all_pool_count,
        "methodRuns": {key: f"run-{key}.json" for key in ["dense", "bm25", "rrf"]},
        "questions": [{"questionId": item["questionId"], "candidatePool": item["candidatePool"]} for item in dataset["questions"]],
    })
    _write_json(args.out_dir / "pilot-queries.with-pool.pending.json", dataset)

    del dense
    gc.collect()
    if args.device == "cuda":
        torch.cuda.empty_cache()
        free_vram, _ = torch.cuda.mem_get_info()
        if free_vram < 8 * (1024**3):
            raise RuntimeError("less than 8 GiB of free VRAM after Dense queries; reranker load skipped")
    reranker_started = time.perf_counter()
    reranker_tokenizer = AutoTokenizer.from_pretrained(str(args.reranker), local_files_only=True)
    reranker_model = AutoModelForSequenceClassification.from_pretrained(
        str(args.reranker), local_files_only=True, torch_dtype=torch.float16 if args.device == "cuda" else "auto"
    ).to(args.device)
    reranker_model.eval()
    reranker_queries = []
    packet_lookup = {item["questionId"]: item for item in packet_questions}
    for question in dataset["questions"]:
        candidates = [
            {"documentId": item["documentId"], "source": item["source"], "title": item["title"], "score": 0.0, "rank": rank}
            for rank, item in enumerate(packet_lookup[question["questionId"]]["candidatePool"], start=1)
        ]
        # D reranks only C's top-k RRF candidates; no candidate is added.
        rrf_row = next(item for item in method_queries["rrf"] if item["questionId"] == question["questionId"])
        rrf_ids = {item["documentId"] for item in rrf_row["results"]}
        rrf_candidates = [item for item in candidates if item["documentId"] in rrf_ids]
        reranked, reranker_stage_ms = _rerank(question["query"], rrf_candidates, corpus, chunk_bundles, reranker_tokenizer, reranker_model, args.device, args.reranker_batch_size)
        reranker_queries.append({
            "questionId": question["questionId"],
            "status": "ok",
            "latencyMs": combine_serial_stage_latency_ms(rrf_row["latencyMs"], reranker_stage_ms),
            "retrievalLatencyMs": rrf_row["latencyMs"],
            "rerankerStageLatencyMs": reranker_stage_ms,
            "plannerCalls": 0,
            "plannerInputTokens": 0,
            "plannerOutputTokens": 0,
            "abstained": False,
            "results": reranked,
        })
    reranker_total_ms = round((time.perf_counter() - reranker_started) * 1000, 1)
    reranker_run = {
        "schemaVersion": "huiyi-rag-retrieval-run/v1",
        "datasetId": dataset["datasetId"],
        "corpusVersion": corpus.version,
        "method": "rrf-reranker",
        "candidateBudget": args.top_k,
        "decisionThreshold": None,
        "manifestSha256": manifest_hash,
        "datasetSha256": dataset_hash,
        "model": {"name": "bge-reranker-v2-m3", "localPath": str(args.reranker)},
        "retrieverConfig": {"candidatePool": "RRF topK", "batchSize": args.reranker_batch_size, "maxLength": 512, "device": args.device, "latencyDefinition": "per-query RRF retrieval plus warm reranker stage; excludes one-time model loading", "aggregateRerankerWallMs": reranker_total_ms},
        "runnerSha256": _sha256(Path(__file__)),
        "queries": reranker_queries,
    }
    _write_json(args.out_dir / "run-rrf-reranker.json", reranker_run)
    _write_json(args.out_dir / "pool-run-metadata.json", {
        "schemaVersion": "huiyi-rag-pool-run/v1",
        "status": "candidate_pool_only_not_scored",
        "datasetId": dataset["datasetId"],
        "corpusVersion": corpus.version,
        "manifestSha256": manifest_hash,
        "datasetSha256": dataset_hash,
        "queryCount": len(dataset["questions"]),
        "candidatePoolTotal": all_pool_count,
        "topKPerChannel": args.top_k,
        "densePlusBm25WallSeconds": retrieval_seconds,
        "rerankerAggregateWallMs": reranker_total_ms,
        "modelsWereLocalOnly": True,
        "patientContextIncluded": False,
        "clinicalLabels": "pending; no Recall/MRR/nDCG score is produced",
    })
    print(json.dumps({"status": "candidate_pool_ready_pending_review", "queryCount": len(dataset["questions"]), "candidatePoolTotal": all_pool_count, "densePlusBm25WallSeconds": retrieval_seconds, "rerankerAggregateWallMs": reranker_total_ms, "outDir": str(args.out_dir)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
