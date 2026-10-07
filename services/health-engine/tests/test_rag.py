from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import numpy as np
import pytest

from huiyi_health_engine.rag.config import RagSettings
from huiyi_health_engine.rag.corpus import CorpusChunk, CorpusIndex, CorpusRepository, PreparedCorpus
from huiyi_health_engine.rag.iterative import IterativeEvidenceAcquirer, OperationCancelled, OperationTimeout
from huiyi_health_engine.rag.planner import PlannerError, QueryPlan, parse_query_plan
from huiyi_health_engine.rag.retriever import MedCptRetriever, RetrievalCandidate
from huiyi_health_engine.rag.schemas import EvidenceSet, MedicalEvidenceRequest
from huiyi_health_engine.rag.service import EvidenceTokenizer, RagService


def settings(tmp_path: Path, *, max_rounds: int = 2) -> RagSettings:
    return RagSettings(
        corpus_root=tmp_path,
        manifest_path=tmp_path / "manifest.json",
        query_encoder_path=tmp_path,
        query_encoder_device="cpu",
        query_max_length=512,
        tokenizer_path=None,
        planner_url="http://127.0.0.1:8000/v1/chat/completions",
        planner_model="local-qwen-test",
        planner_api_key="local-placeholder",
        planner_timeout_seconds=1,
        planner_max_tokens=64,
        default_mode="single",
        max_rounds=max_rounds,
        max_queries_per_round=2,
        candidates_per_query=3,
        max_returned_evidence=3,
        max_evidence_tokens=2048,
        request_timeout_ms=1000,
    )


class FakeIndex:
    ntotal = 1

    def search(self, _vector: np.ndarray, count: int):
        return np.array([[0.91][:count]], dtype=np.float32), np.array([[0][:count]], dtype=np.int64)


def prepared_corpus() -> PreparedCorpus:
    chunk = CorpusChunk(
        corpus="textbooks",
        source_document_id="Anatomy_Gray",
        chunk_id="0",
        title="Facial nerve anatomy",
        content="A source excerpt about facial nerve anatomy.",
    )
    return PreparedCorpus(
        version="medtext-fixture-v1",
        retriever_name="MedCPT",
        query_encoder_model="ncbi/MedCPT-Query-Encoder",
        query_encoder_revision="revision-query",
        article_encoder_model="ncbi/MedCPT-Article-Encoder",
        article_encoder_revision="revision-article",
        sources=({"name": "textbooks", "documentCount": 1, "chunkCount": 1},),
        indices=(CorpusIndex("textbooks", FakeIndex(), ({"source": "Anatomy_Gray", "index": 0},), {("Anatomy_Gray", 0): chunk}),),
        chunk_count=1,
    )


class FakeRetriever:
    def __init__(self, candidate: RetrievalCandidate | None):
        self.candidate = candidate
        self.calls: list[tuple[str, int, int]] = []

    def search(self, query: str, top_k: int, retrieval_round: int):
        self.calls.append((query, top_k, retrieval_round))
        return [] if self.candidate is None else [
            RetrievalCandidate(self.candidate.chunk, self.candidate.score, query, retrieval_round)
        ]


class FakePlanner:
    def __init__(self, plans: list[list[str]] | Exception):
        self.plans = plans
        self.calls = 0

    def plan(self, _question: str, _round: int, _previous: list[dict[str, str]], timeout_seconds=None):
        self.calls += 1
        if isinstance(self.plans, Exception):
            raise self.plans
        queries = self.plans[min(self.calls - 1, len(self.plans) - 1)]
        return QueryPlan(queries, "local-qwen-test", "test-prompt-v1", 2.5, 11, 7)


def make_candidate() -> RetrievalCandidate:
    return RetrievalCandidate(prepared_corpus().indices[0].chunks[("Anatomy_Gray", 0)], 0.91, "initial", 1)


def test_request_trims_and_rejects_empty_and_out_of_range_top_k():
    assert MedicalEvidenceRequest(query="  nerve  ").query == "nerve"
    with pytest.raises(ValueError):
        MedicalEvidenceRequest(query="   ")
    with pytest.raises(ValueError):
        MedicalEvidenceRequest(query="nerve", topK=0)


