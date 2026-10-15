#!/usr/bin/env python3
"""Prepare an exact-query delta E rerun after final HOLDOUT query refresh."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def read(path: Path) -> tuple[dict[str, Any], str]:
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), hashlib.sha256(raw).hexdigest()


def write(path: Path, value: Any) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    path.write_bytes(raw)
    return hashlib.sha256(raw).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--final-dataset", required=True, type=Path)
    parser.add_argument("--previous-dataset", required=True, type=Path)
    parser.add_argument("--previous-e-run", required=True, type=Path)
    parser.add_argument("--out-dataset", required=True, type=Path)
    parser.add_argument("--audit-out", required=True, type=Path)
    args = parser.parse_args()

    final, final_hash = read(args.final_dataset)
    previous, previous_hash = read(args.previous_dataset)
    previous_run, previous_run_hash = read(args.previous_e_run)
    if final.get("datasetId") != previous.get("datasetId") or final.get("split") != "holdout":
        raise ValueError("datasets must be the same frozen HOLDOUT cohort")
    if previous_run.get("datasetSha256") != previous_hash or previous_run.get("datasetId") != previous.get("datasetId"):
        raise ValueError("previous E run is not bound to the supplied previous dataset")
    final_questions = {item["questionId"]: item for item in final.get("questions", [])}
    previous_questions = {item["questionId"]: item for item in previous.get("questions", [])}
    if list(final_questions) != list(previous_questions):
        raise ValueError("question IDs/order changed; this delta helper only supports query-text refreshes")
    changed = [qid for qid in final_questions if final_questions[qid].get("query") != previous_questions[qid].get("query")]
    if len(changed) != 40:
        raise ValueError(f"expected the recorded 40 no-answer query refreshes; found {len(changed)}")
    if set(row["questionId"] for row in previous_run.get("queries", [])) != set(final_questions):
        raise ValueError("previous E run question set is incomplete")
    if any(final_questions[qid].get("taskCategory") != "no_answer" for qid in changed):
        raise ValueError("query refresh includes a non-no-answer question")
    subset = {**final, "questions": [final_questions[qid] for qid in changed]}
    subset_hash = write(args.out_dataset, subset)
    write(args.audit_out, {
        "schemaVersion": "h2-e-final-delta/v1",
        "status": "ready_for_final_holdout_delta_rerun",
        "finalDatasetSha256": final_hash,
        "previousDatasetSha256": previous_hash,
        "previousERunSha256": previous_run_hash,
        "deltaDatasetSha256": subset_hash,
        "cohortQuestionCount": len(final_questions),
        "unchangedQueryCount": len(final_questions) - len(changed),
        "changedQueryCount": len(changed),
        "changedQuestionIds": changed,
        "reuseRule": "previous E row reused only when exact query text is unchanged; all refreshed query rows must be rerun",
    })
    print(json.dumps({"status": "ready", "finalDatasetSha256": final_hash, "previousDatasetSha256": previous_hash, "unchanged": len(final_questions) - len(changed), "changed": len(changed), "deltaDatasetSha256": subset_hash}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
