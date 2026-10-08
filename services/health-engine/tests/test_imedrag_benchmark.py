from __future__ import annotations

import threading
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from huiyi_health_engine.rag.benchmark.schemas import ImedragResearchRequest, input_projection
from huiyi_health_engine.rag.benchmark.service import (
    BenchmarkCancelled,
    ImedragResearchService,
    parse_upstream_query_list,
)
from huiyi_health_engine.rag.corpus import CorpusChunk
from huiyi_health_engine.rag.retriever import RetrievalCandidate


def request(**overrides: object) -> ImedragResearchRequest:
    values: dict[str, object] = {
        "caseId": "validation-0001",
        "question": "Question text",
        "options": {"A": "one", "B": "two", "C": "three", "D": "four"},
        "k": 4,
        "nRounds": 2,
        "nQueries": 1,
    }
    values.update(overrides)
    return ImedragResearchRequest.model_validate(values)


def test_inference_projection_rejects_gold_and_score_fields() -> None:
    with pytest.raises(ValidationError):
        request(goldAnswer="C")
    with pytest.raises(ValidationError):
        request(correctOption="C")
    with pytest.raises(ValidationError):
        request(evaluationScore=1)

    projected = input_projection(request())
    assert set(projected) == {"caseId", "question", "options", "k", "nRounds", "nQueries"}
    assert not {"goldAnswer", "correctOption", "evaluationScore"}.intersection(projected)


def test_query_parser_accepts_upstream_json_and_never_evaluates_python() -> None:
    assert parse_upstream_query_list('prefix {"output": ["  query one  ", "query two"]} suffix') == [
        "query one",
        "query two",
    ]
    with pytest.raises(ValueError):
        parse_upstream_query_list('{"output": __import__("os").system("false")}')


def test_official_follow_up_query_answer_history_accumulates(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeResponse:
        def __init__(self, content: str):
            self.content = content

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {
                "choices": [{"message": {"content": self.content}}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 5},
            }

    replies = iter([
        "## Analysis\nfind a focused topic\n## Queries\n1. first focused query",
        '{"output": ["first focused query"]}',
        "First observation.",
        "## Analysis\nuse the previous answer\n## Queries\n1. second focused query",
        '{"output": ["second focused query"]}',
        "Second observation.",
    ])
    requests: list[dict[str, object]] = []

    def fake_post(_url: str, *, headers: object, json: dict[str, object], timeout: float) -> FakeResponse:
        requests.append(json)
        return FakeResponse(next(replies))

    monkeypatch.setattr("huiyi_health_engine.rag.benchmark.service.requests.post", fake_post)

    chunk = CorpusChunk(
        corpus="textbooks",
        source_document_id="chapter",
        chunk_id="0",
        title="Reference",
        content="Source content.",
    )
    candidate = RetrievalCandidate(chunk, 0.75, "query", 1)

    class FakeRetriever:
        def search(self, query: str, top_k: int, retrieval_round: int) -> list[RetrievalCandidate]:
            return [candidate]

    settings = SimpleNamespace(
        request_timeout_ms=60000,
        planner_url="http://127.0.0.1:8000/v1/chat/completions",
        planner_model="paper-model",
        planner_api_key="local-only",
        planner_timeout_seconds=10,
        planner_max_tokens=512,
    )
    fake_rag = SimpleNamespace(
        settings=settings,
        retriever=FakeRetriever(),
        tokenizer=SimpleNamespace(truncate=lambda text, limit: text),
        corpus=SimpleNamespace(version="fixture-corpus"),
    )
    result = ImedragResearchService(fake_rag, context_length=128000).research(request())  # type: ignore[arg-type]

    assert result.roundsCompleted == 2
    assert result.generatedQueries == 2
    assert result.modelCalls == 6
    assert result.retrievalCalls == 2
    assert [item.answer for item in result.observations] == ["First observation.", "Second observation."]
    assert all(item.sources[0].sourceId == "textbooks:chapter:0" for item in result.observations)
    assert "Query: first focused query\nAnswer: First observation." in requests[3]["messages"][-1]["content"]
    assert "finalAnswer" not in result.model_dump()


def test_upstream_executes_all_parsed_queries_even_when_model_overgenerates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeResponse:
        def __init__(self, content: str):
            self.content = content

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {"choices": [{"message": {"content": self.content}}], "usage": {}}

    replies = iter([
        "## Queries\n1. requested query\n2. additionally generated query",
        '{"output": ["requested query", "additionally generated query"]}',
        "Observation one.",
        "Observation two.",
    ])
    monkeypatch.setattr(
        "huiyi_health_engine.rag.benchmark.service.requests.post",
        lambda *_args, **_kwargs: FakeResponse(next(replies)),
    )
    retrieved_queries: list[str] = []

    class FakeRetriever:
        def search(self, query: str, top_k: int, retrieval_round: int) -> list[RetrievalCandidate]:
            retrieved_queries.append(query)
            return []

    settings = SimpleNamespace(
        request_timeout_ms=60000,
        planner_url="http://127.0.0.1:8000/v1/chat/completions",
        planner_model="paper-model",
        planner_api_key="local-only",
        planner_timeout_seconds=10,
        planner_max_tokens=512,
    )
    fake_rag = SimpleNamespace(
        settings=settings,
        retriever=FakeRetriever(),
        tokenizer=SimpleNamespace(truncate=lambda text, limit: text),
        corpus=SimpleNamespace(version="fixture-corpus"),
    )

    result = ImedragResearchService(fake_rag, context_length=128000).research(
        request(nRounds=1, nQueries=1),
    )  # type: ignore[arg-type]

    assert retrieved_queries == ["requested query", "additionally generated query"]
    assert result.generatedQueries == 2
    assert result.retrievalCalls == 2
    assert result.roundsCompleted == 1


def test_cancellation_stops_before_any_model_request(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = SimpleNamespace(
        request_timeout_ms=60000,
        planner_url="http://127.0.0.1:8000/v1/chat/completions",
        planner_model="paper-model",
        planner_api_key="local-only",
        planner_timeout_seconds=10,
        planner_max_tokens=512,
    )
    fake_rag = SimpleNamespace(
        settings=settings,
        retriever=SimpleNamespace(search=lambda *_args: []),
        tokenizer=SimpleNamespace(truncate=lambda text, limit: text),
        corpus=SimpleNamespace(version="fixture-corpus"),
    )
    monkeypatch.setattr(
        "huiyi_health_engine.rag.benchmark.service.requests.post",
        lambda *_args, **_kwargs: pytest.fail("cancelled research must not call the model"),
    )
    cancelled = threading.Event()
    cancelled.set()
    with pytest.raises(BenchmarkCancelled):
        ImedragResearchService(fake_rag, 128000).research(request(), cancelled)  # type: ignore[arg-type]
