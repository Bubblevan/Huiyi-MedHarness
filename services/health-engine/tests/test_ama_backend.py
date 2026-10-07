from __future__ import annotations

import tempfile
import unittest
from unittest.mock import patch

from huiyi_health_engine.memory.ama_backend import AmaBackendError, AmaMemoryBackend, _Counters, _parse_retrievals
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
