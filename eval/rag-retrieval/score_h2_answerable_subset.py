#!/usr/bin/env python3
"""Summarize answerable-only retrieval metrics to separate correct abstention from ranking loss."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from pathlib import Path
from typing import Any


def read(path: Path) -> tuple[dict[str, Any], str]:
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), hashlib.sha256(raw).hexdigest()


def bootstrap(values: list[float], seed: int) -> dict[str, Any]:
    if len(values) < 2:
        return {"lower": None, "upper": None, "replicates": 0}
    rng = random.Random(seed)
    samples = sorted(sum(values[rng.randrange(len(values))] for _ in values) / len(values) for _ in range(10000))
    return {"lower": round(samples[249], 6), "upper": round(samples[9749], 6), "replicates": 10000, "seed": seed}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--score", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    dataset, dataset_hash = read(args.dataset)
    score, score_hash = read(args.score)
    if score.get("datasetId") != dataset.get("datasetId"):
        raise ValueError("dataset IDs differ")
    answerable = {q["questionId"] for q in dataset.get("questions", []) if q.get("answerability") == "answerable"}
    rows = score.get("perMethodPerQuestion", {})
    methods: dict[str, dict[str, dict[str, Any]]] = {}
    summary: dict[str, Any] = {}
    for method, records in rows.items():
        by_qid = {row["questionId"]: row for row in records}
        selected = {qid: by_qid[qid] for qid in answerable if qid in by_qid and by_qid[qid].get("metricEligibility@10") == "eligible" and isinstance(by_qid[qid].get("ndcg@10"), (int, float))}
        methods[method] = selected
        summary[method] = {
            "answerableQuestionCount": len(selected),
            "ndcgAt10": round(sum(row["ndcg@10"] for row in selected.values()) / len(selected), 6) if selected else None,
            "mrrAt10": round(sum(row["mrr@10"] for row in selected.values()) / len(selected), 6) if selected else None,
            "metricMeaning": "macro average on answerable, qrel-eligible questions only; no-answer tasks excluded",
        }
    paired: dict[str, Any] = {}
    for reference in sorted(methods):
        for comparison in sorted(methods):
            if reference == comparison:
                continue
            common = sorted(set(methods[reference]) & set(methods[comparison]))
            delta = [methods[comparison][qid]["ndcg@10"] - methods[reference][qid]["ndcg@10"] for qid in common]
            paired[f"{comparison}_minus_{reference}"] = {
                "pairedQuestionCount": len(delta),
                "ndcgAt10MeanDifference": round(sum(delta) / len(delta), 6) if delta else None,
                "bootstrap95PercentileCI": bootstrap(delta, 20261016),
            }
    result = {
        "schemaVersion": "huiyi-h2-answerable-only-score/v1",
        "status": "scored",
        "datasetId": dataset.get("datasetId"),
        "datasetSha256": dataset_hash,
        "sourceScoreSha256": score_hash,
        "answerableCohortQuestionCount": len(answerable),
        "methods": summary,
        "pairedComparisons": paired,
        "interpretation": "Diagnostic ranking view only. Overall policy assessment also reports no-answer abstention correctness separately; this does not replace the primary all-task pooled-qrels score.",
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"answerableQuestionCount": len(answerable), "methods": summary, "pairedComparisons": paired, "out": str(args.out)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
