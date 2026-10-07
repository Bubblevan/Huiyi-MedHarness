from __future__ import annotations

import os
import asyncio
import threading
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
from fastapi import FastAPI, HTTPException, Request

from .memory.ama_backend import AmaBackendError, AmaMemoryBackend
from .memory.schemas import (
    MemoryCommitRequest,
    MemoryCommitResult,
    MemoryForgetRequest,
    MemoryForgetResult,
    MemoryRecallRequest,
    MemorySessionEndRequest,
    MemorySessionEndResult,
    MemorySnapshot,
    MemoryStats,
    OpenAiEmbeddingRequest,
    OpenAiEmbeddingResponse,
)
from .memory.service import MemoryConflictError, MemoryService
from .rag.config import RagSettings
from .rag.iterative import OperationCancelled, OperationTimeout
from .rag.schemas import EvidenceSet, MedicalEvidenceRequest, RagStatus
from .rag.service import RagService


def _local_llm_url() -> str:
    value = os.environ.get("HUIYI_LOCAL_LLM_BASE_URL", "http://127.0.0.1:8000/v1/chat/completions")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("HUIYI_LOCAL_LLM_BASE_URL must target a loopback OpenAI-compatible endpoint")
    return value


def _configure_local_ama_route() -> None:
    # AMA reads these values at import time. Set them from deployment config,
    # using a non-secret placeholder because the route is restricted to loopback.
    os.environ["AMA_LLM_API_KEY"] = "local-only"
    os.environ["AMA_LLM_BASE_URL"] = _local_llm_url()
    engine_port = int(os.environ.get("HUIYI_HEALTH_ENGINE_PORT", "8322"))
    os.environ["AMA_EMBEDDING_URL"] = f"http://127.0.0.1:{engine_port}/_internal/ama/embeddings"


_configure_local_ama_route()

DATA_DIR = Path(os.environ.get(
    "HUIYI_MEMORY_DATA_DIR",
    str(Path(__file__).resolve().parents[2] / "data"),
)).expanduser().resolve()
service = MemoryService(AmaMemoryBackend(DATA_DIR), DATA_DIR)


def _rag_enabled() -> bool:
    return os.environ.get("HUIYI_RAG_ENABLED", "0").strip().lower() in {"1", "true", "yes"}


def _consume_background_result(future: asyncio.Future[EvidenceSet]) -> None:
    """Observe a worker result even when its HTTP request has already disconnected."""
    try:
        future.exception()
    except asyncio.CancelledError:
        pass


@lru_cache(maxsize=1)
def get_rag_service() -> RagService:
    return RagService.from_settings(RagSettings.from_env())


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # An explicitly enabled RAG deployment validates and loads the pinned local
    # assets at startup. Missing assets stop this process before it accepts turns.
    if _rag_enabled():
        get_rag_service()
    yield


app = FastAPI(title="Huiyi Health Engine", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/rag/status", response_model=RagStatus)
def rag_status() -> RagStatus:
    if not _rag_enabled():
        return RagStatus(status="disabled")
    try:
        return get_rag_service().status()
    except Exception as exc:
        return RagStatus(status="not_ready", errorClass=type(exc).__name__)


@app.post("/v1/rag/search", response_model=EvidenceSet, response_model_exclude_none=True)
async def rag_search(body: MedicalEvidenceRequest, raw_request: Request) -> EvidenceSet:
    if not _rag_enabled():
        raise HTTPException(status_code=503, detail={"error": "rag_disabled"})
    try:
        rag_service = get_rag_service()
    except Exception as exc:
        raise HTTPException(status_code=503, detail={"error": type(exc).__name__}) from None

    cancellation = threading.Event()
    loop = asyncio.get_running_loop()
    pending = loop.run_in_executor(None, rag_service.search, body, cancellation)
    # The worker thread cannot be force-stopped. If the HTTP client disconnects,
    # it cooperatively exits at the next cancellation check; always consume that
    # eventual exception even though this route has already returned 499.
    pending.add_done_callback(_consume_background_result)
    try:
        while not pending.done():
            if await raw_request.is_disconnected():
                cancellation.set()
                raise HTTPException(status_code=499, detail={"error": "request_cancelled"})
            await asyncio.sleep(0.05)
        return await pending
    except OperationCancelled:
        raise HTTPException(status_code=499, detail={"error": "request_cancelled"}) from None
    except OperationTimeout:
        raise HTTPException(status_code=504, detail={"error": "rag_timeout"}) from None
    except HTTPException:
        raise
    except asyncio.CancelledError:
        cancellation.set()
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail={"error": type(exc).__name__}) from None


