#!/usr/bin/env python3
"""Blindly judge pooled retrieval candidates through a local OpenAI-compatible LLM."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests


PROMPT_VERSION = "huiyi-h2-pooled-relevance-judge-v1"
SYSTEM_PROMPT = """You are a retrieval-evaluation judge, not a clinician. Judge only whether each passage is useful evidence for the query. Do not answer the medical question or infer facts that are absent from the passage. Method, rank, retrieval score, and original question category are intentionally withheld.

Use relevanceGrade: 0 = unrelated or unusable for the query; 1 = topical/contextual or supports only a limited aspect; 2 = directly supports a material part of the query. Use answerSupport: supported only when the passage directly supports the specific information requested; partial when it supports one aspect or provides relevant context; unsupported when it does not support the requested information; uncertain only when the passage/query is too ambiguous to decide. Quote an exact, short substring from the passage for grades 1 or 2; use an empty quote for grade 0. Set conflictType to none unless the passage itself presents a source/population/time/topic conflict relevant to the query. Return one judgment for every supplied candidate ID, with a confidence from 0 to 1. Do not guess when uncertain."""


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _atomic_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        stream.write(encoded)
        temporary = Path(stream.name)
    temporary.replace(path)


def _is_loopback_url(value: str) -> bool:
    parsed = urlparse(value)
    return (
        parsed.scheme == "http"
        and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        and parsed.path.rstrip("/").endswith("/chat/completions")
    )


def build_user_message(query: str, candidates: list[dict[str, Any]]) -> str:
    safe_candidates = []
    for item in candidates:
        safe_candidates.append({
            "candidateId": item["candidateId"],
            "sourceCollection": item.get("source", "unknown"),
            "title": item.get("title", ""),
            "passage": item.get("snippet", ""),
        })
    return json.dumps({"query": query, "candidates": safe_candidates}, ensure_ascii=False)


def _response_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "judgments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "candidateId": {"type": "string"},
                        "relevanceGrade": {"type": "integer", "minimum": 0, "maximum": 2},
                        "answerSupport": {"type": "string", "enum": ["supported", "partial", "unsupported", "uncertain"]},
                        "evidenceQuote": {"type": "string"},
                        "conflictType": {"type": "string", "enum": ["none", "topic", "population", "time", "source", "other"]},
                        "explanation": {"type": "string"},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    },
                    "required": ["candidateId", "relevanceGrade", "answerSupport", "evidenceQuote", "conflictType", "explanation", "confidence"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["judgments"],
        "additionalProperties": False,
    }


def parse_judgments(raw: str, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("invalid_json") from None
    if not isinstance(parsed, dict) or set(parsed) != {"judgments"} or not isinstance(parsed["judgments"], list):
        raise ValueError("invalid_top_level_schema")
    expected = {item["candidateId"]: item for item in candidates}
    actual: dict[str, dict[str, Any]] = {}
    for item in parsed["judgments"]:
        if not isinstance(item, dict):
            raise ValueError("judgment_not_object")
        required = {"candidateId", "relevanceGrade", "answerSupport", "evidenceQuote", "conflictType", "explanation", "confidence"}
        if set(item) != required:
            raise ValueError("invalid_judgment_fields")
        candidate_id = item["candidateId"]
        if candidate_id not in expected or candidate_id in actual:
            raise ValueError("unknown_or_duplicate_candidate_id")
        if isinstance(item["relevanceGrade"], bool) or item["relevanceGrade"] not in {0, 1, 2}:
            raise ValueError("invalid_relevance_grade")
        if item["answerSupport"] not in {"supported", "partial", "unsupported", "uncertain"}:
            raise ValueError("invalid_answer_support")
        if item["relevanceGrade"] == 0 and item["answerSupport"] not in {"unsupported", "uncertain"}:
            raise ValueError("grade_zero_requires_unsupported_or_uncertain")
        if item["relevanceGrade"] > 0 and item["answerSupport"] == "unsupported":
            raise ValueError("positive_grade_conflicts_with_unsupported")
        if item["conflictType"] not in {"none", "topic", "population", "time", "source", "other"}:
            raise ValueError("invalid_conflict_type")
        quote = item["evidenceQuote"]
        if not isinstance(quote, str) or not isinstance(item["explanation"], str) or not item["explanation"].strip():
            raise ValueError("invalid_text_fields")
        passage = expected[candidate_id].get("snippet", "")
        if item["relevanceGrade"] == 0 and quote:
            raise ValueError("grade_zero_must_not_claim_supporting_quote")
        if item["relevanceGrade"] > 0 and (not quote or quote not in passage):
            raise ValueError("quote_not_found_verbatim_in_passage")
        confidence = item["confidence"]
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise ValueError("invalid_confidence")
        actual[candidate_id] = item
    if set(actual) != set(expected):
        raise ValueError("missing_candidate_judgment")
    return [actual[candidate_id] for candidate_id in expected]


def _failure(error: Exception) -> tuple[str, int | None]:
    if isinstance(error, requests.HTTPError):
        status = error.response.status_code if error.response is not None else None
        return (f"http_status_{status}" if status else "http_error", status)
    if isinstance(error, requests.Timeout):
        return "timeout", None
    if isinstance(error, requests.ConnectionError):
        return "connection_error", None
    if isinstance(error, ValueError):
        return str(error), None
    return type(error).__name__, None


def call_judge(
    session: requests.Session,
    endpoint: str,
    model: str,
    api_key: str,
    query: str,
    candidates: list[dict[str, Any]],
    timeout_seconds: float,
) -> dict[str, Any]:
    user_message = build_user_message(query, candidates)
    started = time.perf_counter()
    response = session.post(
        endpoint,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": model,
            "temperature": 0,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "rag_relevance_judgments", "strict": True, "schema": _response_schema()},
            },
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
        },
        timeout=(5, timeout_seconds),
    )
    response.raise_for_status()
    body = response.json()
    content = body["choices"][0]["message"]["content"]
    judgments = parse_judgments(content, candidates)
    usage = body.get("usage", {}) if isinstance(body, dict) else {}
    return {
        "status": "ok",
        "judgments": judgments,
        "rawOutput": content,
        "rawOutputSha256": _sha256(content.encode("utf-8")),
        "promptSha256": _sha256((SYSTEM_PROMPT + "\n" + user_message).encode("utf-8")),
        "usage": usage if isinstance(usage, dict) else {},
        "latencyMs": round((time.perf_counter() - started) * 1000, 1),
    }


def _read_packet(path: Path) -> tuple[dict[str, Any], bytes]:
    raw = path.read_bytes()
    packet = json.loads(raw.decode("utf-8"))
    if not isinstance(packet, dict) or not isinstance(packet.get("questions"), list):
        raise ValueError("annotation packet must have a questions array")
    return packet, raw


def run(args: argparse.Namespace) -> dict[str, Any]:
    packet, raw = _read_packet(args.packet)
    endpoint = args.endpoint or os.environ.get("HUIYI_RAG_PLANNER_BASE_URL", os.environ.get("HUIYI_LOCAL_LLM_BASE_URL", ""))
    model = args.model or os.environ.get("HUIYI_RAG_PLANNER_MODEL", os.environ.get("HUIYI_LOCAL_LLM_MODEL", ""))
    key = os.environ.get(args.api_key_env, "")
    packet_hash = _sha256(raw)
    result: dict[str, Any] = {
        "schemaVersion": "huiyi-rag-llm-judge-run/v1",
        "status": "running",
        "runId": args.run_id,
        "judgeModel": model or None,
        "judgeEndpoint": endpoint or None,
        "judgeMode": "blind_pooled_candidates",
        "promptVersion": PROMPT_VERSION,
        "systemPromptSha256": _sha256(SYSTEM_PROMPT.encode("utf-8")),
        "annotationPacketSha256": packet_hash,
        "candidateCount": 0,
        "judgedCount": 0,
        "resolvedCount": 0,
        "reviewRequiredCount": 0,
        "unresolvedCount": 0,
        "judgments": [],
        "failures": [],
        "policy": {
            "methodRankScoreHidden": True,
            "originalQuestionIdAndCategoryHidden": True,
            "lowConfidenceThreshold": args.confidence_threshold,
            "lowConfidenceRequiresReview": True,
            "failedOrMissingJudgmentDefaultsToIrrelevant": False,
        },
    }
    if not model:
        result.update(status="blocked", failure={"class": "judge_model_not_configured"})
        _atomic_write(args.out, result)
        return result
    if not endpoint or not _is_loopback_url(endpoint):
        result.update(status="blocked", failure={"class": "judge_endpoint_must_be_local_loopback"})
        _atomic_write(args.out, result)
        return result
    if not key:
        result.update(status="blocked", failure={"class": "judge_api_key_environment_variable_missing", "environmentVariable": args.api_key_env})
        _atomic_write(args.out, result)
        return result

    if args.out.exists():
        existing = json.loads(args.out.read_text(encoding="utf-8"))
        if existing.get("annotationPacketSha256") != packet_hash or existing.get("runId") != args.run_id:
            raise ValueError("existing output belongs to a different packet/run; choose another output path")
        result.update(existing)
    session = requests.Session()
    queries = packet["questions"][: args.limit_questions or None]
    result["candidateCount"] = sum(len(question.get("candidatePool", [])) for question in queries)
    completed_batches = {item.get("batchId") for item in result.get("judgments", []) if item.get("status") == "ok"}
    for question_index, question in enumerate(queries, start=1):
        query = question.get("query")
        candidates = question.get("candidatePool")
        if not isinstance(query, str) or not isinstance(candidates, list):
            result["failures"].append({"questionOrdinal": question_index, "class": "malformed_question_packet"})
            continue
        for offset in range(0, len(candidates), args.batch_size):
            batch = candidates[offset : offset + args.batch_size]
            batch_id = f"q{question_index:03d}-b{offset // args.batch_size + 1:03d}"
            if batch_id in completed_batches:
                continue
            record: dict[str, Any] = {"batchId": batch_id, "questionOrdinal": question_index, "candidateIds": [item.get("candidateId") for item in batch]}
            last_failure: tuple[str, int | None] | None = None
            for attempt in range(1, args.max_attempts + 1):
                try:
                    record.update(call_judge(session, endpoint, model, key, query, batch, args.timeout_seconds))
                    record["attempts"] = attempt
                    break
                except Exception as error:  # noqa: BLE001 - failures are recorded without leaking response/request data
                    last_failure = _failure(error)
                    if attempt < args.max_attempts and last_failure[1] not in {401, 403}:
                        time.sleep(min(2 ** (attempt - 1), 4))
            if record.get("status") != "ok":
                failure_class, http_status = last_failure or ("unknown_failure", None)
                record.update(status="unresolved", failureClass=failure_class, httpStatus=http_status, attempts=args.max_attempts)
                result["failures"].append({"batchId": batch_id, "failureClass": failure_class, "httpStatus": http_status})
            else:
                record["reviewRequiredIds"] = [
                    item["candidateId"] for item in record["judgments"]
                    if item["confidence"] < args.confidence_threshold or item["answerSupport"] == "uncertain"
                ]
            result["judgments"].append(record)
            result["judgedCount"] = sum(len(item.get("judgments", [])) for item in result["judgments"] if item.get("status") == "ok")
            result["reviewRequiredCount"] = sum(len(item.get("reviewRequiredIds", [])) for item in result["judgments"])
            result["unresolvedCount"] = result["candidateCount"] - result["judgedCount"]
            result["resolvedCount"] = max(0, result["judgedCount"] - result["reviewRequiredCount"])
            result["coverage"] = round(result["resolvedCount"] / result["candidateCount"], 6) if result["candidateCount"] else 0.0
            result["status"] = "running"
            _atomic_write(args.out, result)
            if last_failure and last_failure[1] in {401, 403}:
                result["status"] = "blocked"
                result["resolvedCount"] = max(0, result["judgedCount"] - result["reviewRequiredCount"])
                result["coverage"] = round(result["resolvedCount"] / result["candidateCount"], 6) if result["candidateCount"] else 0.0
                result["failure"] = {
                    "class": last_failure[0],
                    "httpStatus": last_failure[1],
                    "note": "judge loopback endpoint rejected the configured local placeholder credential",
                }
                _atomic_write(args.out, result)
                return result
    result["resolvedCount"] = max(0, result["judgedCount"] - result["reviewRequiredCount"])
    result["status"] = "complete" if result["unresolvedCount"] == 0 and result["reviewRequiredCount"] == 0 else ("complete_with_review" if result["unresolvedCount"] == 0 else "partial")
    result["coverage"] = round(result["resolvedCount"] / result["candidateCount"], 6) if result["candidateCount"] else 0.0
    _atomic_write(args.out, result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packet", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--endpoint")
    parser.add_argument("--model")
    parser.add_argument("--api-key-env", default="HUIYI_RAG_PLANNER_API_KEY")
    parser.add_argument("--batch-size", type=int, default=6)
    parser.add_argument("--limit-questions", type=int, default=0, help="pilot limit; zero uses all questions")
    parser.add_argument("--max-attempts", type=int, default=2)
    parser.add_argument("--timeout-seconds", type=float, default=60)
    parser.add_argument("--confidence-threshold", type=float, default=0.65)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 12 or not 1 <= args.max_attempts <= 4 or args.timeout_seconds <= 0:
        parser.error("batch-size must be 1..12, max-attempts 1..4, and timeout positive")
    if not 0 <= args.confidence_threshold <= 1 or args.limit_questions < 0:
        parser.error("confidence-threshold must be 0..1 and limit-questions non-negative")
    result = run(args)
    safe = {key: result.get(key) for key in ("status", "runId", "judgeModel", "candidateCount", "judgedCount", "resolvedCount", "reviewRequiredCount", "unresolvedCount", "coverage", "failure")}
    print(json.dumps(safe, ensure_ascii=False, indent=2))
    return 0 if result.get("status") in {"complete", "complete_with_review"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
