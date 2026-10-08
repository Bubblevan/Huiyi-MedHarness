from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ImedragResearchRequest(BaseModel):
    """Inference-only input; benchmark labels and scoring fields are forbidden."""

    model_config = ConfigDict(extra="forbid")

    caseId: str = Field(min_length=1, max_length=160)
    question: str = Field(min_length=1, max_length=12000)
    options: dict[str, str]
    k: int = Field(default=32, ge=1, le=64)
    nRounds: int = Field(default=4, ge=1, le=8)
    nQueries: int = Field(default=3, ge=1, le=8)

    @field_validator("question", "caseId")
    @classmethod
    def trim_required_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("field must be non-empty after trimming")
        return value

    @model_validator(mode="after")
    def validate_options(self) -> "ImedragResearchRequest":
        if set(self.options) != {"A", "B", "C", "D"}:
            raise ValueError("MedQA options must contain exactly A, B, C, and D")
        if any(not isinstance(value, str) or not value.strip() for value in self.options.values()):
            raise ValueError("every option must contain non-empty text")
        return self


class MedragRetrievalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    caseId: str = Field(min_length=1, max_length=160)
    question: str = Field(min_length=1, max_length=12000)
    options: dict[str, str]
    topK: int = Field(default=32, ge=1, le=64)

    @field_validator("question", "caseId")
    @classmethod
    def trim_required_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("field must be non-empty after trimming")
        return value

    @model_validator(mode="after")
    def validate_options(self) -> "MedragRetrievalRequest":
        if set(self.options) != {"A", "B", "C", "D"}:
            raise ValueError("MedQA options must contain exactly A, B, C, and D")
        if any(not isinstance(value, str) or not value.strip() for value in self.options.values()):
            raise ValueError("every option must contain non-empty text")
        return self


class RetrievedSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sourceId: str
    corpus: Literal["textbooks", "statpearls"]
    sourceDocumentId: str
    chunkId: str
    rank: int = Field(ge=1)
    title: str
    score: float


class FollowUpObservation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    round: int = Field(ge=1)
    query: str
    queryHash: str
    answer: str
    answerHash: str
    sources: list[RetrievedSource]


class ImedragResearchResult(BaseModel):
    """Query/answer research history, without a final user-answer field."""

    model_config = ConfigDict(extra="forbid")

    caseId: str
    history: str
    roundsCompleted: int = Field(ge=0)
    generatedQueries: int = Field(ge=0)
    modelCalls: int = Field(ge=0)
    retrievalCalls: int = Field(ge=0)
    inputTokens: int = Field(ge=0)
    outputTokens: int = Field(ge=0)
    retrievalLatencyMs: float = Field(ge=0)
    modelLatencyMs: float = Field(ge=0)
    observations: list[FollowUpObservation]
    corpusVersion: str
    plannerModel: str
    promptVersion: str
    latencyMs: float = Field(ge=0)
    parseFailures: int = Field(ge=0)


class MedragDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sourceId: str
    corpus: Literal["textbooks", "statpearls"]
    sourceDocumentId: str
    chunkId: str
    title: str
    content: str
    score: float


class MedragRetrievalResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    caseId: str
    documents: list[MedragDocument]
    context: str
    corpusVersion: str
    retrievalLatencyMs: float = Field(ge=0)


def input_projection(request: ImedragResearchRequest) -> dict[str, object]:
    """Return only the question-side fields accepted by the inference path."""
    return {
        "caseId": request.caseId,
        "question": request.question,
        "options": {key: request.options[key] for key in sorted(request.options)},
        "k": request.k,
        "nRounds": request.nRounds,
        "nQueries": request.nQueries,
    }
