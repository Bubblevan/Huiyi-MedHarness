#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import requests

from common import (
    AMA_ROOT, ARTIFACT_ROOT, CANONICAL_MODEL_ID, DEFAULT_DATASET, LOCAL_CHAT_URL, LOCAL_MODEL,
    QA_MAX_TOKENS, STATE_MANIFEST,
    add_snapshot_metrics, append_jsonl, citation_ref_validity, completed_keys, questions_for_state,
    configure_pinned_ama, load_dataset, require_loopback_http, snapshot_payload,
    verify_embedding_endpoint, verify_local_model_endpoint, verify_state_copy,
)


def local_chat(prompt_text: str, timeout_s: float) -> tuple[str, dict[str, int | None], float, str | None]:
    started = time.perf_counter()
    response = requests.post(
        LOCAL_CHAT_URL,
        headers={"Authorization": "Bearer local-only", "Content-Type": "application/json"},
        json={
            "model": LOCAL_MODEL,
            "messages": [{"role": "system", "content": prompt_text}],
            "temperature": 0.0,
            "max_tokens": QA_MAX_TOKENS,
            "seed": 0,
            "chat_template_kwargs": {"enable_thinking": False},
        },
        timeout=timeout_s,
    )
    response.raise_for_status()
    payload = response.json()
    text = payload["choices"][0]["message"].get("content") or ""
    finish_reason = payload["choices"][0].get("finish_reason")
    usage = payload.get("usage")
    return text, {
        "prompt_tokens": int(usage["prompt_tokens"]) if isinstance(usage, dict) and isinstance(usage.get("prompt_tokens"), (int, float)) else None,
        "completion_tokens": int(usage["completion_tokens"]) if isinstance(usage, dict) and isinstance(usage.get("completion_tokens"), (int, float)) else None,
        "total_tokens": int(usage["total_tokens"]) if isinstance(usage, dict) and isinstance(usage.get("total_tokens"), (int, float)) else None,
    }, max(0.0, (time.perf_counter() - started) * 1000), finish_reason


