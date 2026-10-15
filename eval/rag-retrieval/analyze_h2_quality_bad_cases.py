#!/usr/bin/env python3
"""Extract version-bound, qrel-grounded bad-case evidence from the H2 pilot."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


METHOD_FILES = {
    "dense": "run-dense.json",
    "bm25": "run-bm25.json",
    "rrf": "run-rrf.json",
    "reranker": "run-rrf-reranker.json",
    "iterative": "run-iterative-20261015.json",
}

CASE_SPECS = [
    ("BC-001", "H2-P-002", "bm25", "sparse_candidate_miss", "BM25 returns high-frequency Huiyi eye-care pages while all 8 pooled direct-support documents are absent from its top 20. The OR query over overlapping CJK bigrams is a plausible source of broad matches; this is not yet isolated experimentally.", "Compare AND/phrase and IDF-aware CJK tokenization on DEV; preserve exact medical terms and report candidate recall before changing the index."),
    ("BC-002", "H2-P-003", "bm25", "sparse_candidate_miss", "No grade-2 candidate is retrieved in the top 20; the first results are unrelated eye-care topics. The current tokenizer/OR retrieval appears to overmatch generic Chinese bigrams.", "Inspect matched term frequencies and add query-level discrimination only in a separate DEV ablation."),
    ("BC-003", "H2-P-005", "bm25", "multi_element_candidate_miss", "The query requires discharge medication changes plus pending tests and follow-up; BM25 retrieves zero of 5 pooled direct-support documents in top 20. The OR expression has no explicit coverage constraint for the separate elements.", "Measure per-element candidate coverage; test conjunctive/multi-query retrieval without changing the frozen question or qrels."),
    ("BC-004", "H2-P-008", "bm25", "bilingual_candidate_miss", "BM25 returns topical grade-1 monitoring passages but none of 6 grade-2 candidates in top 20. The English/Chinese query terms match generic monitoring records across unrelated conditions.", "Add a bilingual query normalization/term-group ablation and compare direct-support candidate recall."),
    ("BC-005", "H2-P-010", "bm25", "source_conflict_candidate_miss", "The task asks to reconcile medication-list source and time conflicts; BM25 misses all 15 pooled direct-support candidates in top 20 and ranks unrelated Huiyi eye-care pages.", "Test field/term grouping for source, timestamp, and medication concepts; keep provenance as separate evidence, not merged text."),
    ("BC-006", "H2-P-002", "rrf", "fusion_rank_regression", "RRF's first direct-support result is rank 4, versus rank 2 for Dense; the top five contains low-relevance Huiyi results. Eight direct-support documents are pooled for this question.", "Ablate per-channel contribution and candidate eligibility; log source ranks and measure whether noisy BM25 candidates displace Dense evidence."),
    ("BC-007", "H2-P-005", "rrf", "fusion_coverage_regression", "RRF returns only 1 of 5 direct-support pool documents in its top five, compared with 3 for Dense; the issue is candidate retention/ranking after fusion, not a timeout.", "Compare union-preserving fusion and per-element evidence coverage against frozen RRF; do not raise candidate budget without a separate budget arm."),
    ("BC-008", "H2-P-007", "rrf", "bilingual_fusion_rank_regression", "All first five RRF results are grade 1; the direct-support documents land at ranks 7, 9, and 14. Dense's first direct-support result is rank 4 and BM25's is rank 2.", "Inspect common high-ranked generic discharge candidates that accumulate RRF votes; test cross-lingual term handling and weighted/adaptive fusion on DEV."),
    ("BC-009", "H2-P-008", "rrf", "bilingual_fusion_rank_regression", "RRF puts the first direct-support result at rank 10 (then 15, 16, 20); Dense finds one at rank 5. Top five are generic monitoring context, so the first page misses direct support.", "Check whether sparse-only generic monitoring candidates outrank Dense direct evidence; measure the fused candidate list before reranking."),
    ("BC-010", "H2-P-005", "reranker", "reranker_displacement", "The reranker places the first direct-support document at rank 4 and has only 2 of 5 direct-support documents in top five; Dense and Iterative each place a direct-support result at rank 1.", "Inspect pairwise query-document judgments and reranker scores for the top 20; test reranker against the same candidate union, preserving this run as baseline."),
    ("BC-011", "H2-P-007", "iterative", "iterative_retrieval_not_resolving", "The planner generates two generic discharge-follow-up paraphrases. The first direct-support result is rank 6, with only 1 of 3 pooled direct-support documents present in the final 20; reranking reaches rank 1 on this query.", "Require the planner to retain the query's evidence elements and stop only after per-element support checks; compare at matched retrieval-call and candidate budgets."),
    ("BC-012", "H2-P-007", "dense", "dense_baseline_ranking_weakness", "Dense's first direct-support result is rank 4 while reranking reaches rank 1; this is a comparative ranking weakness, not a top-five miss.", "Check the language mix and evidence wording for this frozen query; compare bilingual normalization and reranker under the same top-20 candidate pool."),
    ("BC-013", "H2-P-008", "dense", "dense_baseline_ranking_weakness", "Dense's first direct-support result is rank 5; RRF reaches rank 10, while reranker and Iterative place direct evidence at rank 3. Dense still finds direct evidence in top five.", "Inspect which evidence elements appear in the dense first four and evaluate a fixed candidate-preserving rerank on DEV."),
    ("BC-014", "H2-P-011", "dense", "no_answer_retrieval_risk", "The frozen query asks for a non-public 2026 internal protocol; the pooled qrels contain no grade-2 support. Retrieval returns topical candidates, but this experiment did not generate an answer and cannot establish false-support behavior.", "Add a fixed-generator abstention test with claim-level support checks; do not treat retrieval presence as an answer failure."),
    ("BC-015", "H2-P-012", "iterative", "no_answer_retrieval_risk", "The frozen query asks for an unpublished internal drug-catalog memo; the pooled qrels contain no grade-2 support. Iterative retrieval still returns topical material, but answer abstention was not tested.", "Measure whether the sufficiency gate returns evidence-insufficient under fixed thresholds and generator prompts."),
]


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--judge-run", type=Path, required=True)
    parser.add_argument("--score", type=Path, required=True)
    parser.add_argument("--followup-probe-run", type=Path, required=True)
    parser.add_argument("--followup-probe-score", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    dataset_path = args.data_dir / "pilot-queries.pending.json"
    private_pool_path = args.data_dir / "candidate-pool.private.json"
    annotation_path = args.data_dir / "annotation-packet.blinded.json"
    dataset = read_json(dataset_path)
    private_pool = read_json(private_pool_path)
    annotation = read_json(annotation_path)
    judge = read_json(args.judge_run)
    score = read_json(args.score)

    dataset_by_id = {item["questionId"]: item for item in dataset["questions"]}
    pool_by_id = {item["questionId"]: item for item in private_pool["questions"]}
    annotation_by_blind_id = {item["questionId"]: item for item in annotation["questions"]}
    labels_by_id: dict[str, dict[str, dict[str, Any]]] = {}
    unresolved_by_id: dict[str, set[str]] = {}
    for batch in judge["judgments"]:
        ordinal = batch["questionOrdinal"]
        question_id = dataset["questions"][ordinal - 1]["questionId"]
        labels_by_id[question_id] = {
            item["candidateId"]: item for item in batch.get("judgments", [])
        }
        unresolved_by_id[question_id] = set(batch.get("reviewRequiredIds", []))

    runs = {method: read_json(args.run_dir / file_name) for method, file_name in METHOD_FILES.items()}
    score_rows = {
        method: {row["questionId"]: row for row in score["perMethodPerQuestion"][method]}
        for method in METHOD_FILES
    }

    cases: list[dict[str, Any]] = []
    for case_id, question_id, focus_method, case_type, cause, fix in CASE_SPECS:
        question = dataset_by_id[question_id]
        private_question = pool_by_id[question_id]
        blind_id = private_question["blindQuestionId"]
        annotations_by_candidate = {
            item["candidateId"]: item
            for item in annotation_by_blind_id[blind_id]["candidatePool"]
        }
        document_by_candidate = {
            item["candidateId"]: item["documentId"]
            for item in private_question["candidatePool"]
        }
        candidate_by_document = {v: k for k, v in document_by_candidate.items()}
        labels = labels_by_id[question_id]
        unresolved_ids = unresolved_by_id[question_id]
        resolved_grade_by_document = {
            document_by_candidate[candidate_id]: label["relevanceGrade"]
            for candidate_id, label in labels.items()
            if candidate_id not in unresolved_ids and candidate_id in document_by_candidate
        }
        direct_support = []
        for candidate_id, grade in labels.items():
            if grade["relevanceGrade"] != 2 or candidate_id in unresolved_ids:
                continue
            pool_item = annotations_by_candidate[candidate_id]
            label = grade
            direct_support.append(
                {
                    "candidateId": candidate_id,
                    "documentId": document_by_candidate[candidate_id],
                    "source": pool_item.get("source"),
                    "title": pool_item.get("title"),
                    "sourceUri": pool_item.get("sourceUri"),
                    "judgeExplanation": label.get("explanation"),
                    "confidence": label.get("confidence"),
                    "exactQuoteVerified": label.get("exactQuoteVerified"),
                }
            )
        direct_ids = {item["documentId"] for item in direct_support}

        method_summaries = {}
        for method, run in runs.items():
            row = next((item for item in run["queries"] if item["questionId"] == question_id), None)
            results = row.get("results", []) if row and row.get("status") == "ok" else []
            ranks = {item["documentId"]: rank for rank, item in enumerate(results, 1)}
            direct_ranks = sorted(ranks[item] for item in direct_ids if item in ranks)
            top5 = []
            for rank, result in enumerate(results[:5], 1):
                candidate_id = candidate_by_document.get(result["documentId"])
                annotation_item = annotations_by_candidate.get(candidate_id, {})
                top5.append(
                    {
                        "rank": rank,
                        "documentId": result["documentId"],
                        "candidateId": candidate_id,
                        "source": result.get("source", annotation_item.get("source")),
                        "title": result.get("title", annotation_item.get("title")),
                        "resolvedRelevanceGrade": resolved_grade_by_document.get(result["documentId"]),
                    }
                )
            method_row = score_rows[method][question_id]
            method_summaries[method] = {
                "runStatus": row.get("status", "missing") if row else "missing",
                "candidateBudget": run.get("candidateBudget"),
                "top5DirectSupportHits": sum(1 for item in results[:5] if item["documentId"] in direct_ids),
                "top10DirectSupportHits": sum(1 for item in results[:10] if item["documentId"] in direct_ids),
                "top20DirectSupportHits": sum(1 for item in results[:20] if item["documentId"] in direct_ids),
                "firstDirectSupportRank": direct_ranks[0] if direct_ranks else None,
                "directSupportRanks": direct_ranks,
                "ndcgAt10": method_row.get("ndcg@10"),
                "top5": top5,
            }

        direct_orderings = {
            method: {
                "firstRank": method_summaries[method]["firstDirectSupportRank"],
                "directSupportRanks": method_summaries[method]["directSupportRanks"],
                "top5DirectSupportHits": method_summaries[method]["top5DirectSupportHits"],
            }
            for method in METHOD_FILES
        }
        counted_as_quality_regression = case_type not in {
            "no_answer_retrieval_risk",
            "dense_baseline_ranking_weakness",
        }
        cases.append(
            {
                "caseId": case_id,
                "questionId": question_id,
                "query": question["query"],
                "taskCategory": question["taskCategory"],
                "caseType": case_type,
                "countedAsQualityRegression": counted_as_quality_regression,
                "qrelStatus": "llm_judge_resolved_pool_only",
                "answerabilityStatus": question.get("answerability"),
                "datasetReviewStatus": question.get("reviewStatus"),
                "noAnswerGoldValidated": question.get("answerability") == "unanswerable" and bool(question.get("annotations")),
                "resolvedDirectSupportQrelCount": len(direct_support),
                "unresolvedCandidateLabelCount": len(unresolved_ids),
                "requiredEvidence": direct_support,
                "methods": method_summaries,
                "crossMethodDirectSupportRanks": direct_orderings,
                "observedStage": {
                    "bm25": "candidate generation and sparse ranking",
                    "rrf": "rank fusion and top-20 truncation",
                    "reranker": "reranker ordering over fixed RRF candidates",
                    "iterative": "planner query generation, retrieval, and final ranking",
                    "dense": "dense top-k ranking",
                }[focus_method],
                "focusMethod": focus_method,
                "rootCauseStatus": "engineering_hypothesis_from_frozen_run_and_qrels; not yet isolated by intervention",
                "rootCauseHypothesis": cause,
                "proposedFixForDevOnly": fix,
                "verifiedExperimentChange": (
                    "All-token BM25 AND control on the same frozen queries/index returned 0/12 results; no fix validated."
                    if focus_method == "bm25"
                    else "none; this case records the frozen A-E baseline and does not claim a fix"
                ),
            }
        )

    followup_run = read_json(args.followup_probe_run)
    followup_score = read_json(args.followup_probe_score)
    and_metrics = followup_score["metricsByMethod"]["bm25-and"]
    input_paths = [
        dataset_path,
        private_pool_path,
        annotation_path,
        args.judge_run,
        args.score,
        args.followup_probe_run,
        args.followup_probe_score,
    ]
    input_paths.extend(args.run_dir / file_name for file_name in METHOD_FILES.values())
    output = {
        "schemaVersion": "huiyi-h2-pilot-quality-bad-cases/v1",
        "status": "exploratory_pilot_cases_not_clinical_review",
        "questionCount": len(dataset["questions"]),
        "caseCount": len(cases),
        "qualityRegressionCountExcludingNoAnswerRisksAndBaselineObservations": sum(
            item["countedAsQualityRegression"] for item in cases
        ),
        "judgeModel": judge.get("judge", {}).get("exactModelIdAvailable"),
        "humanReview": False,
        "analysisScriptSha256": digest(Path(__file__).resolve()),
        "followupProbe": {
            "variant": "BM25 with AND across every unique token from the frozen tokenizer",
            "sameCorpusIndex": True,
            "indexSha256": followup_run["inputHashes"]["index"],
            "questionCount": len(followup_run["queries"]),
            "nonemptyQueryCount": sum(bool(item["results"]) for item in followup_run["queries"]),
            "retrievedCandidateCount": sum(len(item["results"]) for item in followup_run["queries"]),
            "nDCGAt10": and_metrics["metrics"]["ndcg@10"],
            "MRRAt10": and_metrics["metrics"]["mrr@10"],
            "precisionAt5": and_metrics["metrics"]["precision@5"],
            "pooledRecallAt5": and_metrics["metrics"]["pooledRecall@5"],
            "conclusion": "overly restrictive; negative diagnostic only, not a repair",
        },
        "frozenDatasetId": dataset.get("datasetId"),
        "corpusVersion": dataset.get("corpusVersion"),
        "cases": cases,
        "inputHashes": {str(path): digest(path) for path in input_paths},
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "caseCount": output["caseCount"],
                "qualityRegressionCountExcludingNoAnswerRisksAndBaselineObservations": output[
                    "qualityRegressionCountExcludingNoAnswerRisksAndBaselineObservations"
                ],
                "judgeModel": output["judgeModel"],
                "output": str(args.out),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
