#!/usr/bin/env python3
"""Measure exact frozen-source-anchor hits and multi-anchor completeness."""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import random
from pathlib import Path
from typing import Any


def read(path: Path) -> tuple[dict[str, Any], str]:
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), hashlib.sha256(raw).hexdigest()


def ratio(n: int, d: int) -> float | None:
    return round(n / d, 6) if d else None


def bootstrap_ci(values: list[float], seed: int) -> dict[str, Any]:
    if len(values) < 2:
        return {"lower": None, "upper": None, "replicates": 0, "reason": "fewer than two paired questions"}
    rng = random.Random(seed)
    means = sorted(sum(values[rng.randrange(len(values))] for _ in values) / len(values) for _ in range(10000))
    return {
        "lower": round(means[math.floor(0.025 * 9999)], 6),
        "upper": round(means[math.ceil(0.975 * 9999)], 6),
        "replicates": 10000,
        "seed": seed,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--anchors", type=Path, required=True)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--run", action="append", required=True, help="METHOD=PATH")
    parser.add_argument("--ks", default="5,10")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    dataset, dataset_hash = read(args.dataset)
    anchors, anchors_hash = read(args.anchors)
    selection, selection_hash = read(args.selection)
    if dataset.get("split") != "holdout" or anchors.get("datasetId") != dataset.get("datasetId"):
        raise ValueError("dataset/anchor manifest must match the frozen HOLDOUT")
    if selection.get("datasetSha256") != dataset_hash:
        raise ValueError("answer-support selection is not bound to this HOLDOUT file")
    selected = set(selection.get("selectedQuestionIds", []))
    dataset_by_id = {item["questionId"]: item for item in dataset.get("questions", [])}
    anchor_by_id = {item["questionId"]: item for item in anchors.get("questions", [])}
    selected_answerable = {
        qid for qid in selected
        if qid in dataset_by_id and dataset_by_id[qid].get("answerability") == "answerable"
    }
    if not selected or not selected <= dataset_by_id.keys() or not selected_answerable <= anchor_by_id.keys():
        raise ValueError("answerable selection question IDs do not match dataset/anchor manifest")
    ks = sorted({int(x) for x in args.ks.split(",") if x.strip()})
    if not ks or any(k < 1 for k in ks):
        parser.error("--ks must contain positive integers")

    runs: dict[str, dict[str, Any]] = {}
    run_hashes: dict[str, str] = {}
    for spec in args.run:
        method, separator, raw_path = spec.partition("=")
        if not separator or not method or not raw_path or method in runs:
            parser.error("--run must be unique METHOD=PATH")
        run, digest = read(Path(raw_path))
        if run.get("datasetId") != dataset.get("datasetId") or run.get("datasetSha256") != dataset_hash:
            raise ValueError(f"{method} run is not bound to the frozen HOLDOUT")
        runs[method] = {row["questionId"]: row for row in run.get("queries", [])}
        if set(runs[method]) != set(dataset_by_id):
            raise ValueError(f"{method} run does not cover exactly the HOLDOUT")
        run_hashes[method] = digest

    by_method: dict[str, Any] = {}
    per_question: list[dict[str, Any]] = []
    for method, run_rows in runs.items():
        by_k: dict[str, Any] = {}
        for k in ks:
            total_elements = hit_elements = complete_questions = eligible_questions = 0
            multi_elements = multi_hits = multi_complete = multi_questions = 0
            category_counts: dict[str, dict[str, int]] = {}
            for qid in sorted(selected_answerable):
                question = dataset_by_id[qid]
                anchor_question = anchor_by_id[qid]
                gold = [item["anchorId"] for item in anchor_question.get("anchors", [])]
                if not gold:
                    continue
                row = run_rows[qid]
                retrieved = {item.get("documentId") for item in (row.get("results", [])[:k] if row.get("status") == "ok" else [])}
                hits = [document_id for document_id in gold if document_id in retrieved]
                category = question.get("taskCategory", "unknown")
                bucket = category_counts.setdefault(category, {"questionCount": 0, "anchorElementCount": 0, "anchorElementHits": 0, "allAnchorsHitQuestionCount": 0})
                bucket["questionCount"] += 1
                bucket["anchorElementCount"] += len(gold)
                bucket["anchorElementHits"] += len(hits)
                bucket["allAnchorsHitQuestionCount"] += int(len(hits) == len(gold))
                eligible_questions += 1
                total_elements += len(gold)
                hit_elements += len(hits)
                complete_questions += int(len(hits) == len(gold))
                if category == "multi_hop":
                    multi_questions += 1
                    multi_elements += len(gold)
                    multi_hits += len(hits)
                    multi_complete += int(len(hits) == len(gold))
                per_question.append({"questionId": qid, "method": method, "taskCategory": category, "anchorCount": len(gold), f"anchorHits@{k}": len(hits), f"anchorFraction@{k}": len(hits) / len(gold), f"allAnchorsHit@{k}": len(hits) == len(gold), f"hitAnchorIds@{k}": hits})
            by_k[str(k)] = {
                "answerableQuestionCount": eligible_questions,
                "anchorElementHitCount": hit_elements,
                "anchorElementCount": total_elements,
                "exactAnchorElementCoverage": ratio(hit_elements, total_elements),
                "allAnchorQuestionCount": complete_questions,
                "allAnchorQuestionRate": ratio(complete_questions, eligible_questions),
                "multiHopQuestionCount": multi_questions,
                "multiHopAnchorHitCount": multi_hits,
                "multiHopAnchorElementCount": multi_elements,
                "multiHopElementCoverage": ratio(multi_hits, multi_elements),
                "multiHopAllAnchorsHitCount": multi_complete,
                "multiHopAllAnchorsHitRate": ratio(multi_complete, multi_questions),
                "byCategory": {
                    category: {
                        **counts,
                        "anchorElementCoverage": ratio(counts["anchorElementHits"], counts["anchorElementCount"]),
                        "allAnchorQuestionRate": ratio(counts["allAnchorsHitQuestionCount"], counts["questionCount"]),
                    }
                    for category, counts in category_counts.items()
                },
                "metricDefinition": "strict exact documentId match against frozen source anchor; adjacent or semantically equivalent chunks are not credited",
            }
        by_method[method] = {"byK": by_k}

    paired: dict[str, Any] = {}
    method_names = sorted(runs)
    for k in ks:
        indexed = {
            method: {row["questionId"]: row for row in per_question if row["method"] == method and f"anchorFraction@{k}" in row}
            for method in method_names
        }
        for left, right in itertools.combinations(method_names, 2):
            common = sorted(set(indexed[left]) & set(indexed[right]))
            for cohort, selected_qids in (("all_answerable", common), ("multi_hop", [qid for qid in common if indexed[left][qid]["taskCategory"] == "multi_hop"])):
                fraction_diffs = [indexed[right][qid][f"anchorFraction@{k}"] - indexed[left][qid][f"anchorFraction@{k}"] for qid in selected_qids]
                complete_diffs = [int(indexed[right][qid][f"allAnchorsHit@{k}"]) - int(indexed[left][qid][f"allAnchorsHit@{k}"]) for qid in selected_qids]
                key = f"{right}_minus_{left}|{cohort}|anchor@{k}"
                paired[key] = {
                    "pairedQuestionCount": len(selected_qids),
                    "meanQuestionMacroAnchorFractionDifference": round(sum(fraction_diffs) / len(fraction_diffs), 6) if fraction_diffs else None,
                    "anchorFractionBootstrap95PercentileCI": bootstrap_ci(fraction_diffs, 20261016 + k),
                    "meanAllAnchorsHitRateDifference": round(sum(complete_diffs) / len(complete_diffs), 6) if complete_diffs else None,
                    "allAnchorsHitBootstrap95PercentileCI": bootstrap_ci(complete_diffs, 20261116 + k),
                }

    result = {
        "schemaVersion": "huiyi-h2-source-anchor-coverage/v1",
        "status": "scored",
        "datasetId": dataset.get("datasetId"),
        "datasetSha256": dataset_hash,
        "anchorManifestSha256": anchors_hash,
        "selectionSha256": selection_hash,
        "selectedQuestionCount": len(selected),
        "selectedAnswerableQuestionCount": len(selected_answerable),
        "methods": by_method,
        "pairedComparisons": paired,
        "perQuestion": per_question,
        "inputRunSha256": run_hashes,
        "limitations": ["Exact anchor-document hit is intentionally strict and may miss adjacent chunks containing equivalent evidence.", "Source-anchor coverage does not establish full-corpus recall or clinical correctness."],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "selectedQuestionCount": len(selected), "methods": {m: {k: {"exactAnchorElementCoverage": v["exactAnchorElementCoverage"], "multiHopAllAnchorsHitRate": v["multiHopAllAnchorsHitRate"]} for k, v in d["byK"].items()} for m, d in by_method.items()}, "out": str(args.out)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
