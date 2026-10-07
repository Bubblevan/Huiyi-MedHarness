from __future__ import annotations

import contextlib
import importlib
import io
import os
import sqlite3
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any

from .schemas import MemoryItem, MemoryStats
from .service import CommitOutcome, RecallOutcome, SessionEndOutcome


class AmaBackendError(RuntimeError):
    """Sanitized upstream failure; never includes AMA stdout or patient text."""

    def __init__(self, error_class: str):
        self.error_class = error_class if error_class.isidentifier() else "UpstreamError"
        super().__init__(self.error_class)


@dataclass
class _Counters:
    llm_calls: int = 0
    retrievals: int = 0
    refreshes: int = 0
    episodes: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)

    def increment(self, name: str) -> None:
        with self.lock:
            setattr(self, name, getattr(self, name) + 1)

    def snapshot(self) -> dict[str, int]:
        with self.lock:
            return {
                "llm_calls": self.llm_calls,
                "retrievals": self.retrievals,
                "refreshes": self.refreshes,
                "episodes": self.episodes,
            }


class AmaMemoryBackend:
    """Adapter around the pinned AMA API. No upstream files are modified."""

    _lock = threading.RLock()

    def __init__(self, data_dir: str | Path):
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._instances: dict[str, Any] = {}
        self._counters: dict[str, _Counters] = {}
        self._ama_class: type[Any] | None = None

    def recall(self, namespace: str, query: str, strong: bool) -> RecallOutcome:
        with self._lock, self._quiet_ama_output():
            try:
                memory = self._get_instance(namespace)
                before = self._counters[namespace].snapshot()
                payload = memory.forwardRetrieve(query, showUsage=False, strongRetrieve=strong)
                retrievals = _parse_retrievals(payload)
                after = self._counters[namespace].snapshot()
                return RecallOutcome(
                    items=retrievals,
                    retrieval_rounds=max(0, after["retrievals"] - before["retrievals"]),
                    refresh_triggered=after["refreshes"] > before["refreshes"],
                    ama_llm_call_count=max(0, after["llm_calls"] - before["llm_calls"]),
                )
            except Exception as exc:
                raise AmaBackendError(type(exc).__name__) from None

    def commit_turn(self, namespace: str, user_text: str, assistant_text: str) -> CommitOutcome:
        with self._lock, self._quiet_ama_output():
            try:
                memory = self._get_instance(namespace)
                before_stats = self._stats(namespace, namespace)
                before = self._counters[namespace].snapshot()

                # AMA's documented capture lifecycle is the paired user/assistant
                # forward. It runs only after DSH has emitted a completed turn.
                memory.forwardUser(user_text, showUsage=False)
                memory.forwardRobot(assistant_text, showUsage=False)

                after_stats = self._stats(namespace, namespace)
                after = self._counters[namespace].snapshot()
                return CommitOutcome(
                    raw_count=max(0, after_stats.records["raw"] - before_stats.records["raw"]),
                    fact_count=max(0, after_stats.records["facts"] - before_stats.records["facts"]),
                    episode_count=max(0, after_stats.records["episodes"] - before_stats.records["episodes"]),
                    ama_llm_call_count=max(0, after["llm_calls"] - before["llm_calls"]),
                    refresh_triggered=after["refreshes"] > before["refreshes"],
                    episode_generated=after_stats.records["episodes"] > before_stats.records["episodes"],
                )
            except Exception as exc:
                raise AmaBackendError(type(exc).__name__) from None

    def session_end(self, namespace: str, session_id: str) -> SessionEndOutcome:
        del session_id  # AMA episode synthesis is scoped to its user store.
        with self._lock, self._quiet_ama_output():
            try:
                before_stats = self._stats(namespace, namespace)
                if before_stats.records["raw"] == 0:
                    return SessionEndOutcome(skipped=True, episode_generated=False, ama_llm_call_count=0)
                memory = self._get_instance(namespace)
                before = self._counters[namespace].snapshot()
                memory.judgeAndGenerate()
                after = self._counters[namespace].snapshot()
                after_stats = self._stats(namespace, namespace)
                return SessionEndOutcome(
                    skipped=after_stats.records["episodes"] == before_stats.records["episodes"],
                    episode_generated=after_stats.records["episodes"] > before_stats.records["episodes"],
                    ama_llm_call_count=max(0, after["llm_calls"] - before["llm_calls"]),
                )
            except Exception as exc:
                raise AmaBackendError(type(exc).__name__) from None

    def stats(self, namespace: str, user_id: str) -> MemoryStats:
        with self._lock:
            return self._stats(namespace, user_id)

    def forget(self, namespace: str) -> None:
        with self._lock, self._quiet_ama_output():
            try:
                memory = self._get_instance(namespace)
                memory.clearAllMemory()
                memory.clearMemoryWindow()
            except Exception as exc:
                raise AmaBackendError(type(exc).__name__) from None

    def _get_instance(self, namespace: str) -> Any:
        if namespace in self._instances:
            return self._instances[namespace]
        if self._ama_class is None:
            self._ama_class = self._load_ama_class()
        instance = self._ama_class(
            user=namespace,
            modelMemory=os.environ.get("HUIYI_LOCAL_LLM_MODEL", "Qwen/Qwen3-8B"),
            data_dir=str(self.data_dir),
        )
        counters = _Counters()
        _instrument(instance, counters)
        self._instances[namespace] = instance
        self._counters[namespace] = counters
        return instance

    def _load_ama_class(self) -> type[Any]:
        repo_root = Path(__file__).resolve().parents[5]
        ama_root = repo_root / "third_party" / "AMA" / "python" / "AdaptiveMemory"
        if not ama_root.is_dir():
            raise RuntimeError("pinned AMA snapshot is missing")
        ama_root_text = str(ama_root)
        if ama_root_text not in sys.path:
            sys.path.insert(0, ama_root_text)
        module = importlib.import_module("Core.AMA")
        return module.AMA

    def _stats(self, namespace: str, user_id: str) -> MemoryStats:
        names = {
            "raw": namespace,
            "facts": f"{namespace}Fact",
            "episodes": f"{namespace}Episode",
        }
        counts = {kind: 0 for kind in names}
        db_path = self.data_dir / "AMA.db"
        if db_path.exists():
            with sqlite3.connect(db_path, timeout=10) as connection:
                existing = {
                    row[0]
                    for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
                }
                for kind, table in names.items():
                    if table in existing:
                        quoted = '"' + table.replace('"', '""') + '"'
                        counts[kind] = int(connection.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0])
        memory = self._instances.get(namespace)
        window_items = len(memory.memoryWindow) if memory is not None else 0
        return MemoryStats(userId=user_id, memoryWindowItems=window_items, records=counts)

    @staticmethod
    @contextlib.contextmanager
    def _quiet_ama_output():
        # Upstream AMA prints retrieved and persisted text. Redirect under the
        # adapter's process-wide lock so patient content never reaches service logs.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            yield