def test_structured_evidence_set_has_no_answer_field_and_accepts_empty_hits():
    result = EvidenceSet(
        query="unmatched",
        mode="single",
        hits=[],
        retrieval={
            "rounds": 1,
            "generatedQueries": 0,
            "uniqueDocuments": 0,
            "candidateCount": 0,
            "returnedEvidenceCount": 0,
            "retrievalCalls": 1,
            "plannerCalls": 0,
            "retrievalLatencyMs": 0,
            "plannerLatencyMs": 0,
            "latencyMs": 1,
            "estimatedContextTokens": 0,
            "plannerModel": "local-qwen-test",
            "plannerPromptVersion": "",
            "generatedQueryHashes": [],
            "degraded": False,
        },
        corpusVersion="fixture-v1",
    )
    value = result.model_dump(exclude_none=True)
    assert value["hits"] == []
    assert "finalAnswer" not in value and "diagnosis" not in value and "userResponse" not in value


def test_structured_planner_output_is_validated_and_bounded():
    assert parse_query_plan('{"queries":["nerve anatomy", "facial nerve"]}', 2) == ["nerve anatomy", "facial nerve"]
    assert parse_query_plan('{"queries":["nerve anatomy", "nerve anatomy"]}', 2) == ["nerve anatomy"]
    for malformed in ("not json", '{"answer":"A"}', '{"queries":["x", "y", "z"]}', '{"queries":[]}'):
        with pytest.raises(PlannerError):
            parse_query_plan(malformed, 2)


def test_iterative_rounds_are_bounded_and_duplicate_chunks_keep_query_provenance(tmp_path: Path):
    candidate = make_candidate()
    retriever = FakeRetriever(candidate)
    planner = FakePlanner([["focused search one"], ["focused search two"]])
    acquirer = IterativeEvidenceAcquirer(settings(tmp_path, max_rounds=2), retriever, planner)
    result = acquirer.acquire("medical question", "iterative", 3)
    assert result.rounds == 2
    assert result.generated_queries == 2
    assert result.planner_calls == 2
    assert result.retrieval_calls == 2
    assert result.retrieval_latency_ms >= 0
    assert result.planner_latency_ms >= 0
    assert result.candidate_count == 2
    assert len(result.candidates) == 1
    assert result.candidates[0].first_round == 1
    assert result.candidates[0].queries == ["focused search one", "focused search two"]
    assert len(result.generated_query_hashes) == 2


def test_planner_failure_falls_back_to_single_and_marks_degradation(tmp_path: Path):
    retriever = FakeRetriever(make_candidate())
    acquirer = IterativeEvidenceAcquirer(settings(tmp_path), retriever, FakePlanner(PlannerError("MalformedPlan")))
    result = acquirer.acquire("original query", "iterative", 3)
    assert result.effective_mode == "single"
    assert result.degraded is True
    assert result.degraded_error_class == "PlannerError"
    assert result.planner_calls == 1
    assert result.retrieval_calls == 1
    assert retriever.calls[0] == ("original query", 3, 1)


def test_cancellation_and_deadline_stop_before_more_retrieval(tmp_path: Path):
    acquirer = IterativeEvidenceAcquirer(settings(tmp_path), FakeRetriever(make_candidate()), FakePlanner([["query"]]))
    cancellation = threading.Event()
    cancellation.set()
    with pytest.raises(OperationCancelled):
        acquirer.acquire("query", "single", 3, cancellation)
    with pytest.raises(OperationTimeout):
        acquirer.acquire("query", "single", 3, deadline=time.monotonic() - 1)


def test_service_preserves_provenance_and_returns_empty_result_without_answer(tmp_path: Path):
    corpus = prepared_corpus()
    retriever = FakeRetriever(make_candidate())
    planner = FakePlanner([["focused search"]])
    service = RagService(settings(tmp_path), corpus, retriever, planner, EvidenceTokenizer(None))
    result = service.search(MedicalEvidenceRequest(query="source query", mode="single"))
    assert result.hits[0].evidenceId == "E1"
    assert result.hits[0].corpus == "textbooks"
    assert result.hits[0].sourceDocumentId == "Anatomy_Gray"
    assert result.hits[0].chunkId == "0"
    assert result.hits[0].score == pytest.approx(0.91)
    assert result.retrieval.estimatedContextTokens > 0
    assert result.retrieval.retrievalLatencyMs >= 0
    assert result.retrieval.plannerLatencyMs == 0
    assert result.retrieval.latencyMs >= result.retrieval.retrievalLatencyMs
    assert not hasattr(result, "finalAnswer")

    empty = RagService(settings(tmp_path), corpus, FakeRetriever(None), planner, EvidenceTokenizer(None))
    empty_result = empty.search(MedicalEvidenceRequest(query="unmatched", mode="single"))
    assert empty_result.hits == []
    assert empty_result.retrieval.returnedEvidenceCount == 0


