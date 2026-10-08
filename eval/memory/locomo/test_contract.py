from __future__ import annotations

import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from build_reference_store import session_plan
from bootstrap import bootstrap_summary
from common import CONTRACT_MANIFEST, citation_ref_validity, included_questions, load_dataset, questions_for_state, snapshot_payload, validate_full_dataset_contract, verify_embedding_endpoint, verify_local_model_endpoint
from compare import usage_summary, values_by_question, write_artifact_text
from prepare_complete_conversation_diagnostic import validate_complete_conversation_prefix
from run_sidecar import local_chat as sidecar_local_chat
from run_upstream import local_chat as upstream_local_chat, retrieve_question
from score import validate_ids


class LocomoContractTests(unittest.TestCase):
    def test_frozen_full_dataset_hash_and_scope(self) -> None:
        full_contract = json.loads(Path(__file__).with_name("manifest-hc-mem-003.json").read_text(encoding="utf-8"))
        with patch("common._CONTRACT", full_contract):
            dataset = load_dataset()
            scope = validate_full_dataset_contract(dataset)
        full_plan = session_plan(dataset, None)
        self.assertEqual(scope["conversation_count"], 10)
        self.assertEqual(scope["session_count"], 272)
        self.assertEqual(scope["dialogue_item_count"], 5882)
        self.assertEqual(scope["included_question_count"], 1540)
        self.assertEqual(scope["excluded_category_5_count"], 446)
        self.assertEqual(len(full_plan), 272)
        self.assertEqual(sum(len(item[4]) for item in full_plan), 5882)

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

    def test_complete_conversation_diagnostic_accepts_only_full_conversation_prefix(self) -> None:
        dataset = [
            {"sample_id": "conv-a", "conversation": {"session_1": [{"text": "a1"}], "session_2": [{"text": "a2"}]}},
            {"sample_id": "conv-b", "conversation": {"session_1": [{"text": "b1"}], "session_2": [{"text": "b2"}], "session_3": [{"text": "b3"}]}},
        ]
        manifest = {
            "dataset_sha256": "dataset-sha",
            "partial": True,
            "max_sessions": 2,
            "selected_session_keys": ["conv-a:session-01", "conv-a:session-02"],
            "completed_session_count": 2,
            "session_count": 2,
            "included_conversations": ["conv-a"],
            "conversation_count": 1,
            "dialogue_items": 2,
        }
        contract = {"requiredStoreScope": "complete-conversation-diagnostic", "dataset": {"sha256": "dataset-sha"}}
        keys = validate_complete_conversation_prefix(manifest, contract, dataset)
        self.assertEqual(keys, manifest["selected_session_keys"])

    def test_complete_conversation_diagnostic_rejects_partial_conversation(self) -> None:
        dataset = [
            {"sample_id": "conv-a", "conversation": {"session_1": [{"text": "a1"}], "session_2": [{"text": "a2"}]}},
            {"sample_id": "conv-b", "conversation": {"session_1": [{"text": "b1"}]}},
        ]
        manifest = {
            "dataset_sha256": "dataset-sha",
            "partial": True,
            "max_sessions": 1,
            "selected_session_keys": ["conv-a:session-01"],
            "completed_session_count": 1,
            "session_count": 1,
            "included_conversations": ["conv-a"],
            "conversation_count": 1,
            "dialogue_items": 1,
        }
        contract = {"requiredStoreScope": "complete-conversation-diagnostic", "dataset": {"sha256": "dataset-sha"}}
        with self.assertRaisesRegex(ValueError, "ends inside conv-a"):
            validate_complete_conversation_prefix(manifest, contract, dataset)

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

    def test_common_qa_cap_is_sent_to_upstream_and_sidecar_requests(self) -> None:
        response = type("Response", (), {
            "raise_for_status": lambda self: None,
            "json": lambda self: {
                "choices": [{"message": {"content": '{"answer":"ok"}'}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14},
            },
        })()
        for module, cap_module, local_chat in (
            ("run_upstream.requests.post", "run_upstream.QA_MAX_TOKENS", upstream_local_chat),
            ("run_sidecar.requests.post", "run_sidecar.QA_MAX_TOKENS", sidecar_local_chat),
        ):
            with self.subTest(module=module), patch(module, return_value=response) as request, patch(cap_module, 256):
                _text, _usage, _latency, finish_reason = local_chat("prompt", 1.0)
                self.assertEqual(finish_reason, "stop")
                self.assertEqual(request.call_args.kwargs["json"]["max_tokens"], 256)
                self.assertEqual(request.call_args.kwargs["json"]["seed"], 0)

    def test_citation_reference_validity_uses_only_provided_dia_ids(self) -> None:
        metrics = citation_ref_validity(
            '{"answer":"A","evidence":["D1:2","D9:9"]}',
            [{"sourceId": "D1:2"}],
            None,
        )
        self.assertEqual(metrics["reference_count"], 2)
        self.assertEqual(metrics["valid_reference_count"], 1)
        self.assertEqual(metrics["invalid_reference_count"], 1)
        self.assertEqual(metrics["invalid_ids"], ["D9:9"])

    def test_upstream_recall_clears_transient_window_before_each_question(self) -> None:
        events = []

        class FakeMemory:
            def clearMemoryWindow(self):
                events.append("clear")

            def forwardRetrieve(self, question, **kwargs):
                events.append((question, kwargs))
                return "{}"

        result = retrieve_question(FakeMemory(), "question N")
        self.assertEqual(result, "{}")
        self.assertEqual(events[0], "clear")
        self.assertEqual(events[1], ("question N", {"showUsage": True, "strongRetrieve": True}))

    def test_private_artifact_writer_limits_pairwise_file_and_directory_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            private_root = Path(temp_dir) / "artifacts"
            private_root.mkdir()
            destination = private_root / "paired-diff.jsonl"
            with patch("compare.ARTIFACT_ROOT", private_root):
                write_artifact_text(destination, "private synthetic row\n")
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            self.assertEqual(destination.parent.stat().st_mode & 0o777, 0o700)

    def test_usage_summary_keeps_missing_token_counts_explicit_and_splits_capped_latency(self) -> None:
        arms = {
            "A_UPSTREAM": {
                "question-1": {
                    "qa_usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15},
                    "ama_prompt_tokens": 4,
                    "ama_completion_tokens": 1,
                    "ama_llm_call_count": 1,
                    "turn_reason": "completed",
                    "latency_ms": {"recall": 10, "answer_generation": 20, "end_to_end": 30},
                },
                "question-2": {
                    "qa_usage": {"prompt_tokens": None, "completion_tokens": None, "total_tokens": None},
                    "turn_reason": "max-tokens",
                    "latency_ms": {"recall": 11, "answer_generation": 40, "end_to_end": 51},
                },
            },
        }
        summary = usage_summary(arms)["A_UPSTREAM"]
        self.assertEqual(summary["qa_prompt_tokens"], 12)
        self.assertEqual(summary["qa_usage_missing_count"], 1)
        self.assertEqual(summary["latency_ms_by_turn_reason"]["completed"]["end_to_end"]["count"], 1)
        self.assertEqual(summary["latency_ms_by_turn_reason"]["max-tokens"]["end_to_end"]["count"], 1)

    def test_embedding_endpoint_probe_enforces_model_padded_dimension_and_finite_values(self) -> None:
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({
                    "model": "Qwen3-Embedding-0.6B",
                    "data": [{"embedding": [0.0] * 3072}],
                }).encode("utf-8")

        with patch.dict("os.environ", {"AMA_EMBEDDING_URL": "http://127.0.0.1:8324/_internal/ama/embeddings"}), \
                patch("urllib.request.urlopen", return_value=Response()) as urlopen:
            result = verify_embedding_endpoint()
        self.assertEqual(result["ama_dimension"], 3072)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:8324/_internal/ama/embeddings")

        class WrongDimension(Response):
            def read(self):
                return json.dumps({"model": "Qwen3-Embedding-0.6B", "data": [{"embedding": [float("nan")] * 3072}]}).encode("utf-8")

        with patch.dict("os.environ", {"AMA_EMBEDDING_URL": "http://127.0.0.1:8324/_internal/ama/embeddings"}), \
                patch("urllib.request.urlopen", return_value=WrongDimension()), \
                self.assertRaises(ValueError):
            verify_embedding_endpoint()

    def test_local_qwen_preflight_checks_the_served_vllm_version(self) -> None:
        contract = json.loads(CONTRACT_MANIFEST.read_text(encoding="utf-8"))

        class Response:
            def __init__(self, payload):
                self.payload = payload

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps(self.payload).encode("utf-8")

        responses = [
            Response({"data": [{
                "id": contract["models"]["qaGenerator"]["servedModelName"],
                "max_model_len": contract["models"]["qaGenerator"]["contextWindow"],
                "root": contract["models"]["qaGenerator"]["localPath"],
            }]}),
            Response({"version": contract["inferenceEngine"]["version"]}),
        ]
        with patch("common.verify_local_model_revisions"), patch("urllib.request.urlopen", side_effect=responses) as urlopen:
            verify_local_model_endpoint()
        self.assertEqual(urlopen.call_count, 2)
        self.assertTrue(urlopen.call_args_list[1].args[0].endswith("/version"))

    def test_paired_bootstrap_is_deterministic_and_reports_both_resampling_units(self) -> None:
        rows = [
            {"conversation_id": "conv-a", "A_token_f1": .1, "B_token_f1": .2, "C_token_f1": .3,
             "A_bleu1": .1, "B_bleu1": .15, "C_bleu1": .25},
            {"conversation_id": "conv-a", "A_token_f1": .3, "B_token_f1": .25, "C_token_f1": .4,
             "A_bleu1": .2, "B_bleu1": .25, "C_bleu1": .3},
            {"conversation_id": "conv-b", "A_token_f1": .4, "B_token_f1": .5, "C_token_f1": .45,
             "A_bleu1": .3, "B_bleu1": .35, "C_bleu1": .32},
        ]
        first = bootstrap_summary(rows, replicates=250, seed=3003)
        second = bootstrap_summary(rows, replicates=250, seed=3003)
        self.assertEqual(first, second)
        self.assertIn("question_level", first["comparisons"]["A_to_B"]["Token-F1"])
        self.assertIn("conversation_cluster", first["comparisons"]["B_to_C"]["BLEU-1"])

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