def _instrument(memory: Any, counters: _Counters) -> None:
    original_inference = memory.memoryAgent.inference

    def counted_inference(*args: Any, **kwargs: Any) -> Any:
        counters.increment("llm_calls")
        response = original_inference(*args, **kwargs)
        if not isinstance(response, str) or not response.strip():
            raise AmaBackendError("EmptyLocalModelResponse")
        return response

    memory.memoryAgent.inference = counted_inference
    for method_name, counter_name in (
        ("retrieve", "retrievals"),
        ("refresh", "refreshes"),
        ("constructEpisodicWrite", "episodes"),
    ):
        original = getattr(memory, method_name)

        def counted(*args: Any, _original: Any = original, _counter: str = counter_name, **kwargs: Any) -> Any:
            counters.increment(_counter)
            return _original(*args, **kwargs)

        setattr(memory, method_name, counted)


def _parse_retrievals(payload: str) -> list[MemoryItem]:
    import json

    decoded = json.loads(payload)
    retrievals = decoded.get("retrievals", []) if isinstance(decoded, dict) else []
    typed: list[MemoryItem] = []
    if isinstance(retrievals, dict):
        groups = (
            ("raw", retrievals.get("text_match_results", [])),
            ("fact", retrievals.get("fact_match_results", [])),
            ("episode", retrievals.get("episodes_results", [])),
        )
    elif isinstance(retrievals, list):
        groups = (("raw", retrievals),)
    else:
        groups = ()

    seen: set[tuple[str, str, str | None]] = set()
    for kind, records in groups:
        if not isinstance(records, list):
            continue
        for record in records:
            if not isinstance(record, dict) or not isinstance(record.get("content"), str):
                continue
            content = record["content"].strip()
            item_kind = kind
            if isinstance(retrievals, list) and "diaNO" in record:
                item_kind = "fact"
            if kind == "episode":
                try:
                    episode = json.loads(content)
                    if isinstance(episode, dict) and isinstance(episode.get("content"), str):
                        content = episode["content"].strip()
                except json.JSONDecodeError:
                    pass
            if not content:
                continue
            timestamp = record.get("timestamp")
            timestamp = timestamp if isinstance(timestamp, str) else None
            key = (item_kind, content, timestamp)
            if key in seen:
                continue
            seen.add(key)
            source = record.get("source")
            typed.append(MemoryItem(
                kind=item_kind,
                content=content,
                timestamp=timestamp,
                source=source if isinstance(source, str) else None,
            ))
    return typed
