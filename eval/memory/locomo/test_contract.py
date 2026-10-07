from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from build_reference_store import session_plan
from common import included_questions, questions_for_state, snapshot_payload
from compare import values_by_question
from score import validate_ids


class LocomoContractTests(unittest.TestCase):
    def test_first_thirty_session_plan_is_an_explicit_dataset_order_prefix(self) -> None:
        dataset = [
            {"sample_id": "conv-a", "conversation": {"session_1": [{"text": "a1"}], "session_2": [{"text": "a2"}]}},
            {"sample_id": "conv-b", "conversation": {"session_1": [{"text": "b1"}], "session_2": [{"text": "b2"}], "session_3": [{"text": "b3"}]}},
        ]
        plan = session_plan(dataset, 4)
        keys = [f"{conv_id}:session-{session_number:02d}" for conv_id, _, session_number, _, _ in plan]
        self.assertEqual(keys, ["conv-a:session-01", "conv-a:session-02", "conv-b:session-01", "conv-b:session-02"])
        with self.assertRaises(SystemExit):
            session_plan(dataset, 6)

    def test_partial_state_scope_selects_identical_conversation_question_cohort(self) -> None:
        dataset = [
            {"sample_id": "conv-a", "qa": [{"question": "a", "answer": "a", "category": 1}]},
            {"sample_id": "conv-b", "qa": [{"question": "b", "answer": "b", "category": 2}]},
            {"sample_id": "conv-c", "qa": [{"question": "c", "answer": "c", "category": 3}]},
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            manifest = Path(temp_dir) / "frozen-state-manifest.json"
            manifest.write_text(json.dumps({"partial": True, "max_sessions": 30, "included_conversations": ["conv-a", "conv-c"]}), encoding="utf-8")
            questions = questions_for_state(dataset, manifest)
        self.assertEqual([row["question_id"] for row in questions], ["conv-a:qa-0001", "conv-c:qa-0001"])

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
            {"kind": "raw", "content": "raw line", "timestamp": "2023-01-01", "sourceId": "D1:2"},
            {"kind": "fact", "content": "fact line\ntimestamp:2023-01-02", "timestamp": "2023-01-02"},
            {"kind": "episode", "content": "episode line", "timestamp": "2023-01-03"},
        ])
        self.assertIn('"text_match_results"', payload)
        self.assertIn('"fact_match_results"', payload)
        self.assertIn('"episodes_results"', payload)
        self.assertIn('raw line\\ntimestamp:2023-01-01', payload)
        self.assertIn('"dia_id": "D1:2"', payload)
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

    def test_arm_comparison_checks_benchmark_source_references(self) -> None:
        base = {
            "question_id": "conv:qa-0001", "conversation_id": "conv", "category": 1,
            "gold_answer": "same", "response": "answer", "retrieval_hash": "same",
            "snapshot_hash": "same", "retrieved_items": [
                {"kind": "raw", "content_sha256": "content", "source_id": "D1:2"},
            ],
        }
        arms = {
            "A_UPSTREAM": {"conv:qa-0001": dict(base)},
            "B_SIDECAR": {"conv:qa-0001": dict(base)},
            "C_DSH": {"conv:qa-0001": dict(base)},
        }
        paired = values_by_question(arms)
        self.assertTrue(paired[0]["B_C_source_refs_equal"])
        arms["C_DSH"]["conv:qa-0001"]["retrieved_items"] = [
            {"kind": "raw", "content_sha256": "content", "source_id": "D1:3"},
        ]
        self.assertFalse(values_by_question(arms)[0]["B_C_source_refs_equal"])

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