@app.post("/v1/memory/recall", response_model=MemorySnapshot)
def recall(request: MemoryRecallRequest) -> MemorySnapshot:
    try:
        return service.recall(request)
    except Exception as exc:
        raise _http_error(exc) from None


@app.post("/v1/memory/commit-turn", response_model=MemoryCommitResult)
def commit_turn(request: MemoryCommitRequest) -> MemoryCommitResult:
    try:
        return service.commit_turn(request)
    except Exception as exc:
        raise _http_error(exc) from None


@app.post("/v1/memory/session-end", response_model=MemorySessionEndResult)
def session_end(request: MemorySessionEndRequest) -> MemorySessionEndResult:
    try:
        return service.session_end(request)
    except Exception as exc:
        raise _http_error(exc) from None


@app.get("/v1/memory/stats/{user_id}", response_model=MemoryStats)
def stats(user_id: str) -> MemoryStats:
    try:
        return service.stats(user_id)
    except Exception as exc:
        raise _http_error(exc) from None


@app.post("/v1/memory/forget", response_model=MemoryForgetResult)
def forget(request: MemoryForgetRequest) -> MemoryForgetResult:
    try:
        return service.forget(request)
    except Exception as exc:
        raise _http_error(exc) from None


@app.post("/_internal/ama/embeddings", response_model=OpenAiEmbeddingResponse, include_in_schema=False)
def embeddings(request: OpenAiEmbeddingRequest, raw_request: Request) -> OpenAiEmbeddingResponse:
    expected = os.environ.get("AMA_LLM_API_KEY", "local-only")
    if raw_request.headers.get("authorization") != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail={"error": "unauthorized"})
    texts = [request.input] if isinstance(request.input, str) else request.input
    if not texts or any(not text.strip() for text in texts):
        raise HTTPException(status_code=422, detail={"error": "input must contain non-empty text"})
    try:
        vectors = get_embedder().encode(texts)
    except Exception as exc:
        raise HTTPException(status_code=503, detail={"error": type(exc).__name__}) from None
    data = [
        {"object": "embedding", "index": index, "embedding": vector.tolist()}
        for index, vector in enumerate(vectors)
    ]
    return OpenAiEmbeddingResponse(
        data=data,
        model=os.environ.get("HUIYI_LOCAL_EMBEDDING_MODEL", "Qwen3-Embedding-0.6B"),
        usage={"prompt_tokens": 0, "total_tokens": 0},
    )


@lru_cache(maxsize=1)
def get_embedder() -> LocalEmbedder:
    model_path = os.environ.get("HUIYI_LOCAL_EMBEDDING_PATH", "/root/gpufree-share/models/Qwen3-Embedding-0.6B")
    return LocalEmbedder(model_path)


class LocalEmbedder:
    def __init__(self, model_path: str):
        from sentence_transformers import SentenceTransformer

        self.model = SentenceTransformer(model_path, device="cpu")

    def encode(self, texts: list[str]) -> np.ndarray:
        vectors = np.asarray(self.model.encode(
            texts,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        ), dtype=np.float32)
        if vectors.ndim == 1:
            vectors = vectors.reshape(1, -1)
        if vectors.shape[1] > 3072:
            raise ValueError("local embedding dimension exceeds pinned AMA index dimension")
        if vectors.shape[1] < 3072:
            vectors = np.pad(vectors, ((0, 0), (0, 3072 - vectors.shape[1])))
        return vectors


def _http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, MemoryConflictError):
        return HTTPException(status_code=409, detail={"error": "operation_in_progress"})
    if isinstance(exc, ValueError):
        return HTTPException(status_code=422, detail={"error": "invalid_request"})
    if isinstance(exc, AmaBackendError):
        return HTTPException(
            status_code=503,
            detail={"error": "backend", "errorClass": exc.error_class},
        )
    return HTTPException(status_code=503, detail={"error": type(exc).__name__})


def run() -> None:
    import uvicorn

    host = os.environ.get("HUIYI_HEALTH_ENGINE_HOST", "127.0.0.1")
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("health-engine may only bind to a loopback interface")
    uvicorn.run(
        "huiyi_health_engine.app:app",
        host=host,
        port=int(os.environ.get("HUIYI_HEALTH_ENGINE_PORT", "8322")),
        access_log=False,
    )
