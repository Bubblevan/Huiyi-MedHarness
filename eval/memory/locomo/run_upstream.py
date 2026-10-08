#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import requests

from common import (
    AMA_ROOT, ARTIFACT_ROOT, CANONICAL_MODEL_ID, DEFAULT_DATASET, LOCAL_CHAT_URL, LOCAL_MODEL,
    add_snapshot_metrics, append_jsonl, citation_ref_validity, completed_keys, configure_pinned_ama,
    QA_MAX_TOKENS, STATE_MANIFEST, load_dataset, questions_for_state, snapshot_payload,
    verify_embedding_endpoint, verify_local_model_endpoint, verify_state_copy,
)


def memory_for(namespace: str, data_dir: Path):
    configure_pinned_ama()
    sys.path.insert(0, str(AMA_ROOT))
    from Core.AMA import AMA

    memory = AMA(user=namespace, modelMemory=LOCAL_MODEL, temperature=0.0, turnRetrieve=3, data_dir=str(data_dir))
    original_inference = memory.memoryAgent.inference
    original_decision = memory.memoryAgent.inferenceRetrieve
    original_retrieve = memory.retrieve
    counts = {"llm_calls": 0, "retrieval_rounds": 0, "prompt_tokens": 0, "completion_tokens": 0, "usage_reports": 0}

    def capture_usage(*args: Any, **kwargs: Any) -> Any:
        counts["llm_calls"] += 1
        kwargs["showUsage"] = True
        before_prompt = int(memory.memoryAgent.promptToken)
        before_completion = int(memory.memoryAgent.completionToken)
        result = original_inference(*args, **kwargs)
        prompt_delta = max(0, int(memory.memoryAgent.promptToken) - before_prompt)
        completion_delta = max(0, int(memory.memoryAgent.completionToken) - before_completion)
        counts["prompt_tokens"] += prompt_delta
        counts["completion_tokens"] += completion_delta
        if prompt_delta or completion_delta:
            counts["usage_reports"] += 1
        return result

    def fixed_top_k(*args: Any, **kwargs: Any) -> Any:
        decision = original_decision(*args, **kwargs)
        if not isinstance(decision, dict):
            raise RuntimeError("AMA returned a non-object retrieval decision")
        return {**decision, "topK": 10}

    def count_retrieval(*args: Any, **kwargs: Any) -> Any:
        counts["retrieval_rounds"] += 1
        return original_retrieve(*args, **kwargs)

    memory.memoryAgent.inference = capture_usage
    memory.memoryAgent.inferenceRetrieve = fixed_top_k
    memory.retrieve = count_retrieval
    return memory, counts


