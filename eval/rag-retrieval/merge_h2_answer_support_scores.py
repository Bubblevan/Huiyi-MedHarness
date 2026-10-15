#!/usr/bin/env python3
"""Join independently packet-bound answer-support arms and compute paired deltas."""

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


def bootstrap_ci(values: list[float], seed: int = 20261016) -> dict[str, Any]:
    if len(values) < 2:
        return {"lower": None, "upper": None, "replicates": 0, "reason": "fewer than two paired questions"}
    rng = random.Random(seed)
    means = sorted(sum(values[rng.randrange(len(values))] for _ in values) / len(values) for _ in range(10000))
    return {"lower": round(means[249], 6), "upper": round(means[9749], 6), "replicates": 10000, "seed": seed}


def ratio(n: int, d: int) -> float | None:
    return round(n / d, 6) if d else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--score", action="append", required=True, help="PATH to a complete per-packet answer-support score; repeat per packet")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    score_docs: list[dict[str, Any]] = []
    score_hashes: list[str] = []
    for raw_path in args.score:
        doc, digest = read(Path(raw_path))
        if doc.get("status") != "complete":
            raise ValueError(f"score file is not complete: {raw_path}")
        score_docs.append(doc)
        score_hashes.append(digest)
    first = score_docs[0]
    for doc in score_docs[1:]:
        for key in ("datasetId", "datasetSha256", "questionSelection", "generatorModel", "judgeModel"):
            if doc.get(key) != first.get(key):
                raise ValueError(f"score packets differ in required shared field {key}")

    per_method: dict[str, dict[str, dict[str, Any]]] = {}
    for doc in score_docs:
        grouped: dict[str, dict[str, Any]] = {}
        for row in doc.get("perTask", []):
            method = row["method"]
            if row["questionId"] in grouped.setdefault(method, {}):
                raise ValueError(f"duplicate method/question row: {method}/{row['questionId']}")
            grouped[method][row["questionId"]] = row
        for method, rows in grouped.items():
            if method in per_method:
                raise ValueError(f"method appears in more than one score packet: {method}")
            per_method[method] = rows
    question_sets = {method: set(rows) for method, rows in per_method.items()}
    if len({frozenset(values) for values in question_sets.values()}) != 1:
        raise ValueError("paired methods do not cover exactly the same question IDs")
    baseline = "Dense" if "Dense" in per_method else "dense" if "dense" in per_method else None
    if baseline is None:
        raise ValueError("Dense baseline arm is required")

    pairwise_dense: dict[str, Any] = {}
    metric_specs = {
        "relevantAnswer": ("answerRelevancy", lambda row: (1.0 if row["answerRelevancy"] == "relevant" else 0.0) if row["answerRelevancy"] else None),
        "fullySupportedClaimRate": ("fullySupportedClaimRate", lambda row: row["fullySupportedClaimRate"]),
        "supportedOrPartialClaimRate": ("supportedOrPartialClaimRate", lambda row: row["supportedOrPartialClaimRate"]),
        "unsupportedClaimPresence": ("hasUnsupportedClaim", lambda row: (1.0 if row["hasUnsupportedClaim"] else 0.0) if row["assessableClaimCount"] else None),
        "citationIdValidity": ("citationIdValidity", lambda row: ratio(row["validCitationReferenceCount"], row["citationReferenceCount"])),
    }
    methods = sorted(per_method)
    def compare(method: str, reference: str) -> dict[str, Any]:
        common = sorted(question_sets[reference] & question_sets[method])
        metrics: dict[str, Any] = {}
        for metric, (_field, value_fn) in metric_specs.items():
            deltas = []
            for qid in common:
                left = value_fn(per_method[reference][qid])
                right = value_fn(per_method[method][qid])
                if left is not None and right is not None:
                    deltas.append(right - left)
            metrics[metric] = {
                "pairedQuestionCount": len(deltas),
                "meanDifference": round(sum(deltas) / len(deltas), 6) if deltas else None,
                "bootstrap95PercentileCI": bootstrap_ci(deltas, seed=20261016 + len(metric)),
            }
        by_answerability: dict[str, Any] = {}
        for answerability in ("answerable", "no_answer"):
            relevant_rows = [qid for qid in common if per_method[reference][qid]["answerability"] == answerability]
            if not relevant_rows:
                continue
            left = [bool(per_method[reference][qid].get("abstained")) for qid in relevant_rows]
            right = [bool(per_method[method][qid].get("abstained")) for qid in relevant_rows]
            deltas = [int(r) - int(l) for l, r in zip(left, right)]
            by_answerability[answerability] = {
                "pairedQuestionCount": len(relevant_rows),
                "referenceAbstentionCount": sum(left),
                "comparisonAbstentionCount": sum(right),
                "abstentionRateDifference": round(sum(deltas) / len(deltas), 6),
                "bootstrap95PercentileCI": bootstrap_ci(deltas, seed=20261017 + len(answerability)),
            }
        return {"pairedQuestionCount": len(common), "metrics": metrics, "abstentionByAnswerability": by_answerability}

    for method in methods:
        if method != baseline:
            pairwise_dense[f"{method}_minus_{baseline}"] = compare(method, baseline)
    reranker = "D" if "D" in per_method else "reranker" if "reranker" in per_method else None
    pairwise_reranker = {
        f"{method}_minus_{reranker}": compare(method, reranker)
        for method in methods
        if reranker and method in {"E", "F", "iterative", "adaptive"}
    }

    out = {
        "schemaVersion": "huiyi-h2-answer-support-paired-score/v1",
        "status": "complete",
        "datasetId": first.get("datasetId"),
        "datasetSha256": first.get("datasetSha256"),
        "questionSelection": first.get("questionSelection"),
        "generatorModel": first.get("generatorModel"),
        "judgeModel": first.get("judgeModel"),
        "externalGoldAgreement": "unavailable; GPT-6-Luna engineering scoring is not human/clinical review",
        "methods": {method: doc["methods"][method] for doc in score_docs for method in doc["methods"]},
        "pairedAgainstDense": pairwise_dense,
        "pairedAgainstReranker": pairwise_reranker,
        "perTask": [row for doc in score_docs for row in doc.get("perTask", [])],
        "tokenCostsByPacket": [
            {
                "scoreSha256": digest,
                "methods": sorted(doc.get("methods", {})),
                "generatorTokens": doc.get("generatorTokens"),
                "judgeTokens": doc.get("judgeTokens"),
            }
            for doc, digest in zip(score_docs, score_hashes)
        ],
        "sourceScoreSha256": score_hashes,
        "limitations": ["Answer relevance and claim support were judged by GPT-6-Luna against snippets, not external gold or clinicians.", "Only structured claims were audited; completeness of all factual propositions in free-form answer text was not independently atomized.", "Citation ID validity confirms local Evidence ID membership, not external URI resolution."],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": out["status"], "methods": {name: value["taskCount"] for name, value in out["methods"].items()}, "pairedAgainstDense": pairwise_dense, "pairedAgainstReranker": pairwise_reranker, "out": str(args.out)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
