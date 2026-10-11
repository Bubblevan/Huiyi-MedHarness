from __future__ import annotations

import tempfile
import unittest
import json
import importlib
import sqlite3
from pathlib import Path
from unittest.mock import Mock, patch

from huiyi_health_engine.memory.ama_backend import AmaBackendError, AmaMemoryBackend, _Counters, _instrument, _parse_retrievals
from huiyi_health_engine.memory.schemas import MemoryStats
from huiyi_health_engine.memory.service import namespace_for_user


class AmaBackendTests(unittest.TestCase):
    def test_session_end_generates_first_episode_when_episode_table_is_empty(self) -> None:
        with tempfile.TemporaryDirectory() as data_dir:
            ama_class = AmaMemoryBackend(data_dir)._load_ama_class()
            memory = ama_class.__new__(ama_class)
            memory.user = "synthetic_patient"
            memory.episodeSql = "synthetic_patientEpisode"
            memory.memoryWindow = [{"role": "user", "content": "synthetic turn"}]
            memory.memoryAgent = Mock()
            memory.memoryAgent.inferenceGenerateEpisode.return_value = {"title": "synthetic episode"}
            memory.constructEpisodicWrite = Mock()
            memory.queryLastRecord = Mock(side_effect=[{"episode": 1}, None])

            memory.judgeAndGenerate()

        memory.memoryAgent.inferenceGenerateEpisode.assert_called_once()
        memory.constructEpisodicWrite.assert_called_once_with(data={"title": "synthetic episode"})

    def test_session_end_does_not_regenerate_existing_latest_episode(self) -> None:
        with tempfile.TemporaryDirectory() as data_dir:
            ama_class = AmaMemoryBackend(data_dir)._load_ama_class()
            memory = ama_class.__new__(ama_class)
            memory.user = "synthetic_patient"
            memory.episodeSql = "synthetic_patientEpisode"
            memory.memoryWindow = [{"role": "user", "content": "synthetic turn"}]
            memory.memoryAgent = Mock()
            memory.constructEpisodicWrite = Mock()
            memory.queryLastRecord = Mock(side_effect=[{"episode": 1}, {"id": 1}])

            memory.judgeAndGenerate()

        memory.memoryAgent.inferenceGenerateEpisode.assert_not_called()
        memory.constructEpisodicWrite.assert_not_called()

    def test_pinned_ama_model_uses_configured_local_request_timeout(self) -> None:
        class Response:
            def raise_for_status(self) -> None:
                return None

            def json(self) -> dict[str, object]:
                return {"choices": [{"message": {"content": "ok"}}]}

        with tempfile.TemporaryDirectory() as data_dir:
            AmaMemoryBackend(data_dir)._load_ama_class()
            model = importlib.import_module("Model.model")
            with patch.dict("os.environ", {"HUIYI_MEMORY_MODEL_TIMEOUT_SECONDS": "90"}):
                agent = model.memoryAgent()
                with patch.object(model.requests, "post", return_value=Response()) as post:
                    self.assertEqual(agent.inference([]), "ok")
            self.assertEqual(post.call_args.kwargs["timeout"], 90)

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

    def test_retrieval_normalization_drops_database_ids_but_preserves_source_references(self) -> None:
        records = _parse_retrievals(
            '{"retrievals":{"text_match_results":[{"id":7,"dia_id":"D1:2","content":"test-only history","timestamp":"2026-10-07","source":"user"}],'
            '"fact_match_results":[{"id":2,"content":"test-only fact","timestamp":"2026-10-07"},{}]},"memoryWindow":[]}'
        )
        self.assertEqual([item.kind for item in records], ["raw", "fact"])
        self.assertEqual(records[0].content, "test-only history")
        self.assertFalse(hasattr(records[0], "id"))
        self.assertEqual(records[0].sourceId, "D1:2")

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

    def test_benchmark_recall_isolates_transient_memory_window_between_questions(self) -> None:
        class FakeMemory:
            def __init__(self) -> None:
                self.memoryWindow: list[str] = []

            def clearMemoryWindow(self) -> None:
                self.memoryWindow.clear()

            def forwardRetrieve(self, query: str, **_kwargs: object) -> str:
                self.memoryWindow.append(query)
                return json.dumps({"retrievals": {"text_match_results": [{"content": query}]}, "memoryWindow": self.memoryWindow})

        with tempfile.TemporaryDirectory() as data_dir, patch.dict("os.environ", {"HUIYI_MEMORY_ISOLATE_RECALLS": "1"}):
            backend = AmaMemoryBackend(data_dir)
            namespace = namespace_for_user("locomo-isolated-recall-user")
            memory = FakeMemory()
            backend._instances[namespace] = memory
            backend._counters[namespace] = _Counters()

            with patch.object(backend, "_stats", return_value=MemoryStats(
                userId=namespace,
                memoryWindowItems=0,
                records={"raw": 1, "facts": 0, "episodes": 0},
            )):
                first = backend.recall(namespace, "question one", strong=True)
                second = backend.recall(namespace, "question two", strong=True)

        self.assertEqual([item.content for item in first.items], ["question one"])
        self.assertEqual([item.content for item in second.items], ["question two"])
        self.assertEqual(memory.memoryWindow, [])

    def test_empty_namespace_recall_skips_unnecessary_model_calls(self) -> None:
        class EmptyMemory:
            memoryWindow: list[str] = []

            def forwardRetrieve(self, *_args: object, **_kwargs: object) -> str:
                raise AssertionError("empty memory must not invoke the AMA model")

        with tempfile.TemporaryDirectory() as data_dir:
            backend = AmaMemoryBackend(data_dir)
            namespace = namespace_for_user("synthetic-empty-recall-user")
            backend._instances[namespace] = EmptyMemory()
            backend._counters[namespace] = _Counters()

            result = backend.recall(namespace, "synthetic question", strong=False)

        self.assertEqual(result.items, [])
        self.assertEqual(result.retrieval_rounds, 0)
        self.assertEqual(result.ama_llm_call_count, 0)

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
        _instrument(memory, counters, namespace="huiyi_test", capture_usage=True)

        memory.memoryAgent.inference([], showUsage=False)

        self.assertEqual(counters.snapshot()["llm_calls"], 1)
        self.assertEqual(counters.snapshot()["prompt_tokens"], 47)
        self.assertEqual(counters.snapshot()["completion_tokens"], 11)
        self.assertEqual(counters.snapshot()["usage_reports"], 1)

    def test_commit_returns_provider_token_deltas_for_per_turn_trace(self) -> None:
        class FakeMemoryAgent:
            promptToken = 0
            completionToken = 0

            def inference(self, *_args: object, showUsage: bool = False, **_kwargs: object) -> str:
                if showUsage:
                    self.promptToken += 47
                    self.completionToken += 11
                return "{}"

        class FakeMemory:
            raw_records = 0

            def __init__(self, **_kwargs: object):
                self.memoryWindow: list[str] = []
                self.memoryAgent = FakeMemoryAgent()

            def forwardUser(self, *_args: object, **_kwargs: object) -> None:
                type(self).raw_records += 1
                self.memoryAgent.inference([], showUsage=False)

            def forwardRobot(self, *_args: object, **_kwargs: object) -> None:
                raise AssertionError("assistant output must not be persisted as patient history")

            def retrieve(self, *_args: object, **_kwargs: object) -> None: return None
            def refresh(self, *_args: object, **_kwargs: object) -> None: return None
            def constructEpisodicWrite(self, *_args: object, **_kwargs: object) -> None: return None

        with tempfile.TemporaryDirectory() as data_dir, patch.dict("os.environ", {"HUIYI_MEMORY_CAPTURE_USAGE": "1"}):
            backend = AmaMemoryBackend(data_dir)
            backend._ama_class = FakeMemory

            def stats(_namespace: str, user_id: str) -> MemoryStats:
                return MemoryStats(userId=user_id, memoryWindowItems=0, records={"raw": FakeMemory.raw_records, "facts": 0, "episodes": 0})

            with patch.object(backend, "_stats", side_effect=stats):
                outcome = backend.commit_turn(namespace_for_user("synthetic-usage-user"), "synthetic input", "synthetic output")

        self.assertEqual(outcome.ama_llm_call_count, 1)
        self.assertEqual(outcome.ama_prompt_tokens, 47)
        self.assertEqual(outcome.ama_completion_tokens, 11)
        self.assertEqual(outcome.ama_usage_report_count, 1)

    def test_optional_memory_llm_trace_is_phase_labeled_and_metadata_only(self) -> None:
        class FakeMemoryAgent:
            promptToken = 0
            completionToken = 0

            def inference(self, messages: list[dict[str, str]], showUsage: bool = False) -> str:
                if showUsage:
                    self.promptToken += 31
                    self.completionToken += 5
                return "{\"operator\": -1}"

            def inferenceRetrieve(self, messages: list[dict[str, str]], showUsage: bool = False) -> str:
                return self.inference(messages, showUsage=showUsage)

        class FakeMemory:
            memoryAgent = FakeMemoryAgent()

            def retrieve(self, *_args: object, **_kwargs: object) -> None:
                return None

            def refresh(self, *_args: object, **_kwargs: object) -> None:
                return None

            def constructEpisodicWrite(self, *_args: object, **_kwargs: object) -> None:
                return None

        with tempfile.TemporaryDirectory() as temp_dir, patch.dict("os.environ", {
            "HUIYI_MEMORY_LLM_TRACE_FILE": str(Path(temp_dir) / "memory-calls.jsonl"),
        }), patch.dict("os.environ", {"HUIYI_MEMORY_CAPTURE_USAGE": "1"}):
            memory = FakeMemory()
            counters = _Counters()
            _instrument(memory, counters, namespace="huiyi_test", capture_usage=True)
            memory.memoryAgent.inferenceRetrieve([{"content": "synthetic sensitive text"}], showUsage=False)
            trace_line = (Path(temp_dir) / "memory-calls.jsonl").read_text(encoding="utf-8")

        record = json.loads(trace_line)
        self.assertEqual(record["phase"], "memory-retrieval-decision")
        self.assertEqual(record["requestedMaxTokens"], None)
        self.assertEqual(record["promptTokens"], 31)
        self.assertEqual(record["outputTokens"], 5)
        self.assertEqual(record["status"], "completed")
        self.assertNotIn("synthetic sensitive text", trace_line)
        self.assertNotIn("operator", trace_line)

    def test_session_end_for_empty_user_skips_without_model_calls(self) -> None:
        with tempfile.TemporaryDirectory() as data_dir:
            backend = AmaMemoryBackend(data_dir)
            result = backend.session_end(namespace_for_user("synthetic-empty-user"), "synthetic-session")
        self.assertTrue(result.skipped)
        self.assertFalse(result.episode_generated)
        self.assertEqual(result.ama_llm_call_count, 0)

    def test_forget_invalidates_cached_ama_instance_before_next_commit(self) -> None:
        class FakeMemoryAgent:
            def inference(self, *_args: object, **_kwargs: object) -> str:
                return "{}"

        class FakeMemory:
            live_tables: set[str] = set()
            writes = 0

            def __init__(self, *, user: str, **_kwargs: object):
                self.user = user
                self.memoryWindow: list[str] = []
                self.memoryAgent = FakeMemoryAgent()
                self.live_tables.add(user)

            def clearAllMemory(self) -> None:
                self.live_tables.discard(self.user)
                self.memoryWindow.clear()

            def forwardUser(self, _user_text: str, **_kwargs: object) -> None:
                if self.user not in self.live_tables:
                    raise sqlite3.OperationalError("no such table")
                type(self).writes += 1
                self.memoryAgent.inference()

            def retrieve(self, *_args: object, **_kwargs: object) -> None: return None
            def refresh(self, *_args: object, **_kwargs: object) -> None: return None
            def constructEpisodicWrite(self, *_args: object, **_kwargs: object) -> None: return None

        with tempfile.TemporaryDirectory() as data_dir:
            backend = AmaMemoryBackend(data_dir)
            backend._ama_class = FakeMemory
            namespace = namespace_for_user("synthetic-forget-cache-user")
            FakeMemory.live_tables.clear()
            FakeMemory.writes = 0

            backend.forget(namespace)

            def stats(_namespace: str, user_id: str) -> MemoryStats:
                return MemoryStats(
                    userId=user_id,
                    memoryWindowItems=0,
                    records={"raw": FakeMemory.writes, "facts": 0, "episodes": 0},
                )

            with patch.object(backend, "_stats", side_effect=stats):
                outcome = backend.commit_turn(namespace, "synthetic user", "synthetic answer")

        self.assertEqual(outcome.raw_count, 1)
        self.assertEqual(FakeMemory.writes, 1)
        self.assertIn(namespace, FakeMemory.live_tables)


if __name__ == "__main__":
    unittest.main()
