from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from huiyi_health_engine.memory.schemas import (
    MemoryCommitResult,
    MemoryCommitRequest,
    MemoryForgetResult,
    MemoryForgetRequest,
    MemoryRecallRequest,
    MemorySessionEndResult,
    MemorySessionEndRequest,
    MemorySnapshot,
    MemoryStats,
)
from huiyi_health_engine.memory.service import (
    CommitOutcome,
    MemoryService,
    RecallOutcome,
    SessionEndOutcome,
    namespace_for_user,
)


class FakeBackend:
    def __init__(self) -> None:
        self.commits: list[tuple[str, str, str]] = []
        self.session_ends: list[tuple[str, str]] = []
        self.fail_commit = False
        self.records: dict[str, dict[str, int]] = {}

    def recall(self, namespace: str, query: str, strong: bool) -> RecallOutcome:
        del query, strong
        return RecallOutcome([], 1, False, 2)

    def commit_turn(self, namespace: str, user_text: str, assistant_text: str) -> CommitOutcome:
        if self.fail_commit:
            raise RuntimeError("private content must not appear in logs")
        self.commits.append((namespace, user_text, assistant_text))
        counts = self.records.setdefault(namespace, {"raw": 0, "facts": 0, "episodes": 0})
        counts["raw"] += 2
        counts["facts"] += 1
        return CommitOutcome(2, 1, 0, 2, False, False)

    def session_end(self, namespace: str, session_id: str) -> SessionEndOutcome:
        self.session_ends.append((namespace, session_id))
        return SessionEndOutcome(True, False, 1)

    def stats(self, namespace: str, user_id: str) -> MemoryStats:
        counts = self.records.get(namespace, {"raw": 0, "facts": 0, "episodes": 0})
        return MemoryStats(userId=user_id, memoryWindowItems=0, records=counts)

    def forget(self, namespace: str) -> None:
        self.records[namespace] = {"raw": 0, "facts": 0, "episodes": 0}


class MemoryServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.backend = FakeBackend()
        self.service = MemoryService(self.backend, self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def commit_request(self, user_id: str = "patient-A") -> MemoryCommitRequest:
        return MemoryCommitRequest(
            idempotencyKey="session-1:1",
            userId=user_id,
            sessionId="session-1",
            turn=1,
            userText="test user turn",
            assistantText="test assistant turn",
        )

    def test_namespaces_are_isolated_and_do_not_expose_identity(self) -> None:
        first = namespace_for_user("patient-A")
        second = namespace_for_user("patient-B")
        self.assertNotEqual(first, second)
        self.assertNotIn("patient-A", first)
        self.assertEqual(len(first), 38)

    def test_idempotency_ledger_can_live_outside_a_frozen_ama_store(self) -> None:
        ledger_path = Path(self.temp_dir.name) / "metadata" / "ledger.sqlite3"
        store_path = Path(self.temp_dir.name) / "ama-state"
        isolated = MemoryService(FakeBackend(), store_path, ledger_path=ledger_path)
        self.assertTrue(ledger_path.is_file())
        self.assertFalse((store_path / "health-engine.sqlite3").exists())
        self.assertEqual(isolated.ledger_path, ledger_path.resolve())

    def test_completed_commit_is_idempotent_across_service_restart(self) -> None:
        first = self.service.commit_turn(self.commit_request())
        restarted_backend = FakeBackend()
        restarted = MemoryService(restarted_backend, self.temp_dir.name)
        duplicate = restarted.commit_turn(self.commit_request())
        self.assertEqual(first.status, "committed")
        self.assertEqual(duplicate.status, "duplicate")
        self.assertTrue(duplicate.duplicate)
        self.assertEqual(restarted_backend.commits, [])

    def test_same_session_and_turn_under_different_users_are_distinct(self) -> None:
        self.service.commit_turn(self.commit_request("patient-A"))
        result = self.service.commit_turn(self.commit_request("patient-B"))
        self.assertEqual(result.status, "committed")
        self.assertEqual(len(self.backend.commits), 2)
        self.assertNotEqual(self.backend.commits[0][0], self.backend.commits[1][0])

    def test_failed_commit_is_not_replayed(self) -> None:
        self.backend.fail_commit = True
        with self.assertRaises(RuntimeError):
            self.service.commit_turn(self.commit_request())
        duplicate = self.service.commit_turn(self.commit_request())
        self.assertEqual(duplicate.status, "failed")
        self.assertTrue(duplicate.duplicate)
        self.assertEqual(self.backend.commits, [])

    def test_session_end_skip_is_idempotent(self) -> None:
        request = MemorySessionEndRequest(userId="patient-A", sessionId="session-1")
        first = self.service.session_end(request)
        duplicate = self.service.session_end(request)
        self.assertEqual(first.status, "skipped")
        self.assertEqual(duplicate.status, "duplicate")
        self.assertEqual(len(self.backend.session_ends), 1)

    def test_forget_clears_only_the_requested_namespace(self) -> None:
        self.backend.records[namespace_for_user("patient-A")] = {"raw": 4, "facts": 2, "episodes": 1}
        self.backend.records[namespace_for_user("patient-B")] = {"raw": 3, "facts": 1, "episodes": 1}
        result = self.service.forget(MemoryForgetRequest(
            userId="patient-A", confirmation="forget all patient memory"
        ))
        self.assertEqual(result.recordsRemoved, 7)
        self.assertEqual(self.service.stats("patient-B").records["raw"], 3)

    def test_recall_contract_includes_turn_and_cost_metadata(self) -> None:
        snapshot = self.service.recall(MemoryRecallRequest(
            userId="patient-A", sessionId="session-1", turn=2, query="what was reported?"
        ))
        self.assertEqual(snapshot.userId, "patient-A")
        self.assertEqual(snapshot.turn, 2)
        self.assertEqual(snapshot.retrievalRounds, 1)
        self.assertEqual(snapshot.amaLlmCallCount, 2)
        self.assertEqual(snapshot.items, [])

    def test_shared_fixture_matches_python_http_schemas(self) -> None:
        fixture_path = Path(__file__).resolve().parents[3] / "fixtures" / "memory-contracts.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        validations = (
            (MemoryRecallRequest, "recallRequest"),
            (MemorySnapshot, "snapshot"),
            (MemoryCommitRequest, "commitRequest"),
            (MemoryCommitResult, "commitResult"),
            (MemorySessionEndRequest, "sessionEndRequest"),
            (MemorySessionEndResult, "sessionEndResult"),
            (MemoryStats, "stats"),
            (MemoryForgetRequest, "forgetRequest"),
            (MemoryForgetResult, "forgetResult"),
        )
        for model, key in validations:
            with self.subTest(contract=key):
                model.model_validate(fixture[key])


if __name__ == "__main__":
    unittest.main()
