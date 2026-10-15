#!/usr/bin/env python3
"""Score a new retrieval probe only against already resolved pooled qrels.

Unjudged results are counted and never treated as nonrelevant. The outputs are
known-qrel hit/recall lower-bound diagnostics, not precision or nDCG scores.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from pathlib import Path
from typing import Any


def read(path: Path) -> tuple[Any, str]:
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), hashlib.sha256(raw).hexdigest()


def bootstrap(values: list[float], seed: int = 20261015, replicates: int = 10000) -> dict[str, Any]:
    if len(values) < 2:
        return {"lower": None, "upper": None, "replicates": 0, "reason": "fewer than two paired questions"}
    rng = random.Random(seed)
    means = sorted(sum(values[rng.randrange(len(values))] for _ in values) / len(values) for _ in range(replicates))
    return {
        "lower": round(means[math.floor(0.025 * (replicates - 1))], 6),
        "upper": round(means[math.ceil(0.975 * (replicates - 1))], 6),
        "replicates": replicates,
        "seed": seed,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--candidate-pool", type=Path, required=True)
    parser.add_argument("--judge-run", type=Path, required=True)
    parser.add_argument("--adjudication", type=Path, required=True)
    parser.add_argument("--run", action="append", required=True, help="METHOD=PATH; repeat for each probe run")
    parser.add_argument("--ks", default="5,10,20")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    dataset, dataset_hash = read(args.dataset)
    pool, pool_hash = read(args.candidate_pool)
    judge, judge_hash = read(args.judge_run)
    adjudication, adjudication_hash = read(args.adjudication)
    questions = dataset.get("questions", [])
    pools = pool.get("questions", [])
    judge_batches = judge.get("judgments", [])
    if len(questions) != len(pools) or len(questions) != len(judge_batches):
        raise ValueError("dataset, blinded pool, and judge batches must have the same frozen question count/order")
    if (pool.get("datasetId") is not None and dataset.get("datasetId") != pool.get("datasetId")) or dataset.get("datasetId") != judge.get("datasetId"):
        raise ValueError("dataset ID mismatch across frozen input artifacts")
    pool_by_question = {row["questionId"]: row for row in pools}
    batches_by_ordinal = {row.get("questionOrdinal"): row for row in judge_batches}
    if set(batches_by_ordinal) != set(range(1, len(questions) + 1)):
        raise ValueError("judge batches do not cover each frozen question ordinal exactly once")

    decisions: dict[tuple[str, str], dict[str, Any]] = {}
    for item in adjudication.get("candidateDecisions", []):
        decisions[(item.get("questionId"), item.get("candidateId"))] = item

    grades_by_question: dict[str, dict[str, int]] = {}
    excluded_by_question: dict[str, set[str]] = {}
    for ordinal, question in enumerate(questions, start=1):
        batch = batches_by_ordinal[ordinal]
        qid = question["questionId"]
        if batch.get("questionOrdinal") != ordinal or batch.get("status") != "ok":
            raise ValueError(f"judge batch {ordinal} is missing, failed, or out of frozen question order")
        pool_row = pool_by_question[qid]
        blind_id = pool_row.get("blindQuestionId")
        review_ids = set(batch.get("reviewRequiredIds", []))
        grades: dict[str, int] = {}
        excluded_docs: set[str] = set()
        candidate_docs = {item["candidateId"]: item["documentId"] for item in pool_row.get("candidatePool", [])}
        for label in batch.get("judgments", []):
            candidate_id = label.get("candidateId")
            if candidate_id not in candidate_docs or not isinstance(label.get("relevanceGrade"), int):
                continue
            decision = decisions.get((blind_id, candidate_id))
            if candidate_id in review_ids:
                if decision and decision.get("outcome") == "resolved_by_agreeing_second_pass":
                    grade = decision.get("secondPassGrade")
                else:
                    excluded_docs.add(candidate_docs[candidate_id])
                    continue
            elif decision and decision.get("outcome") == "review_required":
                excluded_docs.add(candidate_docs[candidate_id])
                continue
            else:
                grade = label["relevanceGrade"]
            if isinstance(grade, int) and grade in (0, 1, 2):
                grades[candidate_docs[candidate_id]] = grade
        grades_by_question[qid] = grades
        excluded_by_question[qid] = excluded_docs

    run_paths: dict[str, Path] = {}
    for spec in args.run:
        method, sep, filename = spec.partition("=")
        if not sep or not method or not filename or method in run_paths:
            parser.error("--run must be unique METHOD=PATH entries")
        run_paths[method] = Path(filename)
    ks = sorted({int(value) for value in args.ks.split(",") if value.strip()})
    if not ks or any(k < 1 for k in ks):
        parser.error("--ks must contain positive integers")

    method_rows: dict[str, list[dict[str, Any]]] = {}
    run_hashes: dict[str, str] = {}
    for method, path in run_paths.items():
        run, run_hash = read(path)
        if run.get("datasetId") != dataset.get("datasetId") or run.get("corpusVersion") != dataset.get("corpusVersion"):
            raise ValueError(f"{method}: datasetId or corpusVersion mismatch")
        run_hashes[method] = run_hash
        run_by_question = {row["questionId"]: row for row in run.get("queries", [])}
        rows = []
        for question in questions:
            qid = question["questionId"]
            run_row = run_by_question.get(qid, {"status": "missing", "results": []})
            results = run_row.get("results", []) if run_row.get("status") == "ok" else []
            unique_results = []
            seen: set[str] = set()
            for item in results:
                doc_id = item.get("documentId") if isinstance(item, dict) else None
                if isinstance(doc_id, str) and doc_id not in seen:
                    seen.add(doc_id)
                    unique_results.append(item)
            grades = grades_by_question[qid]
            excluded = excluded_by_question[qid]
            row: dict[str, Any] = {
                "questionId": qid,
                "taskCategory": question.get("taskCategory"),
                "answerability": question.get("answerability", question.get("answerabilityStatus", "unspecified")),
                "runStatus": run_row.get("status", "missing"),
                "returnedCount": len(unique_results),
                "resolvedJudgedPoolCount": len(grades),
                "reviewExcludedPoolCount": len(excluded),
                "knownDirectSupportQrelCount": sum(grade >= 2 for grade in grades.values()),
                "knownContextQrelCount": sum(grade >= 1 for grade in grades.values()),
            }
            for k in ks:
                top = unique_results[:k]
                returned_ids = {item["documentId"] for item in top}
                judged_returned = returned_ids & grades.keys()
                excluded_returned = returned_ids & excluded
                direct = {doc for doc, grade in grades.items() if grade >= 2}
                context = {doc for doc, grade in grades.items() if grade >= 1}
                direct_found = returned_ids & direct
                context_found = returned_ids & context
                first_direct_rank = next((rank for rank, item in enumerate(top, 1) if item["documentId"] in direct), None)
                row.update({
                    f"knownDirectSupportFound@{k}": len(direct_found),
                    f"knownDirectSupportRecall@{k}": round(len(direct_found) / len(direct), 6) if direct else None,
                    f"knownDirectSupportMRR@{k}": round(1 / first_direct_rank, 6) if first_direct_rank else 0.0,
                    f"knownContextFound@{k}": len(context_found),
                    f"knownContextRecall@{k}": round(len(context_found) / len(context), 6) if context else None,
                    f"resolvedJudgedReturned@{k}": len(judged_returned),
                    f"reviewExcludedReturned@{k}": len(excluded_returned),
                    f"unjudgedReturned@{k}": len(top) - len(judged_returned) - len(excluded_returned),
                    f"firstKnownDirectSupportRank@{k}": first_direct_rank,
                })
            rows.append(row)
        method_rows[method] = rows

    summaries: dict[str, Any] = {}
    for method, rows in method_rows.items():
        metrics: dict[str, Any] = {}
        for k in ks:
            for key in (f"knownDirectSupportRecall@{k}", f"knownDirectSupportMRR@{k}", f"knownContextRecall@{k}"):
                values = [row[key] for row in rows if isinstance(row.get(key), (int, float))]
                metrics[key] = round(sum(values) / len(values), 6) if values else None
                metrics[f"{key}QuestionCount"] = len(values)
            metrics[f"unjudgedReturned@{k}"] = sum(row[f"unjudgedReturned@{k}"] for row in rows)
            metrics[f"resolvedJudgedReturned@{k}"] = sum(row[f"resolvedJudgedReturned@{k}"] for row in rows)
            metrics[f"reviewExcludedReturned@{k}"] = sum(row[f"reviewExcludedReturned@{k}"] for row in rows)
        summaries[method] = {"questionCount": len(rows), "metrics": metrics}

    paired: dict[str, Any] = {}
    baseline_name = next(iter(method_rows))
    baseline = {row["questionId"]: row for row in method_rows[baseline_name]}
    for method, rows in method_rows.items():
        if method == baseline_name:
            continue
        other = {row["questionId"]: row for row in rows}
        paired[method] = {}
        for k in ks:
            name = f"knownDirectSupportRecall@{k}"
            common = [qid for qid in sorted(set(baseline) & set(other)) if isinstance(baseline[qid].get(name), (int, float)) and isinstance(other[qid].get(name), (int, float))]
            deltas = [other[qid][name] - baseline[qid][name] for qid in common]
            paired[method][name] = {
                "baselineMethod": baseline_name,
                "pairedQuestionCount": len(deltas),
                "meanDifference": round(sum(deltas) / len(deltas), 6) if deltas else None,
                "bootstrap95PercentileCI": bootstrap(deltas),
                "perQuestionDeltas": {qid: round(other[qid][name] - baseline[qid][name], 6) for qid in common},
            }

    output = {
        "schemaVersion": "huiyi-h2-known-qrel-probe-score/v1",
        "status": "exploratory_lower_bound_only",
        "datasetId": dataset.get("datasetId"),
        "split": dataset.get("split"),
        "corpusVersion": dataset.get("corpusVersion"),
        "questionCount": len(questions),
        "judge": {
            "mode": "existing blinded GPT-6-Luna labels with agreeing second-pass adjudication",
            "humanReviewed": False,
            "unresolvedLabelsExcluded": True,
            "newProbeCandidatesJudged": False,
        },
        "metricScope": {
            "qrels": "existing resolved pooled qrels only; unseen probe candidates remain unjudged",
            "reported": "known-qrel direct-support/context recall and reciprocal rank, plus judged/unjudged returned counts",
            "notReported": ["precision", "nDCG", "full-corpus recall", "no-answer false-support rate"],
            "interpretation": "known-qrel hits are a lower-bound diagnostic; unjudged candidates are not treated as nonrelevant",
        },
        "metricsByMethod": summaries,
        "pairedAgainstFirstMethod": paired,
        "perMethodPerQuestion": method_rows,
        "inputHashes": {
            "dataset": dataset_hash,
            "candidatePool": pool_hash,
            "judgeRun": judge_hash,
            "adjudication": adjudication_hash,
            "runs": run_hashes,
            "scorer": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        },
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    compact = {method: value["metrics"] for method, value in summaries.items()}
    print(json.dumps({"status": output["status"], "metricsByMethod": compact, "pairedAgainstFirstMethod": paired}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
