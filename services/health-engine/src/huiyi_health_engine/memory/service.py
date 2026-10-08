from __future__ import annotations

import hashlib
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .schemas import (
    MemoryCommitRequest,
    MemoryCommitResult,
    MemoryForgetRequest,
    MemoryForgetResult,
    MemoryItem,
    MemoryRecallRequest,
    MemorySessionEndRequest,
    MemorySessionEndResult,
    MemorySnapshot,
    MemoryStats,
)


@dataclass(frozen=True)
class RecallOutcome:
    items: list[MemoryItem]
    retrieval_rounds: int
    refresh_triggered: bool
    ama_llm_call_count: int
    ama_prompt_tokens: int = 0
    ama_completion_tokens: int = 0
    ama_usage_report_count: int = 0


@dataclass(frozen=True)
class CommitOutcome:
    raw_count: int
    fact_count: int
    episode_count: int
    ama_llm_call_count: int
    refresh_triggered: bool
    episode_generated: bool


@dataclass(frozen=True)
class SessionEndOutcome:
    skipped: bool
    episode_generated: bool
    ama_llm_call_count: int


class MemoryBackend(Protocol):
    def recall(self, namespace: str, query: str, strong: bool) -> RecallOutcome: ...
    def commit_turn(self, namespace: str, user_text: str, assistant_text: str) -> CommitOutcome: ...
    def session_end(self, namespace: str, session_id: str) -> SessionEndOutcome: ...
    def stats(self, namespace: str, user_id: str) -> MemoryStats: ...
    def forget(self, namespace: str) -> None: ...


class MemoryConflictError(RuntimeError):
    """An idempotent operation already started and must not be replayed."""


