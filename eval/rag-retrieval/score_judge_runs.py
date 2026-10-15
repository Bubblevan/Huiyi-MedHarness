#!/usr/bin/env python3
"""Score LLM-judged retrieval runs with explicitly pooled-qrels semantics."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from pathlib import Path
from typing import Any


def _read(path: Path) -> tuple[Any, str]:
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), hashlib.sha256(raw).hexdigest()


def _metrics(results: list[dict[str, Any]], grades: dict[str, int], k: int) -> dict[str, float | int | None]:
    top = results[:k]
    relevant = {doc_id for doc_id, grade in grades.items() if grade >= 2}
    context_relevant = {doc_id for doc_id, grade in grades.items() if grade >= 1}
    retrieved = {item["documentId"] for item in top}
    first_rank = next((rank for rank, item in enumerate(top, start=1) if item["documentId"] in relevant), None)
    context_first_rank = next((rank for rank, item in enumerate(top, start=1) if item["documentId"] in context_relevant), None)
    dcg = sum((2**grades.get(item["documentId"], 0) - 1) / math.log2(rank + 1) for rank, item in enumerate(top, start=1))
    ideal = sorted(grades.values(), reverse=True)[:k]
    idcg = sum((2**grade - 1) / math.log2(rank + 1) for rank, grade in enumerate(ideal, start=1))
    return {
        f"ndcg@{k}": round(dcg / idcg, 6) if idcg else None,
        f"mrr@{k}": round(1 / first_rank, 6) if first_rank else 0.0,
        f"precision@{k}": round(len(retrieved & relevant) / k, 6) if relevant else None,
        f"pooledRecall@{k}": round(len(retrieved & relevant) / len(relevant), 6) if relevant else None,
        f"contextPrecision@{k}": round(len(retrieved & context_relevant) / k, 6) if context_relevant else None,
        f"contextRecall@{k}": round(len(retrieved & context_relevant) / len(context_relevant), 6) if context_relevant else None,
        f"relevantFound@{k}": len(retrieved & relevant),
        f"pooledRelevantCount": len(relevant),
        f"contextRelevantFound@{k}": len(retrieved & context_relevant),
        f"contextRelevantCount": len(context_relevant),
        f"mrrContext@{k}": round(1 / context_first_rank, 6) if context_first_rank else 0.0,
    }


def _bootstrap_mean_ci(values: list[float], seed: int = 20261015, replicates: int = 10000) -> dict[str, Any]:
    if len(values) < 2:
        return {"lower": None, "upper": None, "replicates": 0, "reason": "fewer than two paired questions"}
    rng = random.Random(seed)
    means = sorted(
        sum(values[rng.randrange(len(values))] for _ in values) / len(values)
        for _ in range(replicates)
    )
    low_index = math.floor(0.025 * (replicates - 1))
    high_index = math.ceil(0.975 * (replicates - 1))
    return {"lower": round(means[low_index], 6), "upper": round(means[high_index], 6), "replicates": replicates, "seed": seed}


def _question_judgments(judge: dict[str, Any]) -> dict[str, dict[str, Any]]:
    if isinstance(judge.get("qrels"), list) and isinstance(judge.get("questionId"), str):
        return {judge["questionId"]: {item["candidateId"]: item for item in judge["qrels"]}}
    grouped: dict[str, dict[str, Any]] = {}
    for batch in judge.get("judgments", []):
        if batch.get("status") != "ok":
            continue
        question_id = batch.get("questionId")
        if question_id is None and isinstance(batch.get("questionOrdinal"), int):
            question_id = f"__ordinal_{batch['questionOrdinal']}"
        if not isinstance(question_id, str):
            continue
        destination = grouped.setdefault(question_id, {})
        for item in batch.get("judgments", []):
            candidate_id = item.get("candidateId")
            if isinstance(candidate_id, str):
                destination[candidate_id] = item
    return grouped


def _review_ids_by_question(judge: dict[str, Any], dataset_questions: list[dict[str, Any]]) -> dict[str, set[str]]:
    review_map: dict[str, set[str]] = {}
    manual_question = judge.get("questionId")
    if isinstance(manual_question, str):
        review_map[manual_question] = set(judge.get("reviewRequiredCandidateIds", []))
    for batch in judge.get("judgments", []):
        if not isinstance(batch, dict):
            continue
        question_id = batch.get("questionId")
        if question_id is None and isinstance(batch.get("questionOrdinal"), int):
            ordinal = batch["questionOrdinal"]
            if 1 <= ordinal <= len(dataset_questions):
                question_id = dataset_questions[ordinal - 1].get("questionId")
        if isinstance(question_id, str):
            review_map.setdefault(question_id, set()).update(batch.get("reviewRequiredIds", []))
    return review_map


def score(
    dataset: dict[str, Any],
    candidate_pool: dict[str, Any],
    judge: dict[str, Any],
    run_paths: dict[str, Path],
    ks: list[int],
    allow_review_required: bool,
) -> dict[str, Any]:
    dataset_questions = dataset.get("questions", [])
    question_by_id = {item["questionId"]: item for item in dataset_questions}
    pool_questions = {item["questionId"]: item for item in candidate_pool.get("questions", [])}
    # The judge packet deliberately uses blinded question IDs. Join its
    # candidate pool back to the frozen dataset by exact query text when IDs
    # differ; reject ambiguous matches instead of silently scoring zero rows.
    pool_by_query: dict[str, list[dict[str, Any]]] = {}
    for item in candidate_pool.get("questions", []):
        query = item.get("query")
        if isinstance(query, str):
            pool_by_query.setdefault(query, []).append(item)
    for question in dataset_questions:
        question_id = question["questionId"]
        if question_id in pool_questions:
            continue
        matches = pool_by_query.get(question.get("query"), [])
        if len(matches) != 1:
            raise ValueError(
                f"cannot map blinded candidate pool to dataset question {question_id}: {len(matches)} exact query matches"
            )
        pool_questions[question_id] = matches[0]
    judgments_by_question = _question_judgments(judge)
    if any(key.startswith("__ordinal_") for key in judgments_by_question):
        ordinals = {
            f"__ordinal_{index}": question["questionId"]
            for index, question in enumerate(dataset_questions, start=1)
        }
        judgments_by_question = {
            ordinals.get(question_id, question_id): values
            for question_id, values in judgments_by_question.items()
        }
    review_by_question = _review_ids_by_question(judge, dataset_questions)
    review_ids = set().union(*review_by_question.values()) if review_by_question else set()

    run_documents: dict[str, dict[str, dict[str, Any]]] = {}
    run_hashes: dict[str, str] = {}
    for method, path in run_paths.items():
        run, digest = _read(path)
        if run.get("corpusVersion") != dataset.get("corpusVersion"):
            raise ValueError(f"{method}: run corpusVersion does not match the question dataset")
        if run.get("datasetId") != dataset.get("datasetId"):
            raise ValueError(f"{method}: run datasetId does not match the question dataset")
        run_hashes[method] = digest
        run_documents[method] = {row["questionId"]: row for row in run.get("queries", [])}

    per_method: dict[str, list[dict[str, Any]]] = {}
    for method, questions in run_documents.items():
        method_rows = []
        for question_id, candidate_grades in judgments_by_question.items():
            if question_id not in question_by_id or question_id not in pool_questions:
                continue
            pool_map = {
                item["candidateId"]: item["documentId"]
                for item in pool_questions[question_id].get("candidatePool", [])
            }
            candidate_review_ids = review_by_question.get(question_id, set())
            grades = {
                pool_map[candidate_id]: item["relevanceGrade"]
                for candidate_id, item in candidate_grades.items()
                if candidate_id in pool_map
                and isinstance(item.get("relevanceGrade"), int)
                and (allow_review_required or candidate_id not in candidate_review_ids)
            }
            observed_grades = {
                pool_map[candidate_id]: item["relevanceGrade"]
                for candidate_id, item in candidate_grades.items()
                if candidate_id in pool_map and isinstance(item.get("relevanceGrade"), int)
            }
            pool_document_ids = set(pool_map.values())
            unresolved_pool_document_ids = pool_document_ids - set(grades)
            run_row = questions.get(question_id, {"status": "missing", "results": []})
            if run_row.get("status") != "ok":
                results = []
            else:
                results = run_row.get("results", [])
            results = [
                item for index, item in enumerate(results)
                if isinstance(item, dict)
                and isinstance(item.get("documentId"), str)
                and item["documentId"] not in {previous.get("documentId") for previous in results[:index] if isinstance(previous, dict)}
            ]
            row: dict[str, Any] = {
                "questionId": question_id,
                "taskCategory": question_by_id[question_id].get("taskCategory"),
                "language": question_by_id[question_id].get("language"),
                "runStatus": run_row.get("status", "missing"),
                "judgedPoolCoverage": round(len(observed_grades) / len(pool_questions[question_id].get("candidatePool", [])), 6) if pool_questions[question_id].get("candidatePool") else 0.0,
                "resolvedPoolCoverage": round(len(grades) / len(pool_questions[question_id].get("candidatePool", [])), 6) if pool_questions[question_id].get("candidatePool") else 0.0,
                "reviewRequiredCandidateCount": len(candidate_review_ids),
                "reviewRequiredLabelsIncluded": bool(allow_review_required and candidate_review_ids),
                "returnedResultCount": len(results),
                "unresolvedPoolCandidateCount": len(unresolved_pool_document_ids),
            }
            for k in ks:
                top_documents = {item["documentId"] for item in results[:k]}
                outside_pool_documents = top_documents - pool_document_ids
                eligible = not unresolved_pool_document_ids and not outside_pool_documents
                row[f"metricEligibility@{k}"] = "eligible" if eligible else "excluded_incomplete_qrels_or_unpooled_results"
                row[f"unpooledReturnedCount@{k}"] = len(outside_pool_documents)
                if eligible:
                    row.update(_metrics(results, grades, k))
                else:
                    row.update({
                        f"ndcg@{k}": None,
                        f"mrr@{k}": None,
                        f"precision@{k}": None,
                        f"pooledRecall@{k}": None,
                        f"contextPrecision@{k}": None,
                        f"contextRecall@{k}": None,
                        f"relevantFound@{k}": None,
                        f"pooledRelevantCount@{k}": None,
                        f"contextRelevantFound@{k}": None,
                        f"contextRelevantCount@{k}": None,
                        f"mrrContext@{k}": None,
                    })
            method_rows.append(row)
        per_method[method] = method_rows

    summary: dict[str, Any] = {}
    for method, rows in per_method.items():
        metrics = {}
        metric_question_counts = {}
        for k in ks:
            for name in (f"ndcg@{k}", f"mrr@{k}", f"precision@{k}", f"pooledRecall@{k}", f"contextPrecision@{k}", f"contextRecall@{k}", f"mrrContext@{k}"):
                values = [row[name] for row in rows if isinstance(row.get(name), (int, float))]
                metrics[name] = round(sum(values) / len(values), 6) if values else None
                metric_question_counts[name] = len(values)
        by_category: dict[str, Any] = {}
        for category in sorted({str(row.get("taskCategory", "unknown")) for row in rows}):
            selected = [row for row in rows if str(row.get("taskCategory", "unknown")) == category]
            category_metrics = {}
            category_metric_question_counts = {}
            for k in ks:
                for name in (f"ndcg@{k}", f"mrr@{k}", f"precision@{k}", f"pooledRecall@{k}", f"contextPrecision@{k}", f"contextRecall@{k}", f"mrrContext@{k}"):
                    values = [row[name] for row in selected if isinstance(row.get(name), (int, float))]
                    category_metrics[name] = round(sum(values) / len(values), 6) if values else None
                    category_metric_question_counts[name] = len(values)
            by_category[category] = {
                "questionCount": len(selected),
                "metrics": category_metrics,
                "metricQuestionCounts": category_metric_question_counts,
            }
        summary[method] = {
            "questionCount": len(rows),
            "metricEligibleQuestionCountByK": {
                str(k): sum(row.get(f"metricEligibility@{k}") == "eligible" for row in rows)
                for k in ks
            },
            "ineligibleQuestionCountByK": {
                str(k): sum(row.get(f"metricEligibility@{k}") != "eligible" for row in rows)
                for k in ks
            },
            "metrics": metrics,
            "metricQuestionCounts": metric_question_counts,
            "metricsByCategory": by_category,
            "macroAggregation": "unweighted macro over scored questions",
        }

    paired: dict[str, Any] = {}
    if "dense" in per_method:
        base = {row["questionId"]: row for row in per_method["dense"]}
        for method, rows in per_method.items():
            if method == "dense":
                continue
            other = {row["questionId"]: row for row in rows}
            common = sorted(set(base) & set(other))
            metric_differences: dict[str, Any] = {}
            for k in ks:
                for name in (f"ndcg@{k}", f"mrr@{k}", f"precision@{k}", f"pooledRecall@{k}"):
                    diffs = [other[qid][name] - base[qid][name] for qid in common if isinstance(other[qid].get(name), (int, float)) and isinstance(base[qid].get(name), (int, float))]
                    metric_differences[name] = {
                        "pairedQuestionCount": len(diffs),
                        "meanDifference": round(sum(diffs) / len(diffs), 6) if diffs else None,
                        "bootstrap95PercentileCI": _bootstrap_mean_ci(diffs),
                    }
            paired[method] = metric_differences

    pairwise: dict[str, Any] = {}
    method_names = sorted(per_method)
    for comparison_index, comparison in enumerate(method_names):
        comparison_rows = {row["questionId"]: row for row in per_method[comparison]}
        for baseline in method_names[:comparison_index]:
            baseline_rows = {row["questionId"]: row for row in per_method[baseline]}
            common = sorted(set(comparison_rows) & set(baseline_rows))
            metrics: dict[str, Any] = {}
            for k in ks:
                for name in (f"ndcg@{k}", f"mrr@{k}", f"precision@{k}", f"pooledRecall@{k}"):
                    deltas = [
                        comparison_rows[qid][name] - baseline_rows[qid][name]
                        for qid in common
                        if isinstance(comparison_rows[qid].get(name), (int, float))
                        and isinstance(baseline_rows[qid].get(name), (int, float))
                    ]
                    metrics[name] = {
                        "pairedQuestionCount": len(deltas),
                        "meanDifference": round(sum(deltas) / len(deltas), 6) if deltas else None,
                        "bootstrap95PercentileCI": _bootstrap_mean_ci(deltas),
                    }
            pairwise[f"{comparison}_vs_{baseline}"] = {
                "comparisonMethod": comparison,
                "baselineMethod": baseline,
                "metrics": metrics,
            }

    label_mode = judge.get("judge", {}).get("executionMode", judge.get("judgeMode", "unknown"))
    if not judgments_by_question:
        raise ValueError("judge run contains no scoreable query judgments")
    return {
        "schemaVersion": "huiyi-rag-llm-judge-score/v1",
        "status": "exploratory_only" if len(judgments_by_question) < 100 or review_ids or judge.get("status", "").endswith("not_final_qrels") else "scored",
        "datasetId": dataset.get("datasetId"),
        "split": dataset.get("split"),
        "corpusVersion": dataset.get("corpusVersion"),
        "judgeMode": label_mode,
        "judgeExactModelId": judge.get("judge", {}).get("exactModelIdAvailable"),
        "externalGoldAgreement": judge.get("judge", {}).get("externalGoldAgreement"),
        "questionCount": len(judgments_by_question),
        "reviewRequiredLabelCount": len(review_ids),
        "reviewRequiredLabelsIncluded": bool(allow_review_required and review_ids),
        "reviewRequiredLabelsExcluded": bool(review_ids and not allow_review_required),
        "pooledQrelsOnly": True,
        "fullCorpusRecallClaimed": False,
        "relevanceGradeMeaning": {"0": "irrelevant", "1": "partial/topical", "2": "direct support"},
        "relevanceThresholdForPrecisionRecallMrr": 2,
        "contextRelevanceThreshold": 1,
        "manifestSha256": candidate_pool.get("manifestSha256"),
        "metricNote": "Standard retrieval metrics are scored only for a query with fully resolved labels for its entire pooled candidate set and no unpooled Top-K results; otherwise that query's metric is null, never defaulted to grade 0. Precision/pooledRecall/MRR count direct-support grade 2; context metrics include grade 1; nDCG uses graded gains 0/1/2.",
        "metricsByMethod": summary,
        "pairedAgainstDense": paired,
        "pairedComparisons": pairwise,
        "perMethodPerQuestion": per_method,
        "inputHashes": {
            "judgeOutput": hashlib.sha256(json.dumps(judge, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest(),
            "scorer": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "runs": run_hashes,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--candidate-pool", type=Path, required=True)
    parser.add_argument("--judge-run", type=Path, required=True)
    parser.add_argument("--run", action="append", required=True, help="METHOD=PATH; repeat for each ablation run")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--ks", default="5,10,20")
    parser.add_argument("--allow-review-required", action="store_true")
    args = parser.parse_args()
    dataset, dataset_hash = _read(args.dataset)
    candidate_pool, pool_hash = _read(args.candidate_pool)
    judge, judge_hash = _read(args.judge_run)
    run_paths = {}
    for item in args.run:
        method, separator, path = item.partition("=")
        if not separator or not method or not path:
            parser.error("--run must be METHOD=PATH")
        run_paths[method] = Path(path)
    ks = sorted({int(value) for value in args.ks.split(",") if value.strip()})
    if not ks or any(value < 1 for value in ks):
        parser.error("--ks must contain positive integers")
    report = score(dataset, candidate_pool, judge, run_paths, ks, args.allow_review_required)
    report["inputHashes"].update({"dataset": dataset_hash, "candidatePool": pool_hash, "judgeRun": judge_hash})
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "questionCount": report["questionCount"], "metricsByMethod": report["metricsByMethod"], "pairedAgainstDense": report["pairedAgainstDense"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
