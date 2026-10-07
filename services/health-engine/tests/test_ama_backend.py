from __future__ import annotations

import tempfile
import unittest
import json
from unittest.mock import patch

from huiyi_health_engine.memory.ama_backend import AmaBackendError, AmaMemoryBackend, _Counters, _instrument, _parse_retrievals
from huiyi_health_engine.memory.schemas import MemoryStats
from huiyi_health_engine.memory.service import namespace_for_user


class AmaBackendTests(unittest.TestCase):
    def test_pinned_ama_initializes_user_isolated_sqlite_and_faiss_store(self) -> None:
        with tempfile.TemporaryDirectory() as data_dir:
            backend = AmaMemoryBackend(data_dir)
            namespace = namespace_for_user("synthetic-user-a")
            with backend._lock, backend._quiet_ama_output():
                backend._get_instance(namespace)
            stats = backend.stats(namespace, "synthetic-user-a")

            self.assertEqual(stats.records, {"raw": 0, "facts": 0, "episodes": 0})
            self.assertTrue((backend.data_dir / "AMA.db").exists())
            for kind in ("text", "fact", "sentence"):
                self.assertTrue((backend.data_dir / f"{namespace}_{kind}_Index.faiss").exists())

    def test_retrieval_normalization_drops_internal_ids_and_empty_records(self) -> None:
        records = _parse_retrievals(
            '{"retrievals":{"text_match_results":[{"id":7,"content":"test-only history","timestamp":"2026-10-07","source":"user"}],'
            '"fact_match_results":[{"id":2,"content":"test-only fact","timestamp":"2026-10-07"},{}]},"memoryWindow":[]}'
        )
        self.assertEqual([item.kind for item in records], ["raw", "fact"])
        self.assertEqual(records[0].content, "test-only history")
        self.assertFalse(hasattr(records[0], "id"))

    def test_retrieval_normalization_preserves_raw_fact_episode_text_and_timestamps(self) -> None:
        payload = json.dumps({
            "retrievals": {
                "text_match_results": [{"content": "raw turn\ntimestamp:2024-03-01 10:00:00"}],
                "fact_match_results": [{"content": "patient prefers tea\ntimestamp:2024-03-02 11:30:00"}],
                "episodes_results": [{"content": json.dumps({
                    "title": "A visit",
                    "content": "The patient discussed a visit.",
                    "timestamp": "2024-03-03 12:00:00",
                })}],
            },
        })

        records = _parse_retrievals(payload)

        self.assertEqual([item.kind for item in records], ["raw", "fact", "episode"])
        self.assertEqual(records[0].content, "raw turn\ntimestamp:2024-03-01 10:00:00")
        self.assertEqual(records[0].timestamp, "2024-03-01 10:00:00")
        self.assertEqual(records[1].content, "patient prefers tea\ntimestamp:2024-03-02 11:30:00")
        self.assertEqual(records[1].timestamp, "2024-03-02 11:30:00")
        self.assertEqual(records[2].content, "The patient discussed a visit.")
        self.assertEqual(records[2].timestamp, "2024-03-03 12:00:00")

    def test_benchmark_configuration_overrides_turn_retrieve_and_top_k(self) -> None:
        class FakeMemoryAgent:
            def inference(self, *_args: object, **_kwargs: object) -> str:
                return "ok"

            def inferenceRetrieve(self, *_args: object, **_kwargs: object) -> dict[str, object]:
                return {"operator": 3, "topK": 15}

        class FakeMemory:
            def __init__(self, **kwargs: object):
                self.kwargs = kwargs
                self.memoryAgent = FakeMemoryAgent()

            def retrieve(self, *_args: object, **_kwargs: object) -> None:
                return None

            def refresh(self, *_args: object, **_kwargs: object) -> None:
                return None

            def constructEpisodicWrite(self, *_args: object, **_kwargs: object) -> None:
                return None

        with tempfile.TemporaryDirectory() as data_dir, patch.dict("os.environ", {
            "HUIYI_MEMORY_TURN_RETRIEVE": "3",
            "HUIYI_MEMORY_TOP_K": "10",
        }):
            backend = AmaMemoryBackend(data_dir)
            backend._ama_class = FakeMemory
            memory = backend._get_instance(namespace_for_user("locomo-benchmark-user"))

        self.assertEqual(memory.kwargs["turnRetrieve"], 3)
        self.assertEqual(memory.memoryAgent.inferenceRetrieve()["topK"], 10)

    def test_benchmark_usage_capture_counts_local_provider_tokens(self) -> None:
        class FakeMemoryAgent:
            promptToken = 0
            completionToken = 0

            def inference(self, *_args: object, showUsage: bool = False, **_kwargs: object) -> str:
                if showUsage:
                    self.promptToken += 47
                    self.completionToken += 11
                return "{}"

        class FakeMemory:
            memoryAgent = FakeMemoryAgent()

            def retrieve(self, *_args: object, **_kwargs: object) -> None:
                return None

            def refresh(self, *_args: object, **_kwargs: object) -> None:
                return None

            def constructEpisodicWrite(self, *_args: object, **_kwargs: object) -> None:
                return None

        memory = FakeMemory()
        counters = _Counters()
        _instrument(memory, counters, capture_usage=True)

        memory.memoryAgent.inference([], showUsage=False)

        self.assertEqual(counters.snapshot()["llm_calls"], 1)
        self.assertEqual(counters.snapshot()["prompt_tokens"], 47)
        self.assertEqual(counters.snapshot()["completion_tokens"], 11)
        self.assertEqual(counters.snapshot()["usage_reports"], 1)

    def test_session_end_for_empty_user_skips_without_model_calls(self) -> None:
        with tempfile.TemporaryDirectory() as data_dir:
            backend = AmaMemoryBackend(data_dir)
            result = backend.session_end(namespace_for_user("synthetic-empty-user"), "synthetic-session")
        self.assertTrue(result.skipped)
        self.assertFalse(result.episode_generated)
        self.assertEqual(result.ama_llm_call_count, 0)

    def test_forward_robot_name_error_is_reported_even_if_write_was_observed(self) -> None:
        class FakeMemory:
            memoryWindow: list[dict[str, str]] = []
            raw_records = 0

            def forwardUser(self, _user_text: str, showUsage: bool = False) -> None:
                del showUsage

            def forwardRobot(self, _assistant_text: str, showUsage: bool = False) -> None:
                del showUsage
                self.raw_records += 1
                raise NameError("upstream failure")

        with tempfile.TemporaryDirectory() as data_dir:
            backend = AmaMemoryBackend(data_dir)
            namespace = namespace_for_user("synthetic-name-error-user")
            memory = FakeMemory()
            backend._instances[namespace] = memory
            backend._counters[namespace] = _Counters()

            def stats(_namespace: str, user_id: str) -> MemoryStats:
                return MemoryStats(
                    userId=user_id,
                    memoryWindowItems=len(memory.memoryWindow),
                    records={"raw": memory.raw_records, "facts": 0, "episodes": 0},
                )

            with patch.object(backend, "_stats", side_effect=stats):
                with self.assertRaises(AmaBackendError) as raised:
                    backend.commit_turn(namespace, "synthetic user", "synthetic answer")

        self.assertEqual(raised.exception.error_class, "NameError")
        self.assertEqual(memory.raw_records, 1)


if __name__ == "__main__":
    unittest.main()
