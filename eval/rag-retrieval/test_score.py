from __future__ import annotations

import unittest

from score import combine_serial_stage_latency_ms, score_run, validate_dataset, weighted_cohen_kappa


def _dataset() -> dict:
    return {
        "schemaVersion": "huiyi-rag-retrieval-dataset/v1",
        "datasetId": "pilot-fixture",
        "split": "dev",
        "corpusVersion": "fixture-v1",
        "questions": [
            {
                "questionId": "q1",
                "query": "query one",
                "language": "en",
                "taskCategory": "exact_term",
                "corpusVersion": "fixture-v1",
                "answerability": "answerable",
                "reviewStatus": "double_reviewed",
                "qrels": [
                    {"documentId": "d1", "relevance": 3, "applicability": "applicable"},
                    {"documentId": "d2", "relevance": 1, "applicability": "partly_applicable"},
                ],
                "annotations": [
                    {"reviewerId": "r1", "answerability": "answerable", "judgments": [{"documentId": "d1", "relevance": 3, "applicability": "applicable"}, {"documentId": "d2", "relevance": 1, "applicability": "partly_applicable"}]},
                    {"reviewerId": "r2", "answerability": "answerable", "judgments": [{"documentId": "d1", "relevance": 3, "applicability": "applicable"}, {"documentId": "d2", "relevance": 1, "applicability": "partly_applicable"}]},
                ],
                "candidatePool": [
                    {"documentId": "d1", "source": "textbooks", "candidateMethods": ["dense"]},
                    {"documentId": "d2", "source": "textbooks", "candidateMethods": ["bm25"]},
                ],
            },
            {
                "questionId": "q2",
                "query": "query two",
                "language": "zh",
                "taskCategory": "no_answer",
                "corpusVersion": "fixture-v1",
                "answerability": "no_answer",
                "reviewStatus": "adjudicated",
                "qrels": [],
                "annotations": [
                    {"reviewerId": "r1", "answerability": "no_answer", "judgments": []},
                    {"reviewerId": "r2", "answerability": "no_answer", "judgments": []},
                ],
            },
        ],
    }


class RetrievalScoringTests(unittest.TestCase):
    def test_sequential_stage_latency_sums_without_absorbing_cold_start(self) -> None:
        self.assertEqual(combine_serial_stage_latency_ms(277.4, 119.2), 396.6)
        with self.assertRaisesRegex(ValueError, "finite, non-negative"):
            combine_serial_stage_latency_ms(10, float("nan"))

    def test_metrics_and_missing_runs_keep_dataset_denominator(self) -> None:
        dataset = _dataset()
        run = {
            "schemaVersion": "huiyi-rag-retrieval-run/v1",
            "datasetId": "pilot-fixture",
            "corpusVersion": "fixture-v1",
            "method": "dense",
            "candidateBudget": 2,
            "queries": [
                {
                    "questionId": "q1",
                    "status": "ok",
                    "latencyMs": 10,
                    "results": [
                        {"documentId": "noise", "source": "pubmed", "score": 0.7},
                        {"documentId": "d1", "source": "textbooks", "score": 0.6},
                        {"documentId": "d1", "source": "textbooks", "score": 0.6},
                    ],
                }
            ],
        }
        result = score_run(dataset, run, "dataset-hash", "run-hash", [1, 2])
        self.assertEqual(result["questionCount"], 2)
        self.assertEqual(result["missingRunRecordCount"], 1)
        self.assertEqual(result["metricsByK"]["2"]["recall"], 1.0)
        self.assertEqual(result["metricsByK"]["1"]["mrr"], 0.0)
        self.assertAlmostEqual(result["metricsByK"]["2"]["ndcg"], 0.578764, places=6)
        self.assertEqual(result["noAnswer"]["queriesReturningAnyCandidate"], 0)
        self.assertEqual(result["annotatorAgreement"]["reviewerPairs"][0]["answerabilityExactAgreement"], 1.0)

    def test_unreviewed_qrels_are_not_scored(self) -> None:
        dataset = _dataset()
        dataset["questions"][0]["reviewStatus"] = "pending"
        with self.assertRaisesRegex(ValueError, "not double-reviewed"):
            validate_dataset(dataset)

    def test_duplicate_reviewer_id_does_not_satisfy_double_review(self) -> None:
        dataset = _dataset()
        dataset["questions"][0]["annotations"][1]["reviewerId"] = "r1"
        with self.assertRaisesRegex(ValueError, "duplicate reviewerId"):
            validate_dataset(dataset)

    def test_every_candidate_needs_one_vote_from_each_reviewer(self) -> None:
        dataset = _dataset()
        dataset["questions"][0]["annotations"][1]["judgments"].pop()
        with self.assertRaisesRegex(ValueError, "each reviewer must judge every candidate exactly once"):
            validate_dataset(dataset)

    def test_double_reviewed_qrels_must_match_consensus_votes(self) -> None:
        dataset = _dataset()
        dataset["questions"][0]["qrels"][0]["relevance"] = 1
        with self.assertRaisesRegex(ValueError, "final qrel differs from independent consensus"):
            validate_dataset(dataset)

    def test_disagreement_requires_adjudication_and_note(self) -> None:
        dataset = _dataset()
        question = dataset["questions"][0]
        question["annotations"][1]["judgments"][0]["relevance"] = 2
        with self.assertRaisesRegex(ValueError, "disagreement must be adjudicated"):
            validate_dataset(dataset)
        question["reviewStatus"] = "adjudicated"
        question["qrels"][0]["adjudicationNote"] = "Reviewer disagreement resolved by a third reviewer."
        validate_dataset(dataset)

    def test_corpus_mismatch_is_rejected(self) -> None:
        dataset = _dataset()
        run = {"schemaVersion": "huiyi-rag-retrieval-run/v1", "datasetId": "pilot-fixture", "corpusVersion": "other", "queries": []}
        with self.assertRaisesRegex(ValueError, "corpusVersion differ"):
            score_run(dataset, run, "d", "r", [5])

    def test_weighted_kappa_for_perfect_and_disagreeing_labels(self) -> None:
        self.assertEqual(weighted_cohen_kappa([0, 1, 2, 3], [0, 1, 2, 3]), 1.0)
        self.assertLess(weighted_cohen_kappa([0, 0, 3, 3], [3, 3, 0, 0]), 0)

    def test_failed_partial_output_scores_as_empty_and_stays_in_denominator(self) -> None:
        dataset = _dataset()
        run = {
            "schemaVersion": "huiyi-rag-retrieval-run/v1",
            "datasetId": "pilot-fixture",
            "corpusVersion": "fixture-v1",
            "method": "dense",
            "candidateBudget": 2,
            "queries": [
                {"questionId": "q1", "status": "timeout", "latencyMs": 30, "results": [{"documentId": "d1", "source": "textbooks"}]},
                {"questionId": "q2", "status": "ok", "latencyMs": 10, "results": []},
            ],
        }
        result = score_run(dataset, run, "d", "r", [1])
        self.assertEqual(result["executionSuccessRate"], 0.5)
        self.assertEqual(result["metricsByK"]["1"]["recall"], 0.0)


if __name__ == "__main__":
    unittest.main()
