#!/usr/bin/env python3
"""Score frozen medical retrieval runs against reviewed pooled qrels."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any


REVIEWED_STATES = {"double_reviewed", "adjudicated"}
RELEVANT_GRADE = 2
LANGUAGES = {"zh", "en", "mixed"}
TASK_CATEGORIES = {"exact_term", "semantic", "multi_hop", "bilingual", "source_conflict", "no_answer"}
APPLICABILITY = {"applicable", "partly_applicable", "not_applicable", "conflicting", "not_assessed"}


def _read_json(path: Path) -> tuple[dict[str, Any], str]:
    raw = path.read_bytes()
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value, hashlib.sha256(raw).hexdigest()


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def validate_dataset(dataset: dict[str, Any]) -> dict[str, dict[str, Any]]:
    _require(dataset.get("schemaVersion") == "huiyi-rag-retrieval-dataset/v1", "unsupported dataset schemaVersion")
    _require(dataset.get("split") in {"dev", "holdout"}, "dataset split must be dev or holdout")
    questions = dataset.get("questions")
    _require(isinstance(questions, list) and bool(questions), "dataset questions must be a non-empty array")
    by_id: dict[str, dict[str, Any]] = {}
    for question in questions:
        _require(isinstance(question, dict), "each question must be an object")
        question_id = question.get("questionId")
        _require(isinstance(question_id, str) and bool(question_id), "questionId must be a non-empty string")
        _require(question_id not in by_id, f"duplicate questionId: {question_id}")
        _require(isinstance(question.get("query"), str) and bool(question["query"].strip()), f"{question_id}: query is empty")
        _require(question.get("corpusVersion", dataset.get("corpusVersion")) == dataset.get("corpusVersion"), f"{question_id}: corpusVersion mismatch")
        _require(question.get("language") in LANGUAGES, f"{question_id}: language is invalid")
        _require(question.get("taskCategory") in TASK_CATEGORIES, f"{question_id}: taskCategory is invalid")
        _require(question.get("reviewStatus") in REVIEWED_STATES, f"{question_id}: qrels are not double-reviewed/adjudicated")
        _require(question.get("answerability") in {"answerable", "no_answer"}, f"{question_id}: answerability is pending")
        annotations = question.get("annotations")
        _require(isinstance(annotations, list), f"{question_id}: annotations must be an array")
        _require(all(isinstance(item, dict) for item in annotations), f"{question_id}: each annotation must be an object")
        reviewer_ids = [item.get("reviewerId") for item in annotations]
        _require(all(isinstance(item, str) and bool(item.strip()) for item in reviewer_ids), f"{question_id}: reviewerId must be non-empty")
        _require(len(reviewer_ids) == len(set(reviewer_ids)), f"{question_id}: duplicate reviewerId; one annotation per reviewer is required")
        _require(len(set(reviewer_ids)) >= 2, f"{question_id}: at least two independent reviewers are required")
        _require(all(item.get("answerability") in {"answerable", "no_answer"} for item in annotations), f"{question_id}: reviewer answerability is missing")
        annotation_judgments: dict[str, dict[str, dict[str, Any]]] = {}
        for annotation in annotations:
            judgments = annotation.get("judgments")
            _require(isinstance(judgments, list), f"{question_id}: reviewer judgments must be an array")
            by_document: dict[str, dict[str, Any]] = {}
            for judgment in judgments:
                _require(isinstance(judgment, dict), f"{question_id}: malformed reviewer judgment")
                document_id = judgment.get("documentId")
                _require(isinstance(document_id, str) and bool(document_id), f"{question_id}: reviewer judgment documentId is missing")
                _require(_grade(judgment) >= 0, f"{question_id}: reviewer relevance must be an integer from 0 to 3")
                _require(judgment.get("applicability") in APPLICABILITY, f"{question_id}: reviewer applicability is invalid")
                _require(document_id not in by_document, f"{question_id}: reviewer has duplicate judgments for {document_id}")
                by_document[document_id] = judgment
            annotation_judgments[annotation["reviewerId"]] = by_document
        if question["reviewStatus"] == "double_reviewed":
            reviewer_answerability = {item["answerability"] for item in annotations}
            _require(reviewer_answerability == {question["answerability"]}, f"{question_id}: disagreement must be adjudicated before scoring")
        elif len({item["answerability"] for item in annotations}) > 1:
            note = question.get("answerabilityAdjudicationNote")
            _require(isinstance(note, str) and bool(note.strip()), f"{question_id}: answerability disagreement needs an adjudication note")
        qrels = question.get("qrels")
        _require(isinstance(qrels, list), f"{question_id}: qrels must be an array")
        qrels_by_document: dict[str, dict[str, Any]] = {}
        for item in qrels:
            _require(isinstance(item, dict) and isinstance(item.get("documentId"), str) and bool(item["documentId"]), f"{question_id}: malformed qrel documentId")
            _require(_grade(item) >= 0, f"{question_id}: qrel relevance must be an integer from 0 to 3")
            _require(item.get("applicability") in APPLICABILITY, f"{question_id}: qrel applicability is invalid")
            _require(item["documentId"] not in qrels_by_document, f"{question_id}: duplicate qrel documentId")
            if "adjudicationNote" in item:
                _require(isinstance(item["adjudicationNote"], str) and bool(item["adjudicationNote"].strip()), f"{question_id}: adjudicationNote must be non-empty")
            qrels_by_document[item["documentId"]] = item
        candidate_pool = question.get("candidatePool")
        if candidate_pool is not None:
            _require(isinstance(candidate_pool, list), f"{question_id}: candidatePool must be an array")
            _require(all(isinstance(item, dict) and isinstance(item.get("documentId"), str) and bool(item["documentId"]) for item in candidate_pool), f"{question_id}: candidatePool contains a malformed document ID")
            candidate_id_list = [item["documentId"] for item in candidate_pool]
            candidate_ids = set(candidate_id_list)
            _require(len(candidate_ids) == len(candidate_pool), f"{question_id}: candidatePool contains duplicate document IDs")
            _require(set(qrels_by_document) == candidate_ids, f"{question_id}: final qrels must cover the complete frozen candidatePool")
            _require(all(set(judgments) == candidate_ids for judgments in annotation_judgments.values()), f"{question_id}: each reviewer must judge every candidate exactly once")
            for item in candidate_pool:
                document_id = item["documentId"]
                votes = [judgments[document_id] for judgments in annotation_judgments.values()]
                vote_signatures = {(_grade(vote), vote["applicability"]) for vote in votes}
                final_qrel = qrels_by_document[document_id]
                final_signature = (_grade(final_qrel), final_qrel["applicability"])
                if question["reviewStatus"] == "double_reviewed":
                    _require(len(vote_signatures) == 1, f"{question_id}: candidate {document_id} disagreement must be adjudicated")
                    _require(final_signature in vote_signatures, f"{question_id}: final qrel differs from independent consensus for {document_id}")
                elif len(vote_signatures) > 1:
                    note = final_qrel.get("adjudicationNote")
                    _require(isinstance(note, str) and bool(note.strip()), f"{question_id}: candidate {document_id} disagreement needs an adjudication note")
                else:
                    _require(final_signature in vote_signatures, f"{question_id}: final qrel differs from reviewer consensus for {document_id}")
        if question["answerability"] == "answerable":
            _require(any(_grade(item) >= RELEVANT_GRADE for item in qrels), f"{question_id}: answerable query has no relevant qrel (grade >= {RELEVANT_GRADE})")
        else:
            _require(not any(_grade(item) >= RELEVANT_GRADE for item in qrels), f"{question_id}: no_answer query has a relevant qrel")
        by_id[question_id] = question
    return by_id


def _grade(item: Any) -> int:
    if not isinstance(item, dict):
        return -1
    value = item.get("relevance")
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 3 else -1


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return round(ordered[index], 3)


def combine_serial_stage_latency_ms(*stage_latencies_ms: float) -> float:
    """Return a rounded request latency for sequential, already-warm stages."""
    if not stage_latencies_ms:
        raise ValueError("at least one latency stage is required")
    if any(
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
        for value in stage_latencies_ms
    ):
        raise ValueError("latency stages must be finite, non-negative numbers")
    return round(sum(float(value) for value in stage_latencies_ms), 1)


def weighted_cohen_kappa(left: list[int], right: list[int], categories: int = 4) -> float | None:
    """Quadratic-weighted Cohen kappa for ordinal labels; None when undefined."""
    if len(left) != len(right) or not left:
        return None
    if any(not 0 <= value < categories for value in left + right):
        raise ValueError("agreement labels fall outside configured ordinal categories")
    observed_disagreement = sum(((a - b) / (categories - 1)) ** 2 for a, b in zip(left, right)) / len(left)
    left_counts = Counter(left)
    right_counts = Counter(right)
    expected_disagreement = 0.0
    for a in range(categories):
        for b in range(categories):
            expected_disagreement += (left_counts[a] / len(left)) * (right_counts[b] / len(right)) * ((a - b) / (categories - 1)) ** 2
    if expected_disagreement == 0:
        return 1.0 if observed_disagreement == 0 else None
    return round(1 - observed_disagreement / expected_disagreement, 6)


def agreement_summary(questions: dict[str, dict[str, Any]]) -> dict[str, Any]:
    pairs: dict[tuple[str, str], list[tuple[int, int, str, str]]] = {}
    answerability_pairs: dict[tuple[str, str], list[tuple[str, str]]] = {}
    for question_id, question in questions.items():
        annotations = question.get("annotations", [])
        if not isinstance(annotations, list):
            continue
        reviewer_map: dict[str, dict[str, dict[str, Any]]] = {}
        answerability_map: dict[str, str] = {}
        for annotation in annotations:
            if not isinstance(annotation, dict) or not isinstance(annotation.get("reviewerId"), str):
                continue
            reviewer_id = annotation["reviewerId"]
            if annotation.get("answerability") in {"answerable", "no_answer"}:
                answerability_map[reviewer_id] = annotation["answerability"]
            judgments = annotation.get("judgments", [])
            reviewer_map[reviewer_id] = {
                item["documentId"]: item
                for item in judgments
                if isinstance(item, dict) and isinstance(item.get("documentId"), str)
            }
        reviewers = sorted(reviewer_map)
        for i, reviewer_a in enumerate(reviewers):
            for reviewer_b in reviewers[i + 1 :]:
                common = sorted(set(reviewer_map[reviewer_a]) & set(reviewer_map[reviewer_b]))
                pair = pairs.setdefault((reviewer_a, reviewer_b), [])
                if reviewer_a in answerability_map and reviewer_b in answerability_map:
                    answerability_pairs.setdefault((reviewer_a, reviewer_b), []).append((answerability_map[reviewer_a], answerability_map[reviewer_b]))
                for document_id in common:
                    a = reviewer_map[reviewer_a][document_id]
                    b = reviewer_map[reviewer_b][document_id]
                    if _grade(a) >= 0 and _grade(b) >= 0:
                        pair.append((_grade(a), _grade(b), str(a.get("applicability", "")), str(b.get("applicability", ""))))
    output = []
    for (reviewer_a, reviewer_b), items in sorted(pairs.items()):
        output.append({
            "reviewerA": reviewer_a,
            "reviewerB": reviewer_b,
            "sharedJudgments": len(items),
            "relevanceQuadraticWeightedCohenKappa": weighted_cohen_kappa([x[0] for x in items], [x[1] for x in items]),
            "applicabilityExactAgreement": round(sum(x[2] == x[3] for x in items) / len(items), 6) if items else None,
            "answerabilityJudgments": len(answerability_pairs.get((reviewer_a, reviewer_b), [])),
            "answerabilityExactAgreement": (
                round(sum(x[0] == x[1] for x in answerability_pairs[(reviewer_a, reviewer_b)]) / len(answerability_pairs[(reviewer_a, reviewer_b)]), 6)
                if answerability_pairs.get((reviewer_a, reviewer_b)) else None
            ),
        })
    return {"reviewerPairs": output, "sharedJudgmentCount": sum(row["sharedJudgments"] for row in output)}


def score_run(
    dataset: dict[str, Any],
    run: dict[str, Any],
    dataset_sha256: str,
    run_sha256: str,
    ks: list[int],
) -> dict[str, Any]:
    questions = validate_dataset(dataset)
    _require(run.get("schemaVersion") == "huiyi-rag-retrieval-run/v1", "unsupported run schemaVersion")
    _require(run.get("corpusVersion") == dataset.get("corpusVersion"), "run and dataset corpusVersion differ")
    _require(run.get("datasetId") == dataset.get("datasetId"), "run and datasetId differ")
    run_queries = run.get("queries")
    _require(isinstance(run_queries, list), "run queries must be an array")
    budget = run.get("candidateBudget")
    _require(isinstance(budget, int) and not isinstance(budget, bool) and budget >= 1, "run candidateBudget must be a positive integer")
    observed: dict[str, dict[str, Any]] = {}
    for row in run_queries:
        _require(isinstance(row, dict) and isinstance(row.get("questionId"), str), "run query row missing questionId")
        _require(row["questionId"] not in observed, f"duplicate run questionId: {row['questionId']}")
        observed[row["questionId"]] = row
    extra = sorted(set(observed) - set(questions))
    _require(not extra, f"run contains question IDs absent from dataset: {extra[:5]}")

    per_query: list[dict[str, Any]] = []
    method = run.get("method", "unspecified")
    for question_id, question in questions.items():
        row = observed.get(question_id, {"questionId": question_id, "status": "missing", "results": [], "latencyMs": None})
        results = row.get("results", []) if row.get("status", "ok") == "ok" and isinstance(row.get("results", []), list) else []
        unique_results: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in results:
            if not isinstance(item, dict) or not isinstance(item.get("documentId"), str):
                continue
            if item["documentId"] in seen:
                continue
            seen.add(item["documentId"])
            unique_results.append(item)
        _require(len(unique_results) <= budget, f"{question_id}: unique result count exceeds frozen candidateBudget")
        qrels = {item["documentId"]: _grade(item) for item in question["qrels"] if isinstance(item, dict) and _grade(item) >= 0}
        relevant = {doc_id for doc_id, grade in qrels.items() if grade >= RELEVANT_GRADE}
        row_metrics: dict[str, Any] = {
            "questionId": question_id,
            "taskCategory": question.get("taskCategory"),
            "language": question.get("language"),
            "answerability": question["answerability"],
            "status": row.get("status", "ok"),
            "missingRunRecord": question_id not in observed,
            "abstained": bool(row.get("abstained", False)),
            "retrievedCount": len(unique_results),
            "latencyMs": row.get("latencyMs"),
            "plannerCalls": row.get("plannerCalls", 0),
            "plannerInputTokens": row.get("plannerInputTokens", 0),
            "plannerOutputTokens": row.get("plannerOutputTokens", 0),
        }
        for k in ks:
            top = unique_results[:k]
            retrieved_ids = {item["documentId"] for item in top}
            dcg = sum((2 ** qrels.get(item["documentId"], 0) - 1) / math.log2(rank + 1) for rank, item in enumerate(top, start=1))
            ideal = sorted(qrels.values(), reverse=True)[:k]
            idcg = sum((2 ** grade - 1) / math.log2(rank + 1) for rank, grade in enumerate(ideal, start=1))
            first_rank = next((rank for rank, item in enumerate(top, start=1) if item["documentId"] in relevant), None)
            row_metrics[f"recall@{k}"] = round(len(retrieved_ids & relevant) / len(relevant), 6) if relevant else None
            row_metrics[f"mrr@{k}"] = round(1 / first_rank, 6) if first_rank else 0.0
            row_metrics[f"ndcg@{k}"] = round(dcg / idcg, 6) if idcg else None
            row_metrics[f"precision@{k}"] = round(len(retrieved_ids & relevant) / k, 6) if relevant else None
        row_metrics["topSourceCounts"] = dict(Counter(str(item.get("source", "unknown")) for item in unique_results[: max(ks)]))
        per_query.append(row_metrics)

    answerable = [row for row in per_query if row["answerability"] == "answerable"]
    no_answer = [row for row in per_query if row["answerability"] == "no_answer"]
    successful = [row for row in per_query if row["status"] == "ok" and not row["missingRunRecord"]]
    latency = [float(row["latencyMs"]) for row in successful if isinstance(row["latencyMs"], (int, float))]
    source_counts = Counter()
    for row in per_query:
        source_counts.update(row["topSourceCounts"])

    def macro(rows: list[dict[str, Any]], metric: str) -> float | None:
        values = [row[metric] for row in rows if isinstance(row.get(metric), (int, float))]
        return round(sum(values) / len(values), 6) if values else None

    k_summary = {}
    for k in ks:
        k_summary[str(k)] = {
            "recall": macro(answerable, f"recall@{k}"),
            "mrr": macro(answerable, f"mrr@{k}"),
            "ndcg": macro(answerable, f"ndcg@{k}"),
            "precision": macro(answerable, f"precision@{k}"),
        }
    no_answer_returned_any = sum(1 for row in no_answer if row["retrievedCount"] > 0)
    answerable_false_abstains = sum(1 for row in answerable if row["abstained"])
    expected_ids = set(questions)
    status_counts = dict(Counter(str(row["status"]) for row in per_query))
    return {
        "schemaVersion": "huiyi-rag-retrieval-score/v1",
        "datasetId": dataset.get("datasetId"),
        "split": dataset.get("split"),
        "corpusVersion": dataset.get("corpusVersion"),
        "method": method,
        "candidateBudget": run.get("candidateBudget"),
        "decisionThreshold": run.get("decisionThreshold"),
        "questionCount": len(questions),
        "runRecordCount": len(observed),
        "missingRunRecordCount": len(expected_ids - set(observed)),
        "executionStatusCounts": status_counts,
        "executionSuccessRate": round(sum(row["status"] == "ok" and not row["missingRunRecord"] for row in per_query) / len(per_query), 6) if per_query else None,
        "answerableQuestionCount": len(answerable),
        "noAnswerQuestionCount": len(no_answer),
        "metricsByK": k_summary,
        "noAnswer": {
            "queriesReturningAnyCandidate": no_answer_returned_any,
            "falsePositiveAnyCandidateRate": round(no_answer_returned_any / len(no_answer), 6) if no_answer else None,
            "reportedAbstentions": sum(1 for row in no_answer if row["abstained"]),
            "answerableQueriesIncorrectlyAbstained": answerable_false_abstains,
            "note": "Candidate presence is not a clinical answerability decision; abstention results are descriptive until a dev-only threshold is frozen.",
        },
        "latencyMs": {"p50": _percentile(latency, 0.50), "p95": _percentile(latency, 0.95), "successfulQueries": len(latency)},
        "planner": {
            "calls": sum(int(row.get("plannerCalls") or 0) for row in per_query),
            "inputTokens": sum(int(row.get("plannerInputTokens") or 0) for row in per_query),
            "outputTokens": sum(int(row.get("plannerOutputTokens") or 0) for row in per_query),
        },
        "topSourceCounts": dict(source_counts),
        "annotatorAgreement": agreement_summary(questions),
        "perQuery": per_query,
        "inputSha256": {"dataset": dataset_sha256, "run": run_sha256},
        "scoring": {"relevantGradeThreshold": RELEVANT_GRADE, "ndcgGain": "2^relevance-1", "aggregation": "macro over answerable queries", "unjudgedDocuments": "treated as relevance 0; qrels are pooled and not exhaustive corpus judgments"},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, type=Path, help="reviewed qrels dataset JSON")
    parser.add_argument("--run", required=True, type=Path, help="retrieval run JSON")
    parser.add_argument("--out", required=True, type=Path, help="score report JSON")
    parser.add_argument("--ks", default="5,10,20", help="comma-separated cutoffs")
    args = parser.parse_args()
    ks = sorted({int(value) for value in args.ks.split(",") if value.strip()})
    if not ks or any(value < 1 for value in ks):
        parser.error("--ks must contain positive integers")
    dataset, dataset_hash = _read_json(args.dataset)
    run, run_hash = _read_json(args.run)
    result = score_run(dataset, run, dataset_hash, run_hash, ks)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: result[k] for k in ["datasetId", "method", "questionCount", "missingRunRecordCount", "metricsByK", "latencyMs", "noAnswer"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
