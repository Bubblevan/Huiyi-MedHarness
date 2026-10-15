from __future__ import annotations

import json
import tempfile
from pathlib import Path
import unittest

from score_judge_runs import _metrics, score


class LlmJudgeScoringTests(unittest.TestCase):
    def test_graded_ndcg_and_partial_relevance(self) -> None:
        results = [{"documentId": "d2"}, {"documentId": "d1"}, {"documentId": "d3"}]
        grades = {"d1": 2, "d2": 1, "d3": 0}
        metrics = _metrics(results, grades, 2)
        self.assertEqual(metrics["relevantFound@2"], 1)
        self.assertEqual(metrics["pooledRelevantCount"], 1)
        self.assertEqual(metrics["pooledRecall@2"], 1.0)
        self.assertEqual(metrics["mrr@2"], 0.5)
        self.assertEqual(metrics["contextRelevantCount"], 2)
        self.assertEqual(metrics["contextRecall@2"], 1.0)
        self.assertEqual(metrics["mrrContext@2"], 1.0)
        self.assertLess(metrics["ndcg@2"], 1.0)

    def test_empty_gold_does_not_report_recall(self) -> None:
        metrics = _metrics([{"documentId": "d1"}], {}, 5)
        self.assertIsNone(metrics["pooledRecall@5"])
        self.assertIsNone(metrics["precision@5"])

    def test_unresolved_qrel_excludes_query_from_standard_metrics(self) -> None:
        dataset = {
            "datasetId": "pilot",
            "split": "dev",
            "corpusVersion": "corpus-v1",
            "questions": [{"questionId": "Q-001", "query": "exact query", "taskCategory": "semantic"}],
        }
        candidate_pool = {
            "manifestSha256": "manifest",
            "questions": [
                {
                    "questionId": "blind-001",
                    "query": "exact query",
                    "candidatePool": [
                        {"candidateId": "C-good", "documentId": "doc-good"},
                        {"candidateId": "C-review", "documentId": "doc-review"},
                    ],
                }
            ],
        }
        judge = {
            "status": "complete_with_review",
            "judge": {"executionMode": "test", "exactModelIdAvailable": "test-model"},
            "judgments": [
                {
                    "questionOrdinal": 1,
                    "status": "ok",
                    "judgments": [
                        {"candidateId": "C-good", "relevanceGrade": 2},
                        {"candidateId": "C-review", "relevanceGrade": 2},
                    ],
                    "reviewRequiredIds": ["C-review"],
                }
            ],
        }

        with tempfile.TemporaryDirectory() as directory:
            run_path = Path(directory) / "dense.json"
            run_path.write_text(
                json.dumps(
                    {
                        "datasetId": "pilot",
                        "corpusVersion": "corpus-v1",
                        "queries": [
                            {
                                "questionId": "Q-001",
                                "status": "ok",
                                "results": [{"documentId": "doc-review"}, {"documentId": "doc-good"}],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            result = score(dataset, candidate_pool, judge, {"dense": run_path}, [5], False)

        self.assertEqual(result["status"], "exploratory_only")
        self.assertEqual(result["reviewRequiredLabelCount"], 1)
        self.assertTrue(result["reviewRequiredLabelsExcluded"])
        self.assertFalse(result["reviewRequiredLabelsIncluded"])
        row = result["perMethodPerQuestion"]["dense"][0]
        self.assertEqual(row["unresolvedPoolCandidateCount"], 1)
        self.assertEqual(row["metricEligibility@5"], "excluded_incomplete_qrels_or_unpooled_results")
        self.assertIsNone(row["pooledRecall@5"])
        self.assertIsNone(row["ndcg@5"])
        self.assertEqual(row["resolvedPoolCoverage"], 0.5)
        self.assertEqual(result["metricsByMethod"]["dense"]["metricQuestionCounts"]["ndcg@5"], 0)
        self.assertEqual(result["metricsByMethod"]["dense"]["metricQuestionCounts"]["precision@5"], 0)

    def test_unpooled_result_excludes_query_from_standard_metrics(self) -> None:
        dataset = {
            "datasetId": "pilot",
            "split": "dev",
            "corpusVersion": "corpus-v1",
            "questions": [{"questionId": "Q-001", "query": "exact query", "taskCategory": "semantic"}],
        }
        candidate_pool = {
            "manifestSha256": "manifest",
            "questions": [{
                "questionId": "blind-001",
                "query": "exact query",
                "candidatePool": [{"candidateId": "C-good", "documentId": "doc-good"}],
            }],
        }
        judge = {
            "status": "complete",
            "judge": {"executionMode": "test", "exactModelIdAvailable": "test-model"},
            "judgments": [{
                "questionOrdinal": 1,
                "status": "ok",
                "judgments": [{"candidateId": "C-good", "relevanceGrade": 2}],
                "reviewRequiredIds": [],
            }],
        }
        with tempfile.TemporaryDirectory() as directory:
            run_path = Path(directory) / "dense.json"
            run_path.write_text(json.dumps({
                "datasetId": "pilot",
                "corpusVersion": "corpus-v1",
                "queries": [{
                    "questionId": "Q-001",
                    "status": "ok",
                    "results": [{"documentId": "outside-pool"}, {"documentId": "doc-good"}],
                }],
            }), encoding="utf-8")
            result = score(dataset, candidate_pool, judge, {"dense": run_path}, [5], False)

        row = result["perMethodPerQuestion"]["dense"][0]
        self.assertEqual(row["unpooledReturnedCount@5"], 1)
        self.assertIsNone(row["ndcg@5"])
        self.assertEqual(result["metricsByMethod"]["dense"]["metricQuestionCounts"]["ndcg@5"], 0)


if __name__ == "__main__":
    unittest.main()
