from __future__ import annotations

import unittest

from score_judge_runs import _metrics


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


if __name__ == "__main__":
    unittest.main()
