#!/usr/bin/env python3
"""Score only the frozen HC-MA-002 MedQA dev projection after prediction freeze."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--answer-key", default="/root/gpufree-data/repro/hc-ma-002/medqa-dev-diagnostic/answer-key.json")
    parser.add_argument("--predictions", default="/root/gpufree-data/repro/hc-ma-002/medqa-dev-diagnostic/predictions.jsonl")
    parser.add_argument("--selection", default="artifacts/hc-ma-002/diagnostic-selection.json")
    parser.add_argument("--output", default="artifacts/hc-ma-002/diagnostic-results.json")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    selection_path = Path(args.selection)
    if not selection_path.is_absolute():
        selection_path = repo_root / selection_path
    selection = json.loads(selection_path.read_text(encoding="utf-8"))
    if selection.get("split") != "dev" or selection.get("testLabelsRead") is not False:
        raise SystemExit("HC-MA-002 scoring requires the frozen dev-only selection metadata")

    answer_key_path = Path(args.answer_key).resolve()
    prediction_path = Path(args.predictions).resolve()
    if repo_root == answer_key_path or repo_root in answer_key_path.parents:
        raise SystemExit("the separate answer key must remain outside the Git worktree")
    if repo_root == prediction_path or repo_root in prediction_path.parents:
        raise SystemExit("raw predictions must remain outside the Git worktree")
    prediction_bytes = prediction_path.read_bytes()
    prediction_sha = sha256_bytes(prediction_bytes)
    answer_key = json.loads(answer_key_path.read_text(encoding="utf-8"))
    predictions = [json.loads(line) for line in prediction_bytes.decode("utf-8").splitlines() if line.strip()]

    expected_ids = {entry["id"] for entry in selection["selection"]}
    if set(answer_key) != expected_ids:
        raise SystemExit("answer key does not match the frozen dev case IDs")
    expected_arms = {"single", "adaptive"}
    if len(predictions) != len(expected_ids) * len(expected_arms):
        raise SystemExit("prediction count does not match the frozen cases and arms")
    if any(set(row) - {
        "id", "arm", "caseHash", "sessionId", "turnReason", "choice", "toolCalls", "rootStepCount",
        "childRuns", "failedChildRuns", "specialistRuns", "specialistFindingsCompleted", "moderatorRuns",
        "complexity", "wallLatencyMs", "dshTurnLatencyMs", "memory", "evidence",
    } for row in predictions):
        raise SystemExit("prediction file contains unexpected fields")

    seen: set[tuple[str, str]] = set()
    scored = []
    for row in predictions:
        case_id = row.get("id")
        arm = row.get("arm")
        if case_id not in expected_ids or arm not in expected_arms or (case_id, arm) in seen:
            raise SystemExit("prediction IDs or arm assignments are invalid")
        seen.add((case_id, arm))
        choice = row.get("choice")
        correct = isinstance(choice, str) and choice.upper() == answer_key[case_id]
        scored.append({
            "id": case_id,
            "arm": arm,
            "choice": choice if isinstance(choice, str) and choice in set("ABCDE") else None,
            "correct": correct,
            "turnReason": row.get("turnReason"),
            "complexity": row.get("complexity"),
            "childRuns": row.get("childRuns"),
            "failedChildRuns": row.get("failedChildRuns"),
            "specialistRuns": row.get("specialistRuns"),
            "moderatorRuns": row.get("moderatorRuns"),
            "wallLatencyMs": row.get("wallLatencyMs"),
            "evidence": row.get("evidence"),
        })
    if seen != {(case_id, arm) for case_id in expected_ids for arm in expected_arms}:
        raise SystemExit("prediction file is missing a case/arm pair")

    scores = {}
    for arm in sorted(expected_arms):
        arm_rows = [row for row in scored if row["arm"] == arm]
        correct = sum(row["correct"] for row in arm_rows)
        scores[arm] = {
            "correct": correct,
            "total": len(expected_ids),
            "accuracy": correct / len(expected_ids),
            "parsedChoices": sum(row["choice"] is not None for row in arm_rows),
        }
    metadata = {
        "task": "HC-MA-002",
        "split": "dev",
        "scope": "four-case fixed diagnostic; not a generalization or paper-parity result",
        "sourceDevSha256": selection["source"]["sha256"],
        "predictionSha256": prediction_sha,
        "predictionRows": len(predictions),
        "scores": scores,
        "perCase": sorted(scored, key=lambda row: (row["id"], row["arm"])),
        "testLabelsRead": False,
        "rawQuestionTextStored": False,
        "rawModelResponsesStored": False,
    }
    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = repo_root / output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"split": "dev", "predictionSha256": prediction_sha, "scores": scores}))


if __name__ == "__main__":
    main()
