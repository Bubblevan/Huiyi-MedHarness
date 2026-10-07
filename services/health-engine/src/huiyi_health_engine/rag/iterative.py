from __future__ import annotations

import hashlib
import threading
import time
from dataclasses import dataclass, field

from .config import RagSettings
from .planner import PlannerError, QueryPlanner
from .retriever import MedCptRetriever, RetrievalCandidate


class OperationCancelled(RuntimeError):
    pass


class OperationTimeout(TimeoutError):
    pass


@dataclass
class AccumulatedCandidate:
    best: RetrievalCandidate
    first_round: int
    queries: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AcquisitionResult:
    requested_mode: str
    effective_mode: str
    rounds: int
    generated_queries: int
    generated_query_hashes: tuple[str, ...]
    candidate_count: int
    retrieval_calls: int
    planner_calls: int
    retrieval_latency_ms: float
    planner_latency_ms: float
    planner_input_tokens: int | None
    planner_output_tokens: int | None
    planner_prompt_version: str
    degraded: bool
    degraded_error_class: str | None
    candidates: tuple[AccumulatedCandidate, ...]


class IterativeEvidenceAcquirer:
    """Bounded i-MedRAG-derived search policy; this class never generates answers."""

    def __init__(self, settings: RagSettings, retriever: MedCptRetriever, planner: QueryPlanner):
        self.settings = settings
        self.retriever = retriever
        self.planner = planner

    def acquire(
        self,
        query: str,
        mode: str,
        candidate_k: int,
        cancellation: threading.Event | None = None,
        deadline: float | None = None,
    ) -> AcquisitionResult:
        if mode == "single":
            self._check(cancellation, deadline)
            retrieval_started = time.perf_counter()
            found = self.retriever.search(query, candidate_k, 1)
            retrieval_latency_ms = (time.perf_counter() - retrieval_started) * 1000
            accumulator = _accumulate(found)
            return AcquisitionResult(
                requested_mode=mode,
                effective_mode=mode,
                rounds=1,
                generated_queries=0,
                generated_query_hashes=(),
                candidate_count=len(found),
                retrieval_calls=1,
                planner_calls=0,
                retrieval_latency_ms=retrieval_latency_ms,
                planner_latency_ms=0.0,
                planner_input_tokens=None,
                planner_output_tokens=None,
                planner_prompt_version="",
                degraded=False,
                degraded_error_class=None,
                candidates=_rank(accumulator),
            )

        accumulator: dict[str, AccumulatedCandidate] = {}
        rounds = generated_queries = candidate_count = retrieval_calls = planner_calls = 0
        retrieval_latency_ms = planner_latency_ms = 0.0
        query_hashes: list[str] = []
        planner_input_tokens = planner_output_tokens = 0
        prompt_version = ""
        degraded = False
        error_class: str | None = None

        for round_number in range(1, self.settings.max_rounds + 1):
            self._check(cancellation, deadline)
            previous = [
                {
                    "evidenceId": f"E{index + 1}",
                    "title": item.best.chunk.title,
                    "snippet": item.best.chunk.content,
                }
                for index, item in enumerate(_rank(accumulator)[: self.settings.max_returned_evidence])
            ]
            planner_started = time.perf_counter()
            try:
                remaining = None if deadline is None else max(0.1, deadline - time.monotonic())
                plan = self.planner.plan(query, round_number, previous, timeout_seconds=remaining)
            except Exception as exc:
                planner_latency_ms += (time.perf_counter() - planner_started) * 1000
                self._check(cancellation, deadline)
                degraded = True
                error_class = type(exc).__name__
                if round_number == 1:
                    self._check(cancellation, deadline)
                    retrieval_started = time.perf_counter()
                    found = self.retriever.search(query, candidate_k, 1)
                    retrieval_latency_ms += (time.perf_counter() - retrieval_started) * 1000
                    _merge(accumulator, found)
                    candidate_count += len(found)
                    retrieval_calls += 1
                    rounds = 1
                    return AcquisitionResult(
                        requested_mode=mode,
                        effective_mode="single",
                        rounds=rounds,
                        generated_queries=generated_queries,
                        generated_query_hashes=tuple(query_hashes),
                        candidate_count=candidate_count,
                        retrieval_calls=retrieval_calls,
                        planner_calls=planner_calls + 1,
                        retrieval_latency_ms=retrieval_latency_ms,
                        planner_latency_ms=planner_latency_ms,
                        planner_input_tokens=planner_input_tokens or None,
                        planner_output_tokens=planner_output_tokens or None,
                        planner_prompt_version=prompt_version,
                        degraded=True,
                        degraded_error_class=error_class,
                        candidates=_rank(accumulator),
                    )
                break

            planner_latency_ms += (time.perf_counter() - planner_started) * 1000
            rounds = round_number
            planner_calls += 1
            prompt_version = plan.prompt_version
            if plan.input_tokens is not None:
                planner_input_tokens += plan.input_tokens
            if plan.output_tokens is not None:
                planner_output_tokens += plan.output_tokens
            generated_queries += len(plan.queries)
            query_hashes.extend(hashlib.sha256(item.encode("utf-8")).hexdigest() for item in plan.queries)

            for planned_query in plan.queries:
                self._check(cancellation, deadline)
                retrieval_started = time.perf_counter()
                found = self.retriever.search(planned_query, candidate_k, round_number)
                retrieval_latency_ms += (time.perf_counter() - retrieval_started) * 1000
                retrieval_calls += 1
                candidate_count += len(found)
                _merge(accumulator, found)

        return AcquisitionResult(
            requested_mode=mode,
            effective_mode=mode,
            rounds=rounds,
            generated_queries=generated_queries,
            generated_query_hashes=tuple(query_hashes),
            candidate_count=candidate_count,
            retrieval_calls=retrieval_calls,
            planner_calls=planner_calls + (1 if degraded and rounds < self.settings.max_rounds else 0),
            retrieval_latency_ms=retrieval_latency_ms,
            planner_latency_ms=planner_latency_ms,
            planner_input_tokens=planner_input_tokens or None,
            planner_output_tokens=planner_output_tokens or None,
            planner_prompt_version=prompt_version,
            degraded=degraded,
            degraded_error_class=error_class,
            candidates=_rank(accumulator),
        )

    @staticmethod
    def _check(cancellation: threading.Event | None, deadline: float | None) -> None:
        if cancellation is not None and cancellation.is_set():
            raise OperationCancelled("RAG request was cancelled")
        if deadline is not None and time.monotonic() >= deadline:
            raise OperationTimeout("RAG request exceeded its configured time budget")


def _accumulate(items: list[RetrievalCandidate]) -> dict[str, AccumulatedCandidate]:
    result: dict[str, AccumulatedCandidate] = {}
    _merge(result, items)
    return result


def _merge(target: dict[str, AccumulatedCandidate], items: list[RetrievalCandidate]) -> None:
    for item in items:
        key = item.chunk.stable_id
        existing = target.get(key)
        if existing is None:
            target[key] = AccumulatedCandidate(item, item.retrieval_round, [item.retrieval_query])
            continue
        if item.retrieval_query not in existing.queries:
            existing.queries.append(item.retrieval_query)
        if item.score > existing.best.score:
            existing.best = item
        existing.first_round = min(existing.first_round, item.retrieval_round)


def _rank(items: dict[str, AccumulatedCandidate]) -> list[AccumulatedCandidate]:
    return sorted(items.values(), key=lambda item: (-item.best.score, item.best.chunk.stable_id))