def test_query_encoder_wrapper_uses_stable_faiss_metadata_and_source_identity(tmp_path: Path):
    corpus = prepared_corpus()
    retriever = MedCptRetriever(corpus, str(tmp_path), encoder=lambda _query: np.array([0.2, 0.3], dtype=np.float32))
    result = retriever.search("query", 3, 1)
    assert result[0].chunk.stable_id == "textbooks:Anatomy_Gray:0"
    assert result[0].score == pytest.approx(0.91)


def test_corpus_manifest_fails_clearly_when_assets_are_missing(tmp_path: Path):
    manifest = {
        "corpusVersion": "missing-v1",
        "retriever": {
            "name": "MedCPT",
            "queryEncoderModel": "query",
            "queryEncoderRevision": "query-rev",
            "articleEncoderModel": "article",
            "articleEncoderRevision": "article-rev",
        },
        "sources": [{
            "name": "textbooks",
            "documentCount": 0,
            "chunkCount": 0,
            "chunkFiles": [{"path": "textbooks/chunk/missing.jsonl", "sha256": "0" * 64}],
        }],
        "indices": [{}],
        "indexHash": "0" * 64,
    }
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(Exception, match="prepared corpus asset is missing"):
        CorpusRepository(tmp_path, manifest_path).load()


def test_corpus_manifest_rejects_hash_mismatch_before_index_load(tmp_path: Path):
    chunk = tmp_path / "textbooks/chunk/chapter.jsonl"
    chunk.parent.mkdir(parents=True)
    chunk.write_text('{"title":"t","content":"c"}\n')
    manifest = {
        "corpusVersion": "mismatch-v1",
        "retriever": {
            "name": "MedCPT",
            "queryEncoderModel": "query",
            "queryEncoderRevision": "query-rev",
            "articleEncoderModel": "article",
            "articleEncoderRevision": "article-rev",
        },
        "sources": [{
            "name": "textbooks",
            "documentCount": 1,
            "chunkCount": 1,
            "chunkFiles": [{"path": "textbooks/chunk/chapter.jsonl", "sha256": "0" * 64}],
        }],
        "indices": [{}],
        "indexHash": "0" * 64,
    }
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(Exception, match="asset hash mismatch"):
        CorpusRepository(tmp_path, manifest_path).load()


def test_corpus_manifest_rejects_faiss_index_hash_mismatch(tmp_path: Path):
    chunk = tmp_path / "textbooks/chunk/chapter.jsonl"
    index = tmp_path / "textbooks/index/faiss.index"
    metadata = tmp_path / "textbooks/index/metadatas.jsonl"
    chunk.parent.mkdir(parents=True)
    index.parent.mkdir(parents=True)
    chunk.write_text('{"title":"t","content":"c"}\n')
    index.write_bytes(b"not a real index")
    metadata.write_text('{"index":0,"source":"chapter"}\n')
    manifest = {
        "corpusVersion": "index-mismatch-v1",
        "retriever": {
            "name": "MedCPT",
            "queryEncoderModel": "query",
            "queryEncoderRevision": "query-rev",
            "articleEncoderModel": "article",
            "articleEncoderRevision": "article-rev",
        },
        "sources": [{
            "name": "textbooks",
            "documentCount": 1,
            "chunkCount": 1,
            "chunkFiles": [{"path": "textbooks/chunk/chapter.jsonl", "sha256": _sha256(chunk)}],
        }],
        "indices": [{
            "corpus": "textbooks",
            "indexPath": "textbooks/index/faiss.index",
            "metadataPath": "textbooks/index/metadatas.jsonl",
            "vectorCount": 1,
            "files": [
                {"path": "textbooks/index/faiss.index", "sha256": "0" * 64},
                {"path": "textbooks/index/metadatas.jsonl", "sha256": _sha256(metadata)},
            ],
        }],
        "indexHash": "0" * 64,
    }
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(Exception, match="asset hash mismatch"):
        CorpusRepository(tmp_path, manifest_path).load()


def _sha256(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()
