from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class MedicalEvidenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1, max_length=4000)
    mode: Literal["single", "iterative"] | None = None
    topK: int | None = Field(default=None, ge=1, le=10)

    @field_validator("query")
    @classmethod
    def trim_query(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("query must be non-empty after trimming")
        return value


class EvidenceHit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    evidenceId: str
    rank: int = Field(ge=1)
    title: str
    snippet: str
    source: str
    sourceType: str
    corpus: str
    sourceDocumentId: str
    chunkId: str
    score: float
    retrievalQuery: str
    retrievalQueries: list[str]
    retrievalRound: int = Field(ge=1)
    snippetTruncated: bool
    sourceUri: str | None = None


class RetrievalMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rounds: int = Field(ge=0)
    generatedQueries: int = Field(ge=0)
    uniqueDocuments: int = Field(ge=0)
    candidateCount: int = Field(ge=0)
    returnedEvidenceCount: int = Field(ge=0)
    retrievalCalls: int = Field(ge=0)
    plannerCalls: int = Field(ge=0)
    retrievalLatencyMs: float = Field(ge=0)
    plannerLatencyMs: float = Field(ge=0)
    latencyMs: float = Field(ge=0)
    estimatedContextTokens: int = Field(ge=0)
    plannerModel: str
    plannerPromptVersion: str
    plannerInputTokens: int | None = Field(default=None, ge=0)
    plannerOutputTokens: int | None = Field(default=None, ge=0)
    generatedQueryHashes: list[str]
    degraded: bool
    degradedErrorClass: str | None = None


class EvidenceSet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str
    mode: Literal["single", "iterative"]
    hits: list[EvidenceHit]
    retrieval: RetrievalMetrics
    corpusVersion: str


class RagStatus(BaseModel):
    status: Literal["ready", "disabled", "not_ready"]
    corpusVersion: str | None = None
    sourceCount: int = 0
    chunkCount: int = 0
    retrieverName: str | None = None
    errorClass: str | None = None
