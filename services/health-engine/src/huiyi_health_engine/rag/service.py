from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import RagSettings
from .corpus import CorpusRepository, PreparedCorpus
from .iterative import AcquisitionResult, IterativeEvidenceAcquirer, OperationCancelled
from .planner import QueryPlanner
from .retriever import MedCptRetriever
from .schemas import EvidenceHit, EvidenceSet, MedicalEvidenceRequest, RagStatus, RetrievalMetrics


def _query_encoder_matches_revision(path: Path, revision: str) -> bool:
    if revision in str(path):
        return True
    # Hugging Face local snapshots carry the resolved repository revision next
    # to each downloaded file. This also lets operators keep a clean, readable
    # model directory name instead of embedding a commit SHA in the path.
    metadata_dir = path / ".cache" / "huggingface" / "download"
    try:
        resolved_revisions = set()
        for item in metadata_dir.glob("*.metadata"):
            if item.is_file():
                lines = item.read_text(encoding="utf-8").splitlines()
                if lines and lines[0].strip():
                    resolved_revisions.add(lines[0].strip())
    except (OSError, UnicodeError):
        return False
    return bool(resolved_revisions) and resolved_revisions == {revision}


class EvidenceTokenizer:
    def __init__(self, tokenizer_path: Path | None):
        self.tokenizer: Any = None
        if tokenizer_path is not None:
            from transformers import AutoTokenizer

            self.tokenizer = AutoTokenizer.from_pretrained(str(tokenizer_path), local_files_only=True)

    def count(self, text: str) -> int:
        if self.tokenizer is not None:
            return len(self.tokenizer.encode(text, add_special_tokens=False))
        # Explicitly an estimate for deployments without their generator tokenizer.
        return math.ceil(len(text) / 4)

    def truncate(self, text: str, max_tokens: int) -> str:
        if self.tokenizer is not None:
            tokens = self.tokenizer.encode(text, add_special_tokens=False)
            return self.tokenizer.decode(tokens[:max_tokens], skip_special_tokens=True)
        return text[: max_tokens * 4]


class RagService:
    def __init__(
        self,
        settings: RagSettings,
        corpus: PreparedCorpus,
        retriever: MedCptRetriever,
        planner: QueryPlanner,
        tokenizer: EvidenceTokenizer,
    ):
        if corpus.retriever_name != "MedCPT":
            raise RuntimeError("prepared corpus manifest must name the MedCPT retriever")
        self.settings = settings
        self.corpus = corpus
        self.retriever = retriever
        self.planner = planner
        self.tokenizer = tokenizer
        self.acquirer = IterativeEvidenceAcquirer(settings, retriever, planner)

    @classmethod
    def from_settings(cls, settings: RagSettings) -> "RagService":
        corpus = CorpusRepository(settings.corpus_root, settings.manifest_path).load()
        if not _query_encoder_matches_revision(settings.query_encoder_path, corpus.query_encoder_revision):
            raise RuntimeError("configured MedCPT query encoder path does not match the corpus manifest revision")
        retriever = MedCptRetriever(
            corpus,
            str(settings.query_encoder_path),
            device=settings.query_encoder_device,
            query_max_length=settings.query_max_length,
        )
        planner = QueryPlanner(settings)
        tokenizer = EvidenceTokenizer(settings.tokenizer_path)
        return cls(settings, corpus, retriever, planner, tokenizer)

    def status(self) -> RagStatus:
        return RagStatus(
            status="ready",
            corpusVersion=self.corpus.version,
            sourceCount=len(self.corpus.sources),
            chunkCount=self.corpus.chunk_count,
            retrieverName=self.corpus.retriever_name,
        )

    def search(
        self,
        request: MedicalEvidenceRequest,
        cancellation: threading.Event | None = None,
    ) -> EvidenceSet:
        started = time.perf_counter()
        deadline = time.monotonic() + self.settings.request_timeout_ms / 1000
        mode = request.mode or self.settings.default_mode
        final_k = min(request.topK or self.settings.max_returned_evidence, self.settings.max_returned_evidence)
        acquisition = self.acquirer.acquire(
            request.query,
            mode,
            self.settings.candidates_per_query,
            cancellation,
            deadline,
        )
        hits, visible_tokens = self._select_evidence(acquisition, final_k)
        latency_ms = round((time.perf_counter() - started) * 1000, 1)
        metrics = RetrievalMetrics(
            rounds=acquisition.rounds,
            generatedQueries=acquisition.generated_queries,
            uniqueDocuments=len({
                (item.best.chunk.corpus, item.best.chunk.source_document_id)
                for item in acquisition.candidates
            }),
            candidateCount=acquisition.candidate_count,
            returnedEvidenceCount=len(hits),
            retrievalCalls=acquisition.retrieval_calls,
            plannerCalls=acquisition.planner_calls,
            retrievalLatencyMs=round(acquisition.retrieval_latency_ms, 1),
            plannerLatencyMs=round(acquisition.planner_latency_ms, 1),
            latencyMs=latency_ms,
            estimatedContextTokens=visible_tokens,
            plannerModel=self.settings.planner_model,
            plannerPromptVersion=acquisition.planner_prompt_version,
            plannerInputTokens=acquisition.planner_input_tokens,
            plannerOutputTokens=acquisition.planner_output_tokens,
            generatedQueryHashes=list(acquisition.generated_query_hashes),
            degraded=acquisition.degraded,
            degradedErrorClass=acquisition.degraded_error_class,
        )
        return EvidenceSet(
            query=request.query,
            mode=acquisition.effective_mode,
            hits=hits,
            retrieval=metrics,
            corpusVersion=self.corpus.version,
        )

    def _select_evidence(self, acquisition: AcquisitionResult, limit: int) -> tuple[list[EvidenceHit], int]:
        output: list[EvidenceHit] = []
        remaining = self.settings.max_evidence_tokens
        used_tokens = 0
        for candidate in acquisition.candidates[: max(limit * 4, limit)]:
            chunk = candidate.best.chunk
            prefix = f"E{len(output) + 1} {chunk.title} {chunk.corpus} {chunk.source_document_id} medical_reference"
            prefix_tokens = self.tokenizer.count(prefix)
            snippet_tokens = self.tokenizer.count(chunk.content)
            available = remaining - prefix_tokens
            if available <= 0:
                break
            truncated = snippet_tokens > available
            snippet = self.tokenizer.truncate(chunk.content, available) if truncated else chunk.content
            snippet_count = self.tokenizer.count(snippet)
            item_tokens = prefix_tokens + snippet_count
            if not snippet.strip():
                continue
            rank = len(output) + 1
            output.append(EvidenceHit(
                evidenceId=f"E{rank}",
                rank=rank,
                title=chunk.title,
                snippet=snippet,
                source=chunk.corpus,
                sourceType="medical_reference",
                corpus=chunk.corpus,
                sourceDocumentId=chunk.source_document_id,
                chunkId=chunk.chunk_id,
                score=float(candidate.best.score),
                retrievalQuery=candidate.best.retrieval_query,
                retrievalQueries=list(candidate.queries),
                retrievalRound=candidate.first_round,
                snippetTruncated=truncated,
                sourceUri=chunk.source_uri,
            ))
            remaining -= item_tokens
            used_tokens += item_tokens
            if len(output) >= limit or remaining <= 0:
                break
        return output, used_tokens
