"""Run Huiyi benchmark i-MedRAG directly, without a DSH outer runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests

from answer_parser import parse_choice
from runner import load_inference_cases, sha256


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inference-jsonl", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--health-engine-url", required=True)
    parser.add_argument("--model-base-url", required=True)
    parser.add_argument("--served-model", required=True)
    parser.add_argument("--model-timeout-seconds", type=int, default=600)
    parser.add_argument("--request-timeout-seconds", type=int, default=1800)
    parser.add_argument("--k", type=int, default=32)
    parser.add_argument("--n-rounds", type=int, default=4)
    parser.add_argument("--n-queries", type=int, default=3)
    parser.add_argument("--max-output-tokens", type=int, required=True)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    for label, raw in (("health-engine", args.health_engine_url), ("model", args.model_base_url)):
        parsed = urlparse(raw)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise SystemExit(f"the {label} endpoint must be loopback HTTP")
    if min(args.model_timeout_seconds, args.request_timeout_seconds, args.k, args.n_rounds, args.n_queries, args.max_output_tokens) < 1:
        raise SystemExit("all benchmark limits must be positive")

    model_key = os.environ.get("HC_RAG_LOCAL_API_KEY", "local-only")
    model_url = args.model_base_url.rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {model_key}", "Content-Type": "application/json"}

    # Import the exact pinned prompt strings copied into Huiyi's benchmark path.
    from huiyi_health_engine.rag.benchmark.prompts import (
        I_MEDRAG_SYSTEM,
        format_final_follow_up,
        format_question,
    )

    cases = load_inference_cases(args.inference_jsonl)
    if args.limit is not None:
        if args.limit < 1:
            raise SystemExit("--limit must be positive")
        cases = cases[:args.limit]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    predictions_path = args.output_dir / "predictions.jsonl"
    trace_path = args.output_dir / "metadata-trace.jsonl"
    with predictions_path.open("w", encoding="utf-8") as predictions, trace_path.open("w", encoding="utf-8") as trace:
        for case in cases:
            started = time.perf_counter()
            case_digest = hashlib.sha256(str(case["id"]).encode("utf-8")).hexdigest()[:16]
            case_id = f"hc-rag-002-{case_digest}"
            result: dict[str, Any] = {
                "id": str(case["id"]),
                "choice": None,
                "parseStatus": "runtime_failure",
                "rawOutput": "",
                "modelCalls": 0,
                "retrievalCalls": 0,
                "generatedQueries": 0,
                "roundsCompleted": 0,
                "inputTokens": 0,
                "outputTokens": 0,
                "modelLatencyMs": 0.0,
                "retrievalLatencyMs": 0.0,
                "wallLatencyMs": 0.0,
                "errorClass": None,
            }
            try:
                research_response = requests.post(
                    args.health_engine_url,
                    headers={"Content-Type": "application/json"},
                    json={
                        "caseId": case_id,
                        "question": case["question"],
                        "options": case["options"],
                        "k": args.k,
                        "nRounds": args.n_rounds,
                        "nQueries": args.n_queries,
                    },
                    timeout=args.request_timeout_seconds,
                )
                research_response.raise_for_status()
                research = research_response.json()
                if not isinstance(research, dict) or research.get("caseId") != case_id or not isinstance(research.get("history"), str):
                    raise ValueError("invalid Huiyi i-MedRAG research response")
                if any(field in research for field in ("finalAnswer", "diagnosis", "userResponse")):
                    raise ValueError("health-engine must not return the final answer")
                for key in ("modelCalls", "retrievalCalls", "generatedQueries", "roundsCompleted", "inputTokens", "outputTokens"):
                    result[key] = research.get(key, 0)
                result["modelLatencyMs"] = research.get("modelLatencyMs", 0.0)
                result["retrievalLatencyMs"] = research.get("retrievalLatencyMs", 0.0)
                result["corpusVersion"] = research.get("corpusVersion")
                result["researchParseFailures"] = research.get("parseFailures", 0)

                question_prompt = format_question(case["question"], case["options"])
                final_prompt = format_final_follow_up(question_prompt, research["history"])
                messages: list[dict[str, str]] = [
                    {"role": "system", "content": I_MEDRAG_SYSTEM},
                    {"role": "user", "content": final_prompt},
                ]
                raw = call_model(args, model_url, headers, messages, result)
                if "## Answer" in raw or "answer is" in raw.lower():
                    messages.extend([
                        {"role": "assistant", "content": raw},
                        {"role": "user", "content": "Output the answer in JSON: {'answer': your_answer (A/B/C/D)}"},
                    ])
                    raw = call_model(args, model_url, headers, messages, result)
                result["rawOutput"] = raw
                choice, parse_status = parse_choice(raw)
                result["choice"] = choice
                result["parseStatus"] = parse_status
                if result["roundsCompleted"] != args.n_rounds:
                    result["parseStatus"] = "research_incomplete"
            except requests.Timeout:
                result["errorClass"] = "Timeout"
            except Exception as exc:
                result["errorClass"] = type(exc).__name__
            result["wallLatencyMs"] = round((time.perf_counter() - started) * 1000, 1)
            predictions.write(json.dumps(result, ensure_ascii=False) + "\n")
            trace.write(json.dumps({
                key: result[key] for key in (
                    "id", "parseStatus", "errorClass", "modelCalls", "retrievalCalls",
                    "generatedQueries", "roundsCompleted", "inputTokens", "outputTokens",
                    "modelLatencyMs", "retrievalLatencyMs", "wallLatencyMs", "corpusVersion",
                )
            }, ensure_ascii=False) + "\n")
            predictions.flush()
            trace.flush()
            print(json.dumps({"id": result["id"], "parseStatus": result["parseStatus"], "wallLatencyMs": result["wallLatencyMs"]}), flush=True)

    print(json.dumps({
        "count": len(cases),
        "method": "huiyi-direct-imedrag",
        "predictions": str(predictions_path),
        "predictionsSha256": sha256(predictions_path),
        "metadataTrace": str(trace_path),
        "metadataTraceSha256": sha256(trace_path),
        "inferenceInputSha256": sha256(args.inference_jsonl),
        "testGoldRead": False,
        "generatorModel": args.served_model,
    }, indent=2))


def call_model(
    args: argparse.Namespace,
    url: str,
    headers: dict[str, str],
    messages: list[dict[str, str]],
    result: dict[str, Any],
) -> str:
    started = time.perf_counter()
    response = requests.post(
        url,
        headers=headers,
        json={
            "model": args.served_model,
            "messages": messages,
            "temperature": 0.0,
            "max_tokens": args.max_output_tokens,
        },
        timeout=args.model_timeout_seconds,
    )
    response.raise_for_status()
    body = response.json()
    content = body["choices"][0]["message"]["content"]
    if not isinstance(content, str):
        raise ValueError("model response content is not text")
    usage = body.get("usage", {})
    result["modelCalls"] += 1
    result["inputTokens"] += int(usage.get("prompt_tokens", 0) or 0)
    result["outputTokens"] += int(usage.get("completion_tokens", 0) or 0)
    result["modelLatencyMs"] += (time.perf_counter() - started) * 1000
    return content


if __name__ == "__main__":
    main()