def main() -> None:
    parser = argparse.ArgumentParser(description="Arm B: recall through the Huiyi health-engine, then use official QANemori QA semantics.")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--memory-url", default=os.environ.get("HUIYI_HEALTH_ENGINE_URL", "http://127.0.0.1:8324"))
    parser.add_argument("--state-dir", type=Path, default=ARTIFACT_ROOT / "arm-b-sidecar" / "state")
    parser.add_argument("--output", type=Path, default=ARTIFACT_ROOT / "arm-b-sidecar" / "predictions.jsonl")
    parser.add_argument("--limit", type=int, help="Optional debug-only question prefix within the frozen store scope.")
    parser.add_argument("--question-id", help="Run one exact question for a bounded diagnostic.")
    parser.add_argument("--timeout", type=float, default=600)
    args = parser.parse_args()

    dataset = load_dataset(args.dataset)
    verify_local_model_endpoint()
    verify_state_copy(args.state_dir)
    configure_pinned_ama()
    expected_embedding_url = f"{args.memory_url.rstrip('/')}/_internal/ama/embeddings"
    if os.environ.get("AMA_EMBEDDING_URL") != expected_embedding_url:
        raise ValueError("Arm B embedding endpoint must belong to the selected read-only health-engine")
    verify_embedding_endpoint()
    require_loopback_http(args.memory_url, "HUIYI_HEALTH_ENGINE_URL")
    questions = questions_for_state(dataset)
    scope = json.loads(STATE_MANIFEST.read_text(encoding="utf-8"))
    if args.limit is not None:
        questions = questions[:max(0, args.limit)]
    if args.question_id is not None:
        questions = [item for item in questions if item["question_id"] == args.question_id]
        if len(questions) != 1:
            raise ValueError(f"question id is not in the selected frozen scope: {args.question_id}")
    todo = [item for item in questions if item["question_id"] not in completed_keys(args.output)]
    memory_origin = args.memory_url.rstrip("/")

    sys.path.insert(0, str(AMA_ROOT))
    from Settings import prompt as ama_prompt

    for item in todo:
        print(f"Arm B {item['question_id']} ({item['category']})", flush=True)
        user_id = f"locomo:{item['conversation_id']}"
        session_id = f"locomo-sidecar-{item['question_id']}"
        request_body = {
            "userId": user_id,
            "sessionId": session_id,
            "turn": 1,
            "query": item["question"],
            "strong": True,
        }
        started = time.perf_counter()
        response = requests.post(
            f"{memory_origin}/v1/memory/recall",
            json=request_body,
            headers={"Content-Type": "application/json"},
            timeout=args.timeout,
        )
        response.raise_for_status()
        recall_ms = max(0.0, (time.perf_counter() - started) * 1000)
        snapshot = response.json()
        if snapshot.get("userId") != user_id or snapshot.get("sessionId") != session_id or snapshot.get("turn") != 1:
            raise RuntimeError(f"health-engine returned a snapshot for the wrong LoCoMo question identity: {item['question_id']}")
        items = snapshot.get("items", [])
        memory_payload = snapshot_payload(items)
        qa_prompt = ama_prompt.QANemoriPrompt.format(
            memoryInfo=memory_payload or "None",
            userInput=item["question"],
        )
        answer_raw, answer_usage, answer_ms, finish_reason = local_chat(qa_prompt, args.timeout)
        answer, parse_error = _parse_answer(answer_raw)
        if finish_reason == "length":
            answer, parse_error = "", "MaxTokens"
        record: dict[str, Any] = {
            "question_id": item["question_id"],
            "conversation_id": item["conversation_id"],
            "category": item["category"],
            "question": item["question"],
            "gold_answer": item["gold_answer"],
            "response": answer,
            "response_raw": answer_raw,
            "parse_error": parse_error,
            "turn_reason": "max-tokens" if finish_reason == "length" else "completed",
            "max_token_failure": finish_reason == "length",
            "citation_ref_validity": citation_ref_validity(answer_raw, items, parse_error),
            "evidence": item["evidence"],
            "profile": "locomo-parity",
            "arm": "B_SIDECAR",
            "model": CANONICAL_MODEL_ID,
            "api_model": LOCAL_MODEL,
            "memory_model": CANONICAL_MODEL_ID,
            "memory_api_model": LOCAL_MODEL,
            "temperature": 0,
            "seed": 0,
            "qa_max_tokens": QA_MAX_TOKENS,
            "top_k": 10,
            "turn_retrieve": 3,
            "strong_retrieve": True,
            "read_only": True,
            "store_scope_partial": bool(scope.get("partial")),
            "store_scope_max_sessions": scope.get("max_sessions"),
            "snapshot_id": snapshot.get("snapshotId"),
            "retrieval_rounds": snapshot.get("retrievalRounds"),
            "refresh_triggered": snapshot.get("refreshTriggered"),
            "ama_llm_call_count": snapshot.get("amaLlmCallCount"),
            "ama_prompt_tokens": snapshot.get("amaPromptTokens"),
            "ama_completion_tokens": snapshot.get("amaCompletionTokens"),
            "ama_usage_report_count": snapshot.get("amaUsageReportCount"),
            "snapshot_token_estimate_utf8": snapshot.get("tokenEstimate"),
            "qa_usage": answer_usage,
            "finish_reason": finish_reason,
            "latency_ms": {
                "recall": recall_ms,
                "answer_generation": answer_ms,
                "end_to_end": recall_ms + answer_ms,
            },
        }
        add_snapshot_metrics(record, items)
        append_jsonl(args.output, record)

    verify_state_copy(args.state_dir)
    print(f"Arm B complete: {len(completed_keys(args.output))}/{len(questions)} scoped questions; store_partial={scope.get('partial')}; debug_limit={args.limit is not None}")


def _parse_answer(raw: str) -> tuple[str, str | None]:
    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        return "", "InvalidJson"
    if not isinstance(result, dict) or not isinstance(result.get("answer"), str):
        return "", "MissingAnswerField"
    return result["answer"].strip(), None


if __name__ == "__main__":
    main()
