from __future__ import annotations

import unittest

from common import included_questions, snapshot_payload
from compare import values_by_question
from score import validate_ids


class LocomoContractTests(unittest.TestCase):
    def test_category_five_is_excluded_and_included_question_ids_are_stable(self) -> None:
        dataset = [{
            "sample_id": "conv-test",
            "qa": [
                {"question": "first", "answer": "one", "category": 1},
                {"question": "excluded", "answer": "five", "category": 5},
                {"question": "third", "answer": "two", "category": 3},
            ],
        }]
        expected = included_questions(dataset)
        self.assertEqual([item["question_id"] for item in expected], ["conv-test:qa-0001", "conv-test:qa-0003"])
        self.assertEqual([item["category"] for item in expected], [1, 3])
        validate_ids([
            {"question_id": item["question_id"], "category": item["category"], "gold_answer": item["gold_answer"]}
            for item in expected
        ], expected, allow_partial=False)
        with self.assertRaises(ValueError):
            validate_ids([{"question_id": "conv-test:qa-0002", "category": 5, "gold_answer": "five"}], expected, allow_partial=True)

    def test_snapshot_reconstruction_keeps_three_groups_and_timestamps(self) -> None:
        payload = snapshot_payload([
            {"kind": "raw", "content": "raw line", "timestamp": "2023-01-01"},
            {"kind": "fact", "content": "fact line\ntimestamp:2023-01-02", "timestamp": "2023-01-02"},
            {"kind": "episode", "content": "episode line", "timestamp": "2023-01-03"},
        ])
        self.assertIn('"text_match_results"', payload)
        self.assertIn('"fact_match_results"', payload)
        self.assertIn('"episodes_results"', payload)
        self.assertIn('raw line\\ntimestamp:2023-01-01', payload)
        self.assertIn('episode line\\ntimestamp:2023-01-03', payload)

    def test_arm_comparison_supports_ab_gate_without_c_and_requires_identical_ids(self) -> None:
        row = {
            "question_id": "conv:qa-0001", "conversation_id": "conv", "category": 1,
            "question": "synthetic", "gold_answer": "same", "response": "answer",
            "retrieval_hash": "same", "snapshot_hash": "same", "retrieved_kinds": {},
            "latency_ms": {}, "qa_usage": {}, "model_step_count": 1,
            "automatic_recall_count": 1, "commit_status": "evaluation_read_only",
        }
        ab_arms = {name: {row["question_id"]: dict(row)} for name in ("A_UPSTREAM", "B_SIDECAR")}
        paired_ab = values_by_question(ab_arms)
        self.assertIsNone(paired_ab[0]["C_answer"])
        self.assertIsNone(paired_ab[0]["B_C_snapshot_equivalent"])
        arms = {name: {row["question_id"]: dict(row)} for name in ("A_UPSTREAM", "B_SIDECAR", "C_DSH")}
        self.assertTrue(values_by_question(arms)[0]["B_C_snapshot_equivalent"])
        arms["C_DSH"]["extra:qa-0002"] = dict(row, question_id="extra:qa-0002")
        with self.assertRaises(ValueError):
            values_by_question(arms)

    def test_arm_comparison_requires_identical_question_order(self) -> None:
        first = {"question_id": "conv:qa-0001", "category": 1, "gold_answer": "one", "response": "one"}
        second = {"question_id": "conv:qa-0002", "category": 1, "gold_answer": "two", "response": "two"}
        arms = {
            "A_UPSTREAM": {first["question_id"]: first, second["question_id"]: second},
            "B_SIDECAR": {second["question_id"]: second, first["question_id"]: first},
        }
        with self.assertRaisesRegex(ValueError, "different orders"):
            values_by_question(arms)


if __name__ == "__main__":
    unittest.main()
