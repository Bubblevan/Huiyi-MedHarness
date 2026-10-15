#!/usr/bin/env python3
"""Run a bounded, local Codex GPT-6-Luna Planner ablation on H2 DEV drafts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--corpus-root", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--verification", required=True, type=Path)
    parser.add_argument("--query-encoder", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    parser.add_argument("--max-rounds", type=int, default=2)
    parser.add_argument("--queries-per-round", type=int, default=1)
    parser.add_argument("--planner-max-tokens", type=int, default=128)
    parser.add_argument("--planner-timeout-seconds", type=int, default=45)
    parser.add_argument("--max-run-seconds", type=int, default=1800)
    args = parser.parse_args()

    if args.top_k < 1 or args.max_rounds not in {1, 2} or args.queries_per_round != 1:
        parser.error("pilot budget requires top-k >= 1, max-rounds in {1,2}, and exactly one query per round")
    if not 32 <= args.planner_max_tokens <= 512:
        parser.error("planner-max-tokens must be between 32 and 512")
    if not 60 <= args.max_run_seconds <= 3600:
        parser.error("max-run-seconds must be between 60 and 3600")
    if args.device == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested but is unavailable")
        free_vram, _ = torch.cuda.mem_get_info()
        if free_vram < 8 * (1024**3):
            raise RuntimeError("less than 8 GiB of free VRAM; stopping before model load")

    repo_root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(repo_root / "services" / "health-engine" / "src"))
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    from huiyi_health_engine.rag.config import RagSettings
    from huiyi_health_engine.rag.corpus import CorpusRepository
    from huiyi_health_engine.rag.iterative import IterativeEvidenceAcquirer
    from huiyi_health_engine.rag.planner import QueryPlanner
    from huiyi_health_engine.rag.retriever import Qwen3EmbeddingRetriever

    dataset_raw = args.dataset.read_bytes()
    dataset = json.loads(dataset_raw.decode("utf-8"))
    manifest_raw = args.manifest.read_bytes()
    manifest = json.loads(manifest_raw.decode("utf-8"))
    dataset_sha = hashlib.sha256(dataset_raw).hexdigest()
    manifest_sha = hashlib.sha256(manifest_raw).hexdigest()
    verified = json.loads(args.verification.read_text(encoding="utf-8"))
    if verified.get("status") != "verified" or verified.get("manifestSha256") != manifest_sha:
        raise RuntimeError("the five-source Qwen manifest does not match the verified index artifact")
    if dataset.get("corpusVersion") != manifest.get("corpusVersion") or dataset.get("split") != "dev":
        raise RuntimeError("dataset must use the selected corpusVersion and DEV split")
    if args.out.exists():
        raise RuntimeError("output exists; choose a new run filename to preserve prior measurements")

    settings = RagSettings.from_env()
    if settings.planner_model != "gpt-6-luna" or settings.planner_url != "http://127.0.0.1:8333/v1/chat/completions":
        raise RuntimeError("planner must use the verified local Codex GPT-6-Luna loopback route")
    settings = replace(
        settings,
        query_encoder_path=args.query_encoder,
        query_encoder_device=args.device,
        query_max_length=512,
        planner_timeout_seconds=args.planner_timeout_seconds,
        planner_max_tokens=args.planner_max_tokens,
        default_mode="iterative",
        max_rounds=args.max_rounds,
        max_queries_per_round=args.queries_per_round,
        candidates_per_query=args.top_k,
        max_returned_evidence=3,
        request_timeout_ms=300_000,
    )
    corpus = CorpusRepository(args.corpus_root, args.manifest, verify_hashes=False).load()
    if corpus.version != manifest["corpusVersion"] or corpus.retriever_name != "Qwen3-Embedding-0.6B":
        raise RuntimeError("loaded corpus does not match the intended Qwen3 five-source manifest")
    retriever = Qwen3EmbeddingRetriever(corpus, str(args.query_encoder), device=args.device, query_max_length=512)
    planner = QueryPlanner(settings)
    acquirer = IterativeEvidenceAcquirer(settings, retriever, planner)

    run: dict[str, Any] = {
        "schemaVersion": "huiyi-rag-retrieval-run/v1",
        "datasetId": dataset["datasetId"],
        "corpusVersion": corpus.version,
        "method": "dense-iterative-gpt6-luna",
        "candidateBudget": args.top_k,
        "decisionThreshold": None,
        "manifestSha256": manifest_sha,
        "datasetSha256": dataset_sha,
        "model": {
            "name": corpus.retriever_name,
            "revision": corpus.query_encoder_revision,
            "planner": settings.planner_model,
            "plannerRoute": "local-codex-app-server-loopback",
        },
        "retrieverConfig": {
            "topKPerPlannedQuery": args.top_k,
            "finalCandidateBudget": args.top_k,
            "maxRounds": args.max_rounds,
            "maxQueriesPerRound": args.queries_per_round,
            "plannerMaxTokens": args.planner_max_tokens,
            "plannerTimeoutSeconds": args.planner_timeout_seconds,
            "device": args.device,
            "mode": "iterative",
        },
        "runnerSha256": _sha256(Path(__file__)),
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "queries": [],
    }

    run_started = time.monotonic()
    for question in dataset["questions"]:
        started = time.perf_counter()
        question_id = question["questionId"]
        if time.monotonic() - run_started >= args.max_run_seconds:
            row = {
                "questionId": question_id,
                "status": "timeout",
                "latencyMs": 0,
                "failureClass": "RunBudgetExhausted",
                "plannerCalls": 0,
                "plannerInputTokens": None,
                "plannerOutputTokens": None,
                "abstained": False,
                "results": [],
            }
            run["queries"].append(row)
            _write_json(args.out.with_suffix(args.out.suffix + ".partial"), run)
            print(json.dumps({"questionId": question_id, "status": "timeout", "failureClass": "RunBudgetExhausted"}, ensure_ascii=False), flush=True)
            continue
        try:
            acquisition = acquirer.acquire(
                question["query"],
                "iterative",
                args.top_k,
                deadline=time.monotonic() + settings.request_timeout_ms / 1000,
            )
            end_to_end_ms = round((time.perf_counter() - started) * 1000, 1)
            results = []
            for rank, item in enumerate(acquisition.candidates[: args.top_k], start=1):
                results.append({
                    "documentId": item.best.chunk.stable_id,
                    "source": item.best.chunk.corpus,
                    "score": float(item.best.score),
                    "rank": rank,
                    "title": item.best.chunk.title,
                    "firstRetrievedRound": item.first_round,
                    "retrievalQueries": list(item.queries),
                })
            row = {
                "questionId": question_id,
                "status": "degraded" if acquisition.degraded or acquisition.effective_mode != "iterative" else "ok",
                "latencyMs": end_to_end_ms,
                "rounds": acquisition.rounds,
                "generatedQueries": acquisition.generated_queries,
                "retrievalCalls": acquisition.retrieval_calls,
                "plannerCalls": acquisition.planner_calls,
                "plannerInputTokens": acquisition.planner_input_tokens,
                "plannerOutputTokens": acquisition.planner_output_tokens,
                "plannerLatencyMs": round(acquisition.planner_latency_ms, 1),
                "retrievalLatencyMs": round(acquisition.retrieval_latency_ms, 1),
                "degraded": acquisition.degraded,
                "degradedErrorClass": acquisition.degraded_error_class,
                "abstained": False,
                "results": results,
            }
        except Exception as exc:
            row = {
                "questionId": question_id,
                "status": "error",
                "latencyMs": round((time.perf_counter() - started) * 1000, 1),
                "failureClass": type(exc).__name__,
                "plannerCalls": 0,
                "plannerInputTokens": None,
                "plannerOutputTokens": None,
                "abstained": False,
                "results": [],
            }
        run["queries"].append(row)
        _write_json(args.out.with_suffix(args.out.suffix + ".partial"), run)
        print(json.dumps({
            "questionId": question_id,
            "status": row["status"],
            "rounds": row.get("rounds"),
            "plannerCalls": row.get("plannerCalls"),
            "generatedQueries": row.get("generatedQueries"),
            "candidateCountReturned": len(row["results"]),
            "latencyMs": row["latencyMs"],
        }, ensure_ascii=False), flush=True)

    run["finishedAt"] = datetime.now(timezone.utc).isoformat()
    _write_json(args.out, run)
    print(json.dumps({
        "status": "complete_pending_qrels",
        "method": run["method"],
        "queryCount": len(run["queries"]),
        "successCount": sum(item["status"] == "ok" for item in run["queries"]),
        "degradedCount": sum(item["status"] == "degraded" for item in run["queries"]),
        "errorCount": sum(item["status"] == "error" for item in run["queries"]),
        "totalPlannerCalls": sum(int(item.get("plannerCalls") or 0) for item in run["queries"]),
        "out": str(args.out),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