class MemoryService:
    """Huiyi semantics and idempotency, independent of AMA internals."""

    def __init__(self, backend: MemoryBackend, data_dir: str | Path, ledger_path: str | Path | None = None):
        self.backend = backend
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        configured_ledger = ledger_path or os.environ.get("HUIYI_MEMORY_LEDGER_PATH")
        self.ledger_path = (
            Path(configured_ledger).expanduser().resolve()
            if configured_ledger
            else self.data_dir / "health-engine.sqlite3"
        )
        self.ledger_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize_ledger()

    def recall(self, request: MemoryRecallRequest) -> MemorySnapshot:
        namespace = namespace_for_user(request.userId)
        outcome = self.backend.recall(namespace, request.query, request.strong)
        return MemorySnapshot(
            snapshotId=str(uuid.uuid4()),
            userId=request.userId,
            sessionId=request.sessionId,
            turn=request.turn,
            items=outcome.items,
            tokenEstimate=estimate_tokens(outcome.items),
            retrievalRounds=outcome.retrieval_rounds,
            refreshTriggered=outcome.refresh_triggered,
            amaLlmCallCount=outcome.ama_llm_call_count,
            amaPromptTokens=outcome.ama_prompt_tokens,
            amaCompletionTokens=outcome.ama_completion_tokens,
            amaUsageReportCount=outcome.ama_usage_report_count,
        )

    def commit_turn(self, request: MemoryCommitRequest) -> MemoryCommitResult:
        expected_key = f"{request.sessionId}:{request.turn}"
        if request.idempotencyKey != expected_key:
            raise ValueError("idempotencyKey must equal sessionId:turn")

        namespace = namespace_for_user(request.userId)
        op_key = digest(f"{request.userId}:{request.idempotencyKey}")
        with self._lock, self._connect() as connection:
            existing = connection.execute(
                "SELECT status, result_json FROM commit_ledger WHERE op_key = ?",
                (op_key,),
            ).fetchone()
            if existing is not None:
                status, result_json = existing
                if status == "committed" and result_json:
                    prior = MemoryCommitResult.model_validate_json(result_json)
                    return prior.model_copy(update={"status": "duplicate", "duplicate": True})
                if status == "failed":
                    return MemoryCommitResult(status="failed", duplicate=True)
                raise MemoryConflictError("commit is already in progress; it will not be replayed")
            connection.execute(
                "INSERT INTO commit_ledger(op_key, user_key, session_key, turn, status) VALUES (?, ?, ?, ?, 'in_progress')",
                (op_key, digest(request.userId), digest(request.sessionId), request.turn),
            )

        try:
            outcome = self.backend.commit_turn(namespace, request.userText, request.assistantText)
            result = MemoryCommitResult(
                status="committed",
                duplicate=False,
                rawCount=outcome.raw_count,
                factCount=outcome.fact_count,
                episodeCount=outcome.episode_count,
                amaLlmCallCount=outcome.ama_llm_call_count,
                refreshTriggered=outcome.refresh_triggered,
                episodeGenerated=outcome.episode_generated,
            )
        except Exception as exc:
            with self._lock, self._connect() as connection:
                connection.execute(
                    "UPDATE commit_ledger SET status='failed', error_class=? WHERE op_key=?",
                    (type(exc).__name__, op_key),
                )
            raise

        with self._lock, self._connect() as connection:
            connection.execute(
                "UPDATE commit_ledger SET status='committed', result_json=? WHERE op_key=?",
                (result.model_dump_json(), op_key),
            )
        return result

    def session_end(self, request: MemorySessionEndRequest) -> MemorySessionEndResult:
        namespace = namespace_for_user(request.userId)
        op_key = digest(f"session-end:{request.userId}:{request.sessionId}")
        with self._lock, self._connect() as connection:
            existing = connection.execute(
                "SELECT status, result_json FROM session_end_ledger WHERE op_key=?",
                (op_key,),
            ).fetchone()
            if existing is not None:
                status, result_json = existing
                if status in {"completed", "skipped"} and result_json:
                    prior = MemorySessionEndResult.model_validate_json(result_json)
                    return prior.model_copy(update={"status": "duplicate", "duplicate": True})
                if status == "failed":
                    return MemorySessionEndResult(status="failed", duplicate=True)
                raise MemoryConflictError("session-end operation is already in progress")
            connection.execute(
                "INSERT INTO session_end_ledger(op_key, user_key, session_key, status) VALUES (?, ?, ?, 'in_progress')",
                (op_key, digest(request.userId), digest(request.sessionId)),
            )

        try:
            outcome = self.backend.session_end(namespace, request.sessionId)
            status = "skipped" if outcome.skipped else "completed"
            result = MemorySessionEndResult(
                status=status,
                duplicate=False,
                episodeGenerated=outcome.episode_generated,
                amaLlmCallCount=outcome.ama_llm_call_count,
            )
        except Exception as exc:
            with self._lock, self._connect() as connection:
                connection.execute(
                    "UPDATE session_end_ledger SET status='failed', error_class=? WHERE op_key=?",
                    (type(exc).__name__, op_key),
                )
            raise

        with self._lock, self._connect() as connection:
            connection.execute(
                "UPDATE session_end_ledger SET status=?, result_json=? WHERE op_key=?",
                (status, result.model_dump_json(), op_key),
            )
        return result

    def stats(self, user_id: str) -> MemoryStats:
        return self.backend.stats(namespace_for_user(user_id), user_id)

    def forget(self, request: MemoryForgetRequest) -> MemoryForgetResult:
        namespace = namespace_for_user(request.userId)
        before = self.backend.stats(namespace, request.userId)
        self.backend.forget(namespace)
        after = self.backend.stats(namespace, request.userId)
        removed = sum(before.records.values()) - sum(after.records.values())
        return MemoryForgetResult(status="forgotten", recordsRemoved=max(0, removed))

    def _initialize_ledger(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS commit_ledger (
                    op_key TEXT PRIMARY KEY,
                    user_key TEXT NOT NULL,
                    session_key TEXT NOT NULL,
                    turn INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    result_json TEXT,
                    error_class TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS session_end_ledger (
                    op_key TEXT PRIMARY KEY,
                    user_key TEXT NOT NULL,
                    session_key TEXT NOT NULL,
                    status TEXT NOT NULL,
                    result_json TEXT,
                    error_class TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """
            )

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.ledger_path, timeout=10)
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()


def namespace_for_user(user_id: str) -> str:
    """Map arbitrary identity text to a bounded identifier safe for AMA table names."""
    return f"huiyi_{digest(user_id)[:32]}"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def estimate_tokens(items: list[MemoryItem]) -> int:
    # Conservative UTF-8 size estimate. It is not an exact Qwen tokenizer count.
    return sum(max(1, (len(item.content.encode("utf-8")) + 2) // 3) for item in items)
