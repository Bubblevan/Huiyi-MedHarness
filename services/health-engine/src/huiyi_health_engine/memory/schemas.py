from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class MemoryRecallRequest(StrictModel):
    userId: str = Field(min_length=1, max_length=512)
    sessionId: str = Field(min_length=1, max_length=256)
    turn: int = Field(ge=0)
    query: str = Field(min_length=1, max_length=20000)
    strong: bool = False

    @field_validator("userId", "sessionId", "query")
    @classmethod
    def strip_required_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("must contain non-whitespace text")
        return normalized


class MemoryItem(StrictModel):
    kind: Literal["raw", "fact", "episode"]
    content: str = Field(min_length=1)
    timestamp: str | None = None
    source: str | None = None


class MemorySnapshot(StrictModel):
    snapshotId: str
    userId: str
    sessionId: str
    turn: int
    items: list[MemoryItem]
    tokenEstimate: int | None = None
    retrievalRounds: int | None = None
    refreshTriggered: bool | None = None
    amaLlmCallCount: int | None = None


class MemoryCommitRequest(StrictModel):
    idempotencyKey: str = Field(min_length=1, max_length=600)
    userId: str = Field(min_length=1, max_length=512)
    sessionId: str = Field(min_length=1, max_length=256)
    turn: int = Field(ge=1)
    userText: str = Field(min_length=1, max_length=100000)
    assistantText: str = Field(min_length=1, max_length=100000)


class MemoryCommitResult(StrictModel):
    status: Literal["committed", "duplicate", "in_progress", "failed"]
    duplicate: bool
    rawCount: int | None = None
    factCount: int | None = None
    episodeCount: int | None = None
    amaLlmCallCount: int | None = None
    refreshTriggered: bool | None = None
    episodeGenerated: bool | None = None


class MemorySessionEndRequest(StrictModel):
    userId: str = Field(min_length=1, max_length=512)
    sessionId: str = Field(min_length=1, max_length=256)


class MemorySessionEndResult(StrictModel):
    status: Literal["completed", "duplicate", "in_progress", "skipped", "failed"]
    duplicate: bool
    episodeGenerated: bool | None = None
    amaLlmCallCount: int | None = None


class MemoryStats(StrictModel):
    userId: str
    memoryWindowItems: int
    records: dict[Literal["raw", "facts", "episodes"], int]


class MemoryForgetRequest(StrictModel):
    userId: str = Field(min_length=1, max_length=512)
    confirmation: Literal["forget all patient memory"]


class MemoryForgetResult(StrictModel):
    status: Literal["forgotten"]
    recordsRemoved: int


class ErrorResponse(StrictModel):
    error: dict[str, str]


class OpenAiEmbeddingRequest(StrictModel):
    model: str | None = None
    input: str | list[str]
    encoding_format: str = "float"
    prompt_name: str | None = None


class OpenAiEmbedding(StrictModel):
    object: Literal["embedding"] = "embedding"
    index: int
    embedding: list[float]


class OpenAiEmbeddingResponse(StrictModel):
    object: Literal["list"] = "list"
    data: list[OpenAiEmbedding]
    model: str
    usage: dict[str, int]
