#!/usr/bin/env python3
"""Create a final HOLDOUT E run with unchanged exact-query rows reused."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def read(path: Path) -> tuple[dict[str, Any], str]:
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), hashlib.sha256(raw).hexdigest()


def write(path: Path, value: Any) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_bytes(raw)
    temp.replace(path)
    return hashlib.sha256(raw).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--final-dataset", required=True, type=Path)
    parser.add_argument("--previous-dataset", required=True, type=Path)
    parser.add_argument("--previous-e-run", required=True, type=Path)
    parser.add_argument("--delta-dataset", required=True, type=Path)
    parser.add_argument("--delta-e-run", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    final, final_hash = read(args.final_dataset)
    previous, previous_hash = read(args.previous_dataset)
    old_run, old_run_hash = read(args.previous_e_run)
    delta, delta_hash = read(args.delta_dataset)
    delta_run, delta_run_hash = read(args.delta_e_run)
    if old_run.get("datasetSha256") != previous_hash or old_run.get("datasetId") != final.get("datasetId"):
        raise ValueError("previous E run binding is invalid")
    if delta_run.get("datasetSha256") != delta_hash or delta_run.get("datasetId") != final.get("datasetId"):
        raise ValueError("delta E run binding is invalid")
    for key in ("corpusVersion", "method", "candidateBudget", "manifestSha256", "model", "runnerSha256"):
        if old_run.get(key) != delta_run.get(key):
            raise ValueError(f"old and delta E configuration differs: {key}")
    old_config = dict(old_run.get("retrieverConfig", {}))
    delta_config = dict(delta_run.get("retrieverConfig", {}))
    old_timeout = old_config.pop("plannerTimeoutSeconds", None)
    delta_timeout = delta_config.pop("plannerTimeoutSeconds", None)
    if old_config != delta_config:
        raise ValueError("old and delta E retrieval/planner behavior config differs")
    if not isinstance(old_timeout, (int, float)) or not isinstance(delta_timeout, (int, float)):
        raise ValueError("planner timeout configuration is missing")
    delta_call_latencies = [float(record.get("latencyMs") or 0) for record in delta_run.get("plannerCallRecords", [])]
    max_delta_call_latency = max(delta_call_latencies, default=0.0)
    if delta_timeout < old_timeout or max_delta_call_latency >= old_timeout * 1000:
        raise ValueError("delta calls did not safely remain within the previous timeout envelope")
    final_questions = {item["questionId"]: item for item in final.get("questions", [])}
    old_questions = {item["questionId"]: item for item in previous.get("questions", [])}
    delta_questions = {item["questionId"]: item for item in delta.get("questions", [])}
    old_rows = {item["questionId"]: item for item in old_run.get("queries", [])}
    new_rows = {item["questionId"]: item for item in delta_run.get("queries", [])}
    if list(final_questions) != list(old_questions) or set(old_rows) != set(final_questions):
        raise ValueError("previous HOLDOUT question order/rows do not cover final cohort")
    changed = {qid for qid in final_questions if final_questions[qid].get("query") != old_questions[qid].get("query")}
    if changed != set(delta_questions) or changed != set(new_rows):
        raise ValueError("delta run must contain exactly all and only changed query IDs")
    unchanged = set(final_questions) - changed
    if any(final_questions[qid].get("query") != old_questions[qid].get("query") for qid in unchanged):
        raise ValueError("attempted to reuse a row with changed query text")

    rows = [new_rows[qid] if qid in changed else old_rows[qid] for qid in final_questions]
    old_records = [
        dict(record, provenance="reused_unchanged_query")
        for record in old_run.get("plannerCallRecords", [])
        if set(record.get("questionIds", [])) and set(record.get("questionIds", [])).issubset(unchanged)
    ]
    delta_records = [dict(record, provenance="rerun_final_query_delta") for record in delta_run.get("plannerCallRecords", [])]
    records = old_records + delta_records
    tokens = sum(int(record.get("codexTokensUsed") or 0) for record in records)
    result = dict(old_run)
    result.update({
        "split": "holdout",
        "datasetSha256": final_hash,
        "queries": rows,
        "plannerCallRecords": records,
        "plannerBatchCount": len(records),
        "totalPlannerCodexTokens": tokens,
        "tokenAllocation": "exact retained batch totals; unchanged-query batch records reused; replaced query batches superseded; no per-question attribution",
        "finalDatasetDeltaProvenance": {
            "finalDatasetSha256": final_hash,
            "previousDatasetSha256": previous_hash,
            "previousRunSha256": old_run_hash,
            "deltaDatasetSha256": delta_hash,
            "deltaRunSha256": delta_run_hash,
            "previousRowsReusedForUnchangedQueryCount": len(unchanged),
            "finalQueryRowsRerunCount": len(changed),
            "supersededOldQueryRows": sorted(changed),
            "reuseRequiresExactQueryTextEquality": True,
            "oldPlannerTimeoutSeconds": old_timeout,
            "deltaPlannerTimeoutSeconds": delta_timeout,
            "maxObservedDeltaPlannerBatchLatencyMs": max_delta_call_latency,
            "timeoutDifferenceDidNotAffectCompletedCalls": max_delta_call_latency < old_timeout * 1000,
        },
        "finishedAt": datetime.now(timezone.utc).isoformat(),
    })
    digest = write(args.out, result)
    print(json.dumps({"status": "complete" if all(row.get("status") == "ok" for row in rows) else "complete_with_failures", "queryCount": len(rows), "reusedRows": len(unchanged), "rerunRows": len(changed), "plannerBatchesRetained": len(records), "plannerTokensRetained": tokens, "outSha256": digest}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
