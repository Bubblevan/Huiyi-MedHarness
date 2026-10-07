from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


def _positive_int(name: str, default: int, maximum: int) -> int:
    raw = os.environ.get(name)
    value = default if raw is None else int(raw)
    if not 1 <= value <= maximum:
        raise RuntimeError(f"{name} must be between 1 and {maximum}")
    return value


@dataclass(frozen=True)
class RagSettings:
    corpus_root: Path
    manifest_path: Path
    query_encoder_path: Path
    query_encoder_device: str
    query_max_length: int
    tokenizer_path: Path | None
    planner_url: str
    planner_model: str
    planner_api_key: str
    planner_timeout_seconds: int
    planner_max_tokens: int
    default_mode: str
    max_rounds: int
    max_queries_per_round: int
    candidates_per_query: int
    max_returned_evidence: int
    max_evidence_tokens: int
    request_timeout_ms: int

    @classmethod
    def from_env(cls) -> "RagSettings":
        corpus_root = Path(os.environ.get("HUIYI_RAG_CORPUS_ROOT", "")).expanduser().resolve()
        manifest_path = Path(os.environ.get("HUIYI_RAG_MANIFEST_PATH", "")).expanduser().resolve()
        query_encoder_path = Path(os.environ.get("HUIYI_RAG_QUERY_ENCODER_PATH", "")).expanduser().resolve()
        tokenizer_value = os.environ.get("HUIYI_RAG_TOKENIZER_PATH", "").strip()
        tokenizer_path = Path(tokenizer_value).expanduser().resolve() if tokenizer_value else None

        planner_url = os.environ.get("HUIYI_RAG_PLANNER_BASE_URL", os.environ.get("HUIYI_LOCAL_LLM_BASE_URL", "")).strip()
        parsed = urlparse(planner_url)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise RuntimeError("RAG planner endpoint must be an HTTP loopback OpenAI-compatible endpoint")
        if not parsed.path.rstrip("/").endswith("/chat/completions"):
            raise RuntimeError("RAG planner endpoint must target /v1/chat/completions")

        planner_model = os.environ.get("HUIYI_RAG_PLANNER_MODEL", os.environ.get("HUIYI_LOCAL_LLM_MODEL", "")).strip()
        planner_api_key = os.environ.get("HUIYI_RAG_PLANNER_API_KEY", "").strip()
        if not planner_model:
            raise RuntimeError("HUIYI_RAG_PLANNER_MODEL must name the configured local model")
        if not planner_api_key:
            raise RuntimeError("HUIYI_RAG_PLANNER_API_KEY must be set (a local placeholder is acceptable)")
        if not corpus_root.is_dir():
            raise RuntimeError("HUIYI_RAG_CORPUS_ROOT must point to a prepared local corpus directory")
        if not manifest_path.is_file():
            raise RuntimeError("HUIYI_RAG_MANIFEST_PATH must point to a prepared corpus/index manifest")
        if not query_encoder_path.is_dir():
            raise RuntimeError("HUIYI_RAG_QUERY_ENCODER_PATH must point to the pinned local MedCPT Query Encoder snapshot")

        default_mode = os.environ.get("HUIYI_RAG_DEFAULT_MODE", "single").strip()
        if default_mode not in {"single", "iterative"}:
            raise RuntimeError("HUIYI_RAG_DEFAULT_MODE must be single or iterative")

        return cls(
            corpus_root=corpus_root,
            manifest_path=manifest_path,
            query_encoder_path=query_encoder_path,
            query_encoder_device=os.environ.get("HUIYI_RAG_RETRIEVER_DEVICE", "cpu").strip(),
            query_max_length=_positive_int("HUIYI_RAG_QUERY_MAX_LENGTH", 512, 4096),
            tokenizer_path=tokenizer_path,
            planner_url=planner_url,
            planner_model=planner_model,
            planner_api_key=planner_api_key,
            planner_timeout_seconds=_positive_int("HUIYI_RAG_PLANNER_TIMEOUT_SECONDS", 90, 600),
            planner_max_tokens=_positive_int("HUIYI_RAG_PLANNER_MAX_TOKENS", 256, 4096),
            default_mode=default_mode,
            max_rounds=_positive_int("HUIYI_RAG_MAX_ROUNDS", 2, 8),
            max_queries_per_round=_positive_int("HUIYI_RAG_MAX_QUERIES_PER_ROUND", 2, 8),
            candidates_per_query=_positive_int("HUIYI_RAG_CANDIDATES_PER_QUERY", 3, 100),
            max_returned_evidence=_positive_int("HUIYI_RAG_MAX_RETURNED_EVIDENCE", 3, 10),
            max_evidence_tokens=_positive_int("HUIYI_RAG_MAX_EVIDENCE_TOKENS", 2048, 16384),
            request_timeout_ms=_positive_int("HUIYI_RAG_TIMEOUT_MS", 180000, 600000),
        )