def retrieve_question(memory: Any, question: str) -> str:
    """Start every independent benchmark QA item with an empty transient AMA window."""
    memory.clearMemoryWindow()
    return memory.forwardRetrieve(question, showUsage=True, strongRetrieve=True)


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
    parser = argparse.ArgumentParser(description="Arm A: pinned upstream AMA retrieval plus official QANemori prompt.")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--state-dir", type=Path, default=ARTIFACT_ROOT / "arm-a-upstream" / "state")
    parser.add_argument("--output", type=Path, default=ARTIFACT_ROOT / "arm-a-upstream" / "predictions.jsonl")
    parser.add_argument("--limit", type=int, help="Optional debug-only question prefix within the frozen store scope.")
    parser.add_argument("--question-id", help="Run one exact question for a bounded diagnostic.")
    parser.add_argument("--timeout", type=float, default=600)
    args = parser.parse_args()

    dataset = load_dataset(args.dataset)
    configure_pinned_ama()
    verify_local_model_endpoint()
    verify_embedding_endpoint()
    questions = questions_for_state(dataset)
    scope = json.loads(STATE_MANIFEST.read_text(encoding="utf-8"))
    if args.limit is not None:
        questions = questions[:max(0, args.limit)]
    if args.question_id is not None:
        questions = [item for item in questions if item["question_id"] == args.question_id]
        if len(questions) != 1:
            raise ValueError(f"question id is not in the selected frozen scope: {args.question_id}")
    todo = [item for item in questions if item["question_id"] not in completed_keys(args.output)]
    verify_state_copy(args.state_dir)

    import hashlib
    sys.path.insert(0, str(AMA_ROOT))
    from Settings import prompt as ama_prompt
    from huiyi_health_engine.memory.ama_backend import _parse_retrievals

    active_conv = None
    memory = None
    counters = None
    for item in todo:
        conv_id = item["conversation_id"]
        if conv_id != active_conv:
            active_conv = conv_id
            namespace = f"huiyi_{hashlib.sha256(f'locomo:{conv_id}'.encode('utf-8')).hexdigest()[:32]}"
            memory, counters = memory_for(namespace, args.state_dir)

        print(f"Arm A {item['question_id']} ({item['category']})", flush=True)
        calls_before = counters["llm_calls"]
        retrievals_before = counters["retrieval_rounds"]
        prompt_tokens_before = counters["prompt_tokens"]
        completion_tokens_before = counters["completion_tokens"]
        usage_reports_before = counters["usage_reports"]
        recall_started = time.perf_counter()
        with open(os.devnull, "w", encoding="utf-8") as sink:
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                retrieval_payload = retrieve_question(memory, item["question"])
        recall_ms = max(0.0, (time.perf_counter() - recall_started) * 1000)
        retrieval = json.loads(retrieval_payload)
        normalized_items = _parse_retrievals(retrieval_payload)
        qa_prompt = ama_prompt.QANemoriPrompt.format(
            memoryInfo=retrieval_payload or "None",
            userInput=item["question"],
        )
        answer_raw, answer_usage, answer_ms, finish_reason = local_chat(qa_prompt, args.timeout)
        answer, parse_error = _parse_answer(answer_raw)
        if finish_reason == "length":
            answer, parse_error = "", "MaxTokens"
        record: dict[str, Any] = {
            "question_id": item["question_id"],
            "conversation_id": conv_id,
            "category": item["category"],
            "question": item["question"],
            "gold_answer": item["gold_answer"],
            "response": answer,
            "response_raw": answer_raw,
            "parse_error": parse_error,
            "turn_reason": "max-tokens" if finish_reason == "length" else "completed",
            "max_token_failure": finish_reason == "length",
            "citation_ref_validity": citation_ref_validity(answer_raw, normalized_items, parse_error),
            "evidence": item["evidence"],
            "profile": "locomo-parity",
            "arm": "A_UPSTREAM",
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
            "retrieval_payload_sha256": hashlib.sha256(snapshot_payload(normalized_items).encode("utf-8")).hexdigest(),
            "retrieval_rounds": counters["retrieval_rounds"] - retrievals_before,
            "ama_llm_call_count": counters["llm_calls"] - calls_before,
            "ama_prompt_tokens": counters["prompt_tokens"] - prompt_tokens_before,
            "ama_completion_tokens": counters["completion_tokens"] - completion_tokens_before,
            "ama_usage_report_count": counters["usage_reports"] - usage_reports_before,
            "qa_usage": answer_usage,
            "finish_reason": finish_reason,
            "latency_ms": {
                "recall": recall_ms,
                "answer_generation": answer_ms,
                "end_to_end": recall_ms + answer_ms,
            },
            "memory_window_count": len(retrieval.get("memoryWindow", [])),
        }
        add_snapshot_metrics(record, normalized_items)
        append_jsonl(args.output, record)
        memory.clearMemoryWindow()

    verify_state_copy(args.state_dir)
    print(f"Arm A complete: {len(completed_keys(args.output))}/{len(questions)} scoped questions; store_partial={scope.get('partial')}; debug_limit={args.limit is not None}")


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
