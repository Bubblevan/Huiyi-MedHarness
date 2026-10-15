#!/usr/bin/env python3
"""Extract auditable retrieval-quality failures from the frozen H2 v12 DEV run."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


METHODS = ("dense", "bm25", "rrf", "rrf-reranker")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load_method_rows(score: dict[str, Any]) -> dict[str, dict[str, dict[str, Any]]]:
    return {
        method: {row["questionId"]: row for row in score["perMethodPerQuestion"][method]}
        for method in METHODS
    }


def build_cases(
    dataset: dict[str, Any],
    packet: dict[str, Any],
    judge: dict[str, Any],
    score: dict[str, Any],
    runs: dict[str, dict[str, Any]],
    limit: int = 18,
) -> list[dict[str, Any]]:
    packet_by_query = {item["query"]: item for item in packet["questions"]}
    judge_by_question = {
        item["questionId"]: item for item in judge.get("judgments", [])
        if isinstance(item.get("questionId"), str)
    }
    method_rows = _load_method_rows(score)
    run_rows = {
        method: {row["questionId"]: row for row in runs[method].get("queries", [])}
        for method in METHODS
    }

    rows: list[dict[str, Any]] = []
    for question in dataset["questions"]:
        question_id = question["questionId"]
        blind = packet_by_query.get(question.get("query"))
        if blind is None:
            continue
        batch = judge_by_question.get(question_id, {})
        labels = {item["candidateId"]: item for item in batch.get("judgments", [])}
        unresolved = set(batch.get("unresolvedCandidateIds", [])) | set(batch.get("reviewRequiredIds", []))
        candidate_by_document = {
            item["documentId"]: item["candidateId"] for item in blind.get("candidatePool", [])
        }
        candidate_by_id = {item["candidateId"]: item for item in blind.get("candidatePool", [])}
        grade_by_document = {
            candidate_by_id[candidate_id]["documentId"]: label["relevanceGrade"]
            for candidate_id, label in labels.items()
            if candidate_id in candidate_by_id and candidate_id not in unresolved
        }
        metrics = {method: method_rows[method].get(question_id, {}) for method in METHODS}
        if not all(item.get("metricEligibility@10") == "eligible" for item in metrics.values()):
            continue

        method_summary: dict[str, Any] = {}
        for method in METHODS:
            run_row = run_rows[method].get(question_id, {})
            results = run_row.get("results", []) if run_row.get("status") == "ok" else []
            relevant_ranks = [
                rank for rank, item in enumerate(results, start=1)
                if grade_by_document.get(item.get("documentId")) == 2
            ]
            top5 = []
            for rank, item in enumerate(results[:5], start=1):
                candidate_id = candidate_by_document.get(item.get("documentId"))
                candidate = candidate_by_id.get(candidate_id, {})
                top5.append({
                    "rank": rank,
                    "documentId": item.get("documentId"),
                    "source": item.get("source", candidate.get("source")),
                    "title": item.get("title", candidate.get("title")),
                    "relevanceGrade": grade_by_document.get(item.get("documentId")),
                })
            method_summary[method] = {
                "ndcgAt10": metrics[method].get("ndcg@10"),
                "mrrAt10": metrics[method].get("mrr@10"),
                "contextPrecisionAt10": metrics[method].get("contextPrecision@10"),
                "contextRecallAt10": metrics[method].get("contextRecall@10"),
                "firstDirectSupportRank": min(relevant_ranks) if relevant_ranks else None,
                "directSupportHitsAt5": sum(grade_by_document.get(item.get("documentId")) == 2 for item in results[:5]),
                "top5": top5,
            }
        direct_support_docs = [
            {
                "documentId": candidate["documentId"],
                "source": candidate.get("source"),
                "title": candidate.get("title"),
                "sourceUri": candidate.get("sourceUri"),
                "judgeExplanation": labels[candidate["candidateId"]].get("explanation"),
            }
            for candidate in blind.get("candidatePool", [])
            if candidate["candidateId"] in labels
            and candidate["candidateId"] not in unresolved
            and labels[candidate["candidateId"]].get("relevanceGrade") == 2
        ]
        rows.append({
            "questionId": question_id,
            "query": question["query"],
            "taskCategory": question.get("taskCategory"),
            "answerability": question.get("answerability"),
            "methods": method_summary,
            "directSupportDocs": direct_support_docs,
        })

    selected: list[tuple[dict[str, Any], str, str, str, bool]] = []
    used: set[str] = set()

    def add_sorted(candidates: list[dict[str, Any]], key_fn, count: int, focus: str, case_type: str, explanation: str, is_error: bool = True) -> None:
        candidates = sorted(candidates, key=key_fn)
        added = 0
        for row in candidates:
            if row["questionId"] in used:
                continue
            selected.append((row, focus, case_type, explanation, is_error))
            used.add(row["questionId"])
            added += 1
            if added >= count:
                break

    bilingual = [row for row in rows if row["taskCategory"] == "bilingual"]
    add_sorted(
        [row for row in bilingual if all(isinstance(row["methods"][m]["ndcgAt10"], (int, float)) for m in ("bm25", "dense"))],
        lambda row: row["methods"]["bm25"]["ndcgAt10"] - row["methods"]["dense"]["ndcgAt10"],
        5, "bm25", "cross_language_sparse_regression",
        "Observed: BM25 nDCG@10 is materially below Dense on this bilingual query. Hypothesis: lexical token overlap fails across the query/source language boundary; no intervention isolated the cause.",
    )
    add_sorted(
        [row for row in rows if row["taskCategory"] not in {"bilingual", "no_answer"}
         and all(isinstance(row["methods"][m]["ndcgAt10"], (int, float)) for m in ("rrf", "dense"))
         and row["methods"]["rrf"]["ndcgAt10"] - row["methods"]["dense"]["ndcgAt10"] <= -0.10],
        lambda row: row["methods"]["rrf"]["ndcgAt10"] - row["methods"]["dense"]["ndcgAt10"],
        4, "rrf", "rank_fusion_regression",
        "Observed: rank fusion lowers nDCG@10 against Dense under the same pooled qrels and result budget. Hypothesis: adding lower-ranked sparse candidates dilutes dense ordering; this run did not isolate fusion parameters.",
    )
    add_sorted(
        [row for row in rows if all(isinstance(row["methods"][m]["ndcgAt10"], (int, float)) for m in ("rrf-reranker", "rrf"))
         and row["methods"]["rrf-reranker"]["ndcgAt10"] - row["methods"]["rrf"]["ndcgAt10"] <= -0.05],
        lambda row: row["methods"]["rrf-reranker"]["ndcgAt10"] - row["methods"]["rrf"]["ndcgAt10"],
        3, "rrf-reranker", "reranker_ordering_regression",
        "Observed: reranking lowers graded nDCG@10 against its RRF candidate order. Hypothesis: cross-encoder pair scoring overweights a topical but less directly supportive passage; reranker score calibration was not separately tested.",
    )
    add_sorted(
        [row for row in rows if row["taskCategory"] not in {"no_answer"}
         and isinstance(row["methods"]["dense"]["ndcgAt10"], (int, float))
         and row["methods"]["dense"]["ndcgAt10"] < 0.60],
        lambda row: row["methods"]["dense"]["ndcgAt10"],
        3, "dense", "dense_ranking_weakness",
        "Observed: Dense nDCG@10 is below 0.60 although judged direct-support documents exist in the pooled candidate set. This shows a ranking weakness; the specific embedding/query interaction remains a hypothesis.",
    )
    add_sorted(
        [row for row in rows if row["taskCategory"] == "no_answer"],
        lambda row: min(
            value for method in METHODS
            if isinstance((value := row["methods"][method]["contextPrecisionAt10"]), (int, float))
        ) if any(isinstance(row["methods"][method]["contextPrecisionAt10"], (int, float)) for method in METHODS) else 1.0,
        3, "dense", "no_answer_retrieval_risk",
        "Observed: a synthetic chart-only question receives general-corpus passages. This is a retrieval-boundary risk, not evidence of a false generated answer; answer generation/abstention was not tested.",
        is_error=False,
    )
    if len(selected) < limit:
        add_sorted(
            [row for row in rows if row["questionId"] not in used],
            lambda row: min(
                value for method in METHODS
                if isinstance((value := row["methods"][method]["ndcgAt10"]), (int, float))
            ) if any(isinstance(row["methods"][method]["ndcgAt10"], (int, float)) for method in METHODS) else 1.0,
            limit - len(selected), "dense", "low_quality_ranking_case",
            "Observed low nDCG@10 for at least one method under complete pooled qrels. Root cause is not isolated by this experiment.",
        )

    split = str(dataset.get("split", "dev")).upper()
    case_prefix = f"H2-{split[:1]}-V12-BC"
    qrels_status = (
        "complete candidate-pool labels for all methods; "
        "questions with unresolved or review-required labels are excluded"
    )
    cases = []
    for index, (row, focus, case_type, root_cause, quality_error) in enumerate(selected[:limit], start=1):
        focused = row["methods"][focus]
        cases.append({
            "caseId": f"{case_prefix}-{index:02d}",
            "questionId": row["questionId"],
            "query": row["query"],
            "taskCategory": row["taskCategory"],
            "answerability": row["answerability"],
            "caseType": case_type,
            "focusMethod": focus,
            "observedQualityRegression": quality_error,
            "qrelsStatus": qrels_status,
            "focusedMethodNdcgAt10": focused["ndcgAt10"],
            "denseNdcgAt10": row["methods"]["dense"]["ndcgAt10"],
            "bm25NdcgAt10": row["methods"]["bm25"]["ndcgAt10"],
            "rrfNdcgAt10": row["methods"]["rrf"]["ndcgAt10"],
            "rerankerNdcgAt10": row["methods"]["rrf-reranker"]["ndcgAt10"],
            "firstDirectSupportRank": focused["firstDirectSupportRank"],
            "directSupportHitsAt5": focused["directSupportHitsAt5"],
            "directSupportDocsInJudgedPool": row["directSupportDocs"],
            "top5ByMethod": row["methods"],
            "rootCauseStatus": "observed_metric_plus_unverified_engineering_hypothesis",
            "rootCauseHypothesis": root_cause,
            "fixStatus": "not tested in this frozen comparison",
            "clinicalAccuracyClaimed": False,
        })
    return cases


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--packet", type=Path, required=True)
    parser.add_argument("--judge-run", type=Path, required=True)
    parser.add_argument("--score", type=Path, required=True)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    dataset = read_json(args.dataset)
    packet = read_json(args.packet)
    judge = read_json(args.judge_run)
    score = read_json(args.score)
    runs = {method: read_json(args.run_dir / f"run-{method}.json") for method in METHODS}
    cases = build_cases(dataset, packet, judge, score, runs)
    inputs = [args.dataset, args.packet, args.judge_run, args.score] + [args.run_dir / f"run-{method}.json" for method in METHODS]
    split = str(dataset.get("split", "dev")).lower()
    result = {
        "schemaVersion": "huiyi-h2-v12-quality-bad-cases/v1",
        "status": f"{split}_engineering_review_no_clinician_validation",
        "split": split,
        "datasetId": dataset.get("datasetId"),
        "corpusVersion": dataset.get("corpusVersion"),
        "judgeModel": judge.get("judgeModel"),
        "candidateLabelCoverage": {
            "judged": judge.get("judgedCount"),
            "candidateCount": judge.get("candidateCount"),
            "coverage": judge.get("coverage"),
            "unresolved": judge.get("unresolvedCount"),
            "reviewRequired": judge.get("reviewRequiredCount"),
        },
        "caseCount": len(cases),
        "observedQualityRegressionCount": sum(item["observedQualityRegression"] for item in cases),
        "humanReview": False,
        "clinicalAccuracyClaimed": False,
        "inputHashes": {str(path): sha256(path) for path in inputs},
        "analysisScriptSha256": sha256(Path(__file__).resolve()),
        "cases": cases,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"caseCount": len(cases), "observedQualityRegressionCount": result["observedQualityRegressionCount"], "out": str(args.out)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
