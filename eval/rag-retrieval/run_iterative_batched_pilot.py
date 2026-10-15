#!/usr/bin/env python3
"""Run the frozen H2 iterative arm with an evaluation-only batched Codex planner."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch


def _read_json(path: Path) -> tuple[Any, bytes, str]:
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), raw, hashlib.sha256(raw).hexdigest()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def _merge_results(target: dict[str, dict[str, Any]], results: list[Any], round_number: int, query: str) -> None:
    for item in results:
        chunk = item.chunk
        document_id = chunk.stable_id
        existing = target.get(document_id)
        if existing is None:
            target[document_id] = {
                "documentId": document_id,
                "source": chunk.corpus,
                "title": chunk.title,
                "score": float(item.score),
                "firstRetrievedRound": round_number,
                "retrievalQueries": [query],
                "bestQuery": query,
            }
        else:
            existing["firstRetrievedRound"] = min(existing["firstRetrievedRound"], round_number)
            if query not in existing["retrievalQueries"]:
                existing["retrievalQueries"].append(query)
            if float(item.score) > existing["score"]:
                existing["score"] = float(item.score)
                existing["bestQuery"] = query


def _sorted_accumulator(accumulator: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(accumulator.values(), key=lambda item: (-item["score"], item["documentId"]))


def _batches(values: list[Any], size: int) -> list[list[Any]]:
    return [values[offset : offset + size] for offset in range(0, len(values), size)]


def _plan_batches(
    planner: Any,
    inputs: list[dict[str, Any]],
    round_number: int,
    batch_size: int,
    *,
    run: dict[str, Any],
    states: dict[str, dict[str, Any]],
    partial_path: Path,
    run_started: float,
    max_run_seconds: int,
    retriever: Any,
    top_k: int,
    timeout_seconds: int,
) -> None:
    from huiyi_health_engine.rag.planner import PlannerError

    complete_key = f"round{round_number}Complete"
    query_key = f"round{round_number}Query"
    latency_key = f"round{round_number}PlannerBatchLatencyMs"
    retrieval_latency_key = f"round{round_number}RetrievalLatencyMs"
    call_id_key = f"round{round_number}PlannerCallId"
    for batch in _batches(inputs, batch_size):
        remaining = [item for item in batch if not states[item["questionId"]].get(complete_key)]
        if not remaining:
            continue
        if time.monotonic() - run_started >= max_run_seconds:
            for item in remaining:
                state = states[item["questionId"]]
                state[complete_key] = True
                state["degraded"] = True
                state["failureClass"] = "RunBudgetExhausted"
                state["roundsCompleted"] = max(state.get("roundsCompleted", 0), round_number - 1)
            _write_json(partial_path, run)
            continue

        call_record_start = len(planner.call_records)
        try:
            plans = planner.plan_batch(remaining, round_number)
            call_record = planner.call_records[-1]
            planner_latency_ms = float(call_record.get("latencyMs") or 0.0)
            failed = False
        except PlannerError:
            call_record = planner.call_records[-1] if len(planner.call_records) > call_record_start else {
                "callId": None,
                "round": round_number,
                "questionIds": [item["questionId"] for item in remaining],
                "status": "error",
                "failureClass": "PlannerError",
                "codexTokensUsed": None,
            }
            planner_latency_ms = float(call_record.get("latencyMs") or 0.0)
            plans = {item["questionId"]: item["question"] for item in remaining}
            failed = True
        run["plannerCallRecords"] = list(planner.call_records)

        for item in remaining:
            question_id = item["questionId"]
            state = states[question_id]
            query = plans[question_id]
            state[query_key] = query
            state[latency_key] = planner_latency_ms
            state[call_id_key] = call_record.get("callId")
            state["logicalPlannerCalls"] = state.get("logicalPlannerCalls", 0) + 1
            if failed:
                state["degraded"] = True
                state["failureClass"] = call_record.get("failureClass", "PlannerError")
                if round_number == 2:
                    state[complete_key] = True
                    continue
            try:
                retrieval_started = time.perf_counter()
                found = retriever.search(query, top_k, round_number)
                retrieval_elapsed_ms = round((time.perf_counter() - retrieval_started) * 1000, 1)
                state[retrieval_latency_key] = retrieval_elapsed_ms
                state["retrievalCalls"] = state.get("retrievalCalls", 0) + 1
                if round_number == 1:
                    state["accumulator"] = {}
                _merge_results(state["accumulator"], found, round_number, query)
                state["roundsCompleted"] = max(state.get("roundsCompleted", 0), round_number)
            except Exception as error:  # noqa: BLE001 - preserve the failed question in the run denominator
                state["status"] = "error"
                state["failureClass"] = type(error).__name__
                state["degraded"] = True
            state[complete_key] = True
        _write_json(partial_path, run)


def _finish_rows(dataset: dict[str, Any], states: dict[str, dict[str, Any]], top_k: int) -> list[dict[str, Any]]:
    rows = []
    for question in dataset["questions"]:
        question_id = question["questionId"]
        state = states[question_id]
        accumulator = state.get("accumulator", {})
        results = []
        for rank, item in enumerate(_sorted_accumulator(accumulator)[:top_k], start=1):
            results.append({
                "documentId": item["documentId"],
                "source": item["source"],
                "score": item["score"],
                "rank": rank,
                "title": item["title"],
                "firstRetrievedRound": item["firstRetrievedRound"],
                "retrievalQueries": item["retrievalQueries"],
            })
        round_number = state.get("roundsCompleted", 0)
        status = state.get("status")
        if status in {None, "pending"}:
            status = "degraded" if state.get("degraded") or round_number < 2 else "ok"
        planner_latency = sum(float(state.get(f"round{r}PlannerBatchLatencyMs") or 0) for r in (1, 2))
        retrieval_latency = sum(float(state.get(f"round{r}RetrievalLatencyMs") or 0) for r in (1, 2))
        rows.append({
            "questionId": question_id,
            "status": status,
            "latencyMs": round(planner_latency + retrieval_latency, 1),
            "rounds": round_number,
            "generatedQueries": sum(bool(state.get(f"round{r}Query")) for r in (1, 2)),
            "retrievalCalls": state.get("retrievalCalls", 0),
            "plannerCalls": state.get("logicalPlannerCalls", 0),
            "plannerInputTokens": None,
            "plannerOutputTokens": None,
            "plannerCodexTokens": None,
            "plannerCallIds": [state[key] for key in ("round1PlannerCallId", "round2PlannerCallId") if state.get(key)],
            "plannerBatchSize": state.get("plannerBatchSize"),
            "plannerBatchMode": True,
            "plannerLatencyMs": round(planner_latency, 1),
            "retrievalLatencyMs": round(retrieval_latency, 1),
            "degraded": bool(state.get("degraded")),
            "degradedErrorClass": state.get("failureClass"),
            "abstained": False,
            "results": results,
        })
    return rows


def _run_split(
    *,
    dataset_path: Path,
    split: str,
    out_dir: Path,
    corpus: Any,
    retriever: Any,
    planner: Any,
    manifest_hash: str,
    batch_size: int,
    top_k: int,
    max_run_seconds: int,
    resume: bool,
    reasoning_effort: str,
    planner_timeout: int,
) -> dict[str, Any]:
    dataset, _dataset_raw, dataset_hash = _read_json(dataset_path)
    if dataset.get("split") != split or dataset.get("corpusVersion") != corpus.version:
        raise RuntimeError(f"{split} dataset split or corpusVersion does not match the frozen run")
    out_path = out_dir / f"run-iterative-{split}-codex-cli-batched.json"
    partial_path = out_path.with_suffix(out_path.suffix + ".partial")
    if out_path.exists():
        if not resume:
            raise RuntimeError(f"output already exists; refusing to overwrite: {out_path}")
        completed = json.loads(out_path.read_text(encoding="utf-8"))
        if (
            completed.get("datasetSha256") != dataset_hash
            or completed.get("manifestSha256") != manifest_hash
            or completed.get("runnerSha256") != hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        ):
            raise RuntimeError("completed split output does not match frozen data/code")
        return {
            "out": str(out_path),
            "queryCount": len(completed.get("queries", [])),
            "successCount": sum(row.get("status") == "ok" for row in completed.get("queries", [])),
            "degradedCount": sum(row.get("status") == "degraded" for row in completed.get("queries", [])),
            "errorCount": sum(row.get("status") == "error" for row in completed.get("queries", [])),
            "plannerBatchCount": completed.get("plannerBatchCount", 0),
            "totalPlannerCodexTokens": completed.get("totalPlannerCodexTokens", 0),
            "status": completed.get("status", "complete"),
        }
    run_config = {
        "planner": "gpt-6-luna",
        "plannerRoute": "local-codex-cli-batched-evaluation-only",
        "reasoningEffort": reasoning_effort,
        "plannerOutputConstraint": "one query per questionId; bounded by structured output schema",
        "plannerTimeoutSeconds": planner_timeout,
        "plannerBatchSize": batch_size,
        "topKPerRound": top_k,
        "finalCandidateBudget": top_k,
        "maxRounds": 2,
        "queriesPerRound": 1,
        "device": "cuda",
        "latencyNote": "per-query planner wait uses full shared batch latency; not production single-request latency",
    }
    run: dict[str, Any] = {
        "schemaVersion": "huiyi-rag-retrieval-run/v1",
        "datasetId": dataset["datasetId"],
        "split": split,
        "corpusVersion": corpus.version,
        "method": "dense-iterative-gpt6-luna-batched-eval",
        "candidateBudget": top_k,
        "decisionThreshold": None,
        "manifestSha256": manifest_hash,
        "datasetSha256": dataset_hash,
        "model": {
            "name": corpus.retriever_name,
            "revision": corpus.query_encoder_revision,
            "planner": "gpt-6-luna",
            "plannerRoute": "local-codex-cli-batched-evaluation-only",
        },
        "retrieverConfig": run_config,
        "runnerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "plannerCallRecords": [],
        "queries": [],
        "stateByQuestion": {},
    }
    states = {
        question["questionId"]: {
            "questionId": question["questionId"],
            "status": "pending",
            "accumulator": {},
            "round1Complete": False,
            "round2Complete": False,
            "degraded": False,
            "roundsCompleted": 0,
            "retrievalCalls": 0,
            "logicalPlannerCalls": 0,
            "plannerBatchSize": batch_size,
        }
        for question in dataset["questions"]
    }
    run["stateByQuestion"] = states
    if partial_path.exists():
        if not resume:
            raise RuntimeError(f"partial output exists; pass --resume to continue: {partial_path}")
        prior = json.loads(partial_path.read_text(encoding="utf-8"))
        if (
            prior.get("datasetSha256") != dataset_hash
            or prior.get("manifestSha256") != manifest_hash
            or prior.get("retrieverConfig") != run_config
            or prior.get("runnerSha256") != run["runnerSha256"]
        ):
            raise RuntimeError("partial run does not match frozen data, code or configuration")
        run = prior
        states = run["stateByQuestion"]
        planner.call_records = list(run.get("plannerCallRecords", []))
        planner.total_tokens_used = sum(int(record.get("codexTokensUsed") or 0) for record in planner.call_records)
        planner.known_token_call_count = sum(record.get("codexTokensUsed") is not None for record in planner.call_records)
    elif resume:
        raise RuntimeError("--resume was requested without a .partial run")

    run_started = time.monotonic()
    incomplete_round1 = [
        {"questionId": question["questionId"], "question": question["query"], "previousEvidence": []}
        for question in dataset["questions"]
        if not states[question["questionId"]].get("round1Complete")
    ]
    _plan_batches(
        planner, incomplete_round1, 1, batch_size, run=run, states=states, partial_path=partial_path,
        run_started=run_started, max_run_seconds=max_run_seconds, retriever=retriever, top_k=top_k,
        timeout_seconds=planner_timeout,
    )

    index_by_source = {item.corpus: item for item in corpus.indices}
    incomplete_round2 = []
    for question in dataset["questions"]:
        state = states[question["questionId"]]
        if state.get("round2Complete"):
            continue
        if not state.get("round1Complete") or state.get("degraded") or state.get("status") == "error":
            state["round2Complete"] = True
            continue
        previous = []
        for index, candidate in enumerate(_sorted_accumulator(state.get("accumulator", {}))[:3], start=1):
            source, source_doc, chunk_number = candidate["documentId"].split(":", 2)
            chunk = index_by_source[source].chunks[(source_doc, int(chunk_number))]
            previous.append({"title": candidate["title"], "snippet": chunk.content})
        incomplete_round2.append({
            "questionId": question["questionId"],
            "question": question["query"],
            "previousEvidence": previous,
        })
    _write_json(partial_path, run)
    _plan_batches(
        planner, incomplete_round2, 2, batch_size, run=run, states=states, partial_path=partial_path,
        run_started=run_started, max_run_seconds=max_run_seconds, retriever=retriever, top_k=top_k,
        timeout_seconds=planner_timeout,
    )
    run["plannerCallRecords"] = list(planner.call_records)
    run["plannerBatchCount"] = len(planner.call_records)
    run["totalPlannerCodexTokens"] = sum(int(record.get("codexTokensUsed") or 0) for record in planner.call_records)
    run["tokenAllocation"] = "batch totals are exact; no per-question token cost is attributed"
    run["queries"] = _finish_rows(dataset, states, top_k)
    run.pop("stateByQuestion", None)
    run["finishedAt"] = datetime.now(timezone.utc).isoformat()
    run["status"] = "complete"
    _write_json(out_path, run)
    partial_path.unlink(missing_ok=True)
    return {
        "out": str(out_path),
        "queryCount": len(run["queries"]),
        "successCount": sum(row["status"] == "ok" for row in run["queries"]),
        "degradedCount": sum(row["status"] == "degraded" for row in run["queries"]),
        "errorCount": sum(row["status"] == "error" for row in run["queries"]),
        "plannerBatchCount": run["plannerBatchCount"],
        "totalPlannerCodexTokens": run["totalPlannerCodexTokens"],
        "status": run["status"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-dev", type=Path, required=True)
    parser.add_argument("--dataset-holdout", type=Path, required=True)
    parser.add_argument("--corpus-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--verification", type=Path, required=True)
    parser.add_argument("--query-encoder", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--splits", choices=["dev", "holdout", "both"], default="both")
    parser.add_argument("--batch-size", type=int, default=10)
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    parser.add_argument("--planner-timeout-seconds", type=int, default=120)
    parser.add_argument("--max-run-seconds-per-split", type=int, default=3600)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 20 or args.top_k < 1:
        parser.error("batch-size must be 1..20 and top-k positive")
    if args.planner_timeout_seconds < 30:
        parser.error("planner timeout must be >=30 seconds")
    if not 60 <= args.max_run_seconds_per_split <= 7200:
        parser.error("max-run-seconds-per-split must be 60..7200")
    if args.device == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but unavailable")
        free_vram, _ = torch.cuda.mem_get_info()
        if free_vram < 8 * 1024**3:
            raise RuntimeError("less than 8 GiB free VRAM; stopped before model load")

    repo_root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(repo_root / "services" / "health-engine" / "src"))
    sys.path.insert(0, str(repo_root / "eval" / "rag-retrieval"))
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from huiyi_health_engine.rag.corpus import CorpusRepository
    from huiyi_health_engine.rag.retriever import Qwen3EmbeddingRetriever
    from codex_cli_batch_planner import CodexCliBatchPlanner

    manifest, _manifest_raw, manifest_hash = _read_json(args.manifest)
    verification = json.loads(args.verification.read_text(encoding="utf-8"))
    if verification.get("status") != "verified" or verification.get("manifestSha256") != manifest_hash:
        raise RuntimeError("verified five-source index manifest hash does not match")
    dev, _dev_raw, _dev_hash = _read_json(args.dataset_dev)
    holdout, _holdout_raw, _holdout_hash = _read_json(args.dataset_holdout)
    if dev.get("split") != "dev" or holdout.get("split") != "holdout":
        raise RuntimeError("separate frozen DEV and HOLDOUT datasets are required")
    if dev.get("corpusVersion") != manifest.get("corpusVersion") or holdout.get("corpusVersion") != manifest.get("corpusVersion"):
        raise RuntimeError("DEV/HOLDOUT corpusVersion differs from the verified index")

    corpus = CorpusRepository(args.corpus_root, args.manifest, verify_hashes=False).load()
    if corpus.version != manifest["corpusVersion"] or corpus.retriever_name != "Qwen3-Embedding-0.6B":
        raise RuntimeError("loaded corpus does not match the intended Qwen3 five-source manifest")
    retriever = Qwen3EmbeddingRetriever(corpus, str(args.query_encoder), device=args.device, query_max_length=512)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    def make_planner() -> Any:
        return CodexCliBatchPlanner(
            model="gpt-6-luna",
            reasoning_effort="low",
            timeout_seconds=args.planner_timeout_seconds,
            max_queries=1,
            work_dir=args.out_dir / "codex-cli-work",
            audit_dir=args.out_dir / "codex-cli-planner-audit",
            schema_path=args.out_dir / "codex-planner-batch-output.schema.json",
        )

    dev_result = None
    holdout_result = None
    if args.splits in {"dev", "both"}:
        dev_result = _run_split(
            dataset_path=args.dataset_dev, split="dev", out_dir=args.out_dir, corpus=corpus, retriever=retriever,
            planner=make_planner(), manifest_hash=manifest_hash, batch_size=args.batch_size, top_k=args.top_k,
            max_run_seconds=args.max_run_seconds_per_split, resume=args.resume, reasoning_effort="low",
            planner_timeout=args.planner_timeout_seconds,
        )
    if args.splits in {"holdout", "both"}:
        holdout_result = _run_split(
            dataset_path=args.dataset_holdout, split="holdout", out_dir=args.out_dir, corpus=corpus, retriever=retriever,
            planner=make_planner(), manifest_hash=manifest_hash, batch_size=args.batch_size, top_k=args.top_k,
            max_run_seconds=args.max_run_seconds_per_split, resume=args.resume, reasoning_effort="low",
            planner_timeout=args.planner_timeout_seconds,
        )
    print(json.dumps({"status": "complete", "dev": dev_result, "holdout": holdout_result}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
