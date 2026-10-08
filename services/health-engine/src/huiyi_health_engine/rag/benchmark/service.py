from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from typing import Any

import requests

from ..service import RagService
from .prompts import (
    I_MEDRAG_SYSTEM,
    PROMPT_VERSION,
    SIMPLE_MEDRAG_SYSTEM,
    QUERY_PARSE_PROMPT,
    format_follow_up_answer,
    format_question,
    format_query_planning,
)
from .schemas import (
    FollowUpObservation,
    ImedragResearchRequest,
    ImedragResearchResult,
    MedragDocument,
    MedragRetrievalRequest,
    MedragRetrievalResult,
    RetrievedSource,
)


class BenchmarkCancelled(RuntimeError):
    pass


class BenchmarkTimeout(RuntimeError):
    pass


class BenchmarkModelError(RuntimeError):
    pass


class ImedragResearchService:
    """Runs official-style iterative follow-up evidence acquisition, without a final answer."""

    def __init__(self, rag: RagService, context_length: int):
        if context_length < 1:
            raise ValueError("context_length must be positive")
        self.rag = rag
        self.context_length = context_length

    def research(
        self,
        request: ImedragResearchRequest,
        cancellation: threading.Event | None = None,
    ) -> ImedragResearchResult:
        settings = self.rag.settings
        started = time.perf_counter()
        deadline = time.monotonic() + settings.request_timeout_ms / 1000
        question_prompt = format_question(request.question, request.options)
        history = ""
        observations: list[FollowUpObservation] = []
        model_calls = 0
        retrieval_calls = 0
        generated_queries = 0
        parse_failures = 0
        input_tokens = 0
        output_tokens = 0
        model_latency_ms = 0.0
        retrieval_latency_ms = 0.0
        completed_rounds = 0

        max_iterations = request.nRounds + 3
        for _iteration in range(max_iterations):
            if completed_rounds >= request.nRounds:
                break
            self._check(cancellation, deadline)
            planning = format_query_planning(question_prompt, history, request.nQueries)
            text, usage, latency = self._chat(
                [
                    {"role": "system", "content": I_MEDRAG_SYSTEM},
                    {"role": "user", "content": planning},
                ], cancellation, deadline,
            )
            model_calls += 1
            input_tokens += usage[0]
            output_tokens += usage[1]
            model_latency_ms += latency

            if "## Queries" not in text:
                continue
            query_section = text.split("## Queries", 1)[1].strip()
            if not query_section:
                continue

            parser_prompt = QUERY_PARSE_PROMPT.format(passage=text)
            parsed_text, usage, latency = self._chat(
                [{"role": "user", "content": parser_prompt}], cancellation, deadline,
            )
            model_calls += 1
            input_tokens += usage[0]
            output_tokens += usage[1]
            model_latency_ms += latency
            try:
                queries = parse_upstream_query_list(parsed_text)
            except ValueError:
                parse_failures += 1
                continue

            # Match pinned upstream: nQueries is requested in the prompt, but
            # every query accepted by its parser is executed without truncation.
            round_number = completed_rounds + 1
            for query in queries:
                query = re.sub(r"^\d+\.\s*", "", query.strip())
                if not query:
                    continue
                self._check(cancellation, deadline)
                generated_queries += 1
                retrieve_started = time.perf_counter()
                candidates = self.rag.retriever.search(query, request.k, round_number)
                retrieval_latency_ms += (time.perf_counter() - retrieve_started) * 1000
                retrieval_calls += 1

                rendered_docs = [
                    f"Document [{rank}] (Title: {candidate.chunk.title}) {candidate.chunk.content}"
                    for rank, candidate in enumerate(candidates)
                ]
                context = "\n".join(rendered_docs) if rendered_docs else ""
                context = self._truncate_context(context)
                answer_prompt = format_follow_up_answer(context, query)
                answer, usage, latency = self._chat(
                    [
                        {"role": "system", "content": SIMPLE_MEDRAG_SYSTEM},
                        {"role": "user", "content": answer_prompt},
                    ], cancellation, deadline,
                )
                model_calls += 1
                input_tokens += usage[0]
                output_tokens += usage[1]
                model_latency_ms += latency
                answer_hash = hashlib.sha256(answer.encode("utf-8")).hexdigest()
                query_hash = hashlib.sha256(query.encode("utf-8")).hexdigest()
                source_rows = [
                    RetrievedSource(
                        sourceId=candidate.chunk.stable_id,
                        corpus=candidate.chunk.corpus,
                        sourceDocumentId=candidate.chunk.source_document_id,
                        chunkId=candidate.chunk.chunk_id,
                        rank=rank,
                        title=candidate.chunk.title,
                        score=candidate.score,
                    )
                    for rank, candidate in enumerate(candidates, start=1)
                ]
                observations.append(FollowUpObservation(
                    round=round_number,
                    query=query,
                    queryHash=query_hash,
                    answer=answer,
                    answerHash=answer_hash,
                    sources=source_rows,
                ))
                history += f"\n\nQuery: {query}\nAnswer: {answer}"
                history = history.strip()

            completed_rounds += 1

        self._check(cancellation, deadline)
        latency_ms = (time.perf_counter() - started) * 1000
        return ImedragResearchResult(
            caseId=request.caseId,
            history=history,
            roundsCompleted=completed_rounds,
            generatedQueries=generated_queries,
            modelCalls=model_calls,
            retrievalCalls=retrieval_calls,
            inputTokens=input_tokens,
            outputTokens=output_tokens,
            retrievalLatencyMs=round(retrieval_latency_ms, 1),
            modelLatencyMs=round(model_latency_ms, 1),
            observations=observations,
            corpusVersion=self.rag.corpus.version,
            plannerModel=settings.planner_model,
            promptVersion=PROMPT_VERSION,
            latencyMs=round(latency_ms, 1),
            parseFailures=parse_failures,
        )

    def _chat(
        self,
        messages: list[dict[str, str]],
        cancellation: threading.Event | None,
        deadline: float,
    ) -> tuple[str, tuple[int, int], float]:
        self._check(cancellation, deadline)
        settings = self.rag.settings
        payload: dict[str, Any] = {
            "model": settings.planner_model,
            "messages": messages,
            "temperature": 0.0,
        }
        if settings.planner_max_tokens > 0:
            payload["max_tokens"] = settings.planner_max_tokens
        remaining = max(0.1, deadline - time.monotonic())
        timeout = min(float(settings.planner_timeout_seconds), remaining)
        started = time.perf_counter()
        try:
            response = requests.post(
                settings.planner_url,
                headers={
                    "Authorization": f"Bearer {settings.planner_api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=timeout,
            )
            response.raise_for_status()
            body = response.json()
            message = body["choices"][0]["message"]["content"]
            if not isinstance(message, str):
                raise ValueError("completion content is not text")
            usage = body.get("usage", {})
            tokens = (
                _nonnegative_int(usage.get("prompt_tokens")),
                _nonnegative_int(usage.get("completion_tokens")),
            )
        except requests.Timeout:
            raise BenchmarkTimeout("i-MedRAG research model timed out") from None
        except Exception as exc:
            raise BenchmarkModelError(f"i-MedRAG research model failed ({type(exc).__name__})") from None
        self._check(cancellation, deadline)
        return message, tokens, (time.perf_counter() - started) * 1000

    def _truncate_context(self, context: str) -> str:
        return self.rag.tokenizer.truncate(context, self.context_length)

    @staticmethod
    def _check(cancellation: threading.Event | None, deadline: float) -> None:
        if cancellation is not None and cancellation.is_set():
            raise BenchmarkCancelled("i-MedRAG research was cancelled")
        if time.monotonic() >= deadline:
            raise BenchmarkTimeout("i-MedRAG research exceeded its request deadline")


class MedragRetrievalService:
    """One-shot retrieval for the pinned vanilla MedRAG DSH comparison arm."""

    def __init__(self, rag: RagService, context_length: int):
        if context_length < 1:
            raise ValueError("context_length must be positive")
        self.rag = rag
        self.context_length = context_length

    def retrieve(
        self,
        request: MedragRetrievalRequest,
        cancellation: threading.Event | None = None,
    ) -> MedragRetrievalResult:
        if cancellation is not None and cancellation.is_set():
            raise BenchmarkCancelled("MedRAG retrieval was cancelled")
        started = time.perf_counter()
        candidates = self.rag.retriever.search(request.question, request.topK, 1)
        if cancellation is not None and cancellation.is_set():
            raise BenchmarkCancelled("MedRAG retrieval was cancelled")
        documents = [
            MedragDocument(
                sourceId=candidate.chunk.stable_id,
                corpus=candidate.chunk.corpus,
                sourceDocumentId=candidate.chunk.source_document_id,
                chunkId=candidate.chunk.chunk_id,
                title=candidate.chunk.title,
                content=candidate.chunk.content,
                score=candidate.score,
            )
            for candidate in candidates
        ]
        rendered = [
            f"Document [{rank}] (Title: {candidate.chunk.title}) {candidate.chunk.content}"
            for rank, candidate in enumerate(candidates)
        ]
        context = "\n".join(rendered) if rendered else ""
        context = self.rag.tokenizer.truncate(context, self.context_length)
        return MedragRetrievalResult(
            caseId=request.caseId,
            documents=documents,
            context=context,
            corpusVersion=self.rag.corpus.version,
            retrievalLatencyMs=round((time.perf_counter() - started) * 1000, 1),
        )


def parse_upstream_query_list(text: str) -> list[str]:
    """Safely parse the pinned upstream JSON-list protocol without eval()."""
    decoder = json.JSONDecoder()
    candidates = [text.strip()]
    match = re.search(r'\{\s*"output"\s*:', text)
    if match:
        candidates.append(text[match.start():])
    for candidate in candidates:
        try:
            value, _end = decoder.raw_decode(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and isinstance(value.get("output"), list):
            queries = value["output"]
            if not all(isinstance(query, str) for query in queries):
                raise ValueError("query list contains a non-string value")
            return [query.strip() for query in queries]
    raise ValueError("upstream query parser response did not contain an output string list")


def _nonnegative_int(value: object) -> int:
    return value if isinstance(value, int) and value >= 0 else 0
