"""Run the pinned MedRAG/i-MedRAG entry point against the local model server."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Union
from urllib.parse import urlparse

from answer_parser import parse_choice
from runner import load_inference_cases, sha256


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--medrag-root", type=Path, required=True)
    parser.add_argument("--inference-jsonl", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--method", choices=("cot", "medrag", "imedrag"), required=True)
    parser.add_argument("--corpus-root", type=Path, required=True)
    parser.add_argument("--query-encoder", type=Path, required=True)
    parser.add_argument("--generator-tokenizer", type=Path, required=True)
    parser.add_argument("--served-model", required=True)
    parser.add_argument("--model-base-url", required=True)
    parser.add_argument("--context-window", type=int, required=True)
    parser.add_argument("--retrieval-context-tokens", type=int, required=True)
    parser.add_argument("--max-output-tokens", type=int, required=True)
    parser.add_argument("--model-timeout-seconds", type=int, default=600)
    parser.add_argument("--k", type=int, default=32)
    parser.add_argument("--n-rounds", type=int, default=4)
    parser.add_argument("--n-queries", type=int, default=3)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    parsed_base_url = urlparse(args.model_base_url)
    if parsed_base_url.scheme != "http" or parsed_base_url.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("the parity generator endpoint must be loopback HTTP")
    if min(args.context_window, args.retrieval_context_tokens, args.max_output_tokens, args.model_timeout_seconds, args.k, args.n_rounds, args.n_queries) < 1:
        raise SystemExit("all model and retrieval limits must be positive")
    if args.retrieval_context_tokens + args.max_output_tokens > args.context_window:
        raise SystemExit("retrieval context plus output cap must fit the served model context")

    os.environ["OPENAI_API_KEY"] = os.environ.get("HC_RAG_LOCAL_API_KEY", "local-only")
    os.environ["OPENAI_BASE_URL"] = args.model_base_url.rstrip("/") + "/"
    os.environ.setdefault("HF_HOME", "/root/gpufree-share/data/hf-cache")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(args.medrag_root.resolve() / "src"))
    sys.path.insert(0, str(args.medrag_root.resolve()))

    import utils as upstream_utils

    upstream_sentence_transformer = upstream_utils.CustomizeSentenceTransformer
    query_encoder_path = str(args.query_encoder.resolve())

    class LocalMedCptSentenceTransformer(upstream_sentence_transformer):
        def __init__(self, model_name_or_path: str, *model_args: Any, **kwargs: Any):
            if model_name_or_path == "ncbi/MedCPT-Query-Encoder":
                model_name_or_path = query_encoder_path
            super().__init__(model_name_or_path, *model_args, **kwargs)

    upstream_utils.CustomizeSentenceTransformer = LocalMedCptSentenceTransformer

    from transformers import AutoTokenizer
    import src.medrag as upstream_medrag_module
    from src.medrag import MedRAG

    def safe_query_list_eval(value: str) -> list[str]:
        """Accept the upstream JSON list output without executing model text."""
        parsed = json.loads(value)
        if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
            raise ValueError("upstream query parser output must be a JSON string list")
        return parsed

    # Preserve upstream's accepted JSON queries while refusing Python code in
    # model-generated text. This changes no valid upstream query content.
    upstream_medrag_module.eval = safe_query_list_eval

    rag_enabled = args.method != "cot"
    medrag = MedRAG(
        llm_name=f"openai/{args.served_model}",
        rag=rag_enabled,
        follow_up=args.method == "imedrag",
        retriever_name="MedCPT",
        corpus_name="MedText",
        db_dir=str(args.corpus_root.resolve()),
        corpus_cache=False,
        HNSW=False,
    )
    medrag.context_length = args.retrieval_context_tokens
    medrag.max_length = args.context_window
    medrag.tokenizer = AutoTokenizer.from_pretrained(
        str(args.generator_tokenizer.resolve()), local_files_only=True,
    )

    import httpx
    from openai import OpenAI

    client = OpenAI(
        api_key=os.environ["OPENAI_API_KEY"],
        base_url=os.environ["OPENAI_BASE_URL"],
        timeout=args.model_timeout_seconds,
        max_retries=0,
        http_client=httpx.Client(trust_env=False),
    )
    stats: dict[str, Union[float, int]] = {
        "modelCalls": 0,
        "retrievalCalls": 0,
        "retrievedChunks": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "modelLatencyMs": 0.0,
        "retrievalLatencyMs": 0.0,
    }
    def tracked_openai_client(**request: Any) -> str:
        started = time.perf_counter()
        api_request = dict(request)
        api_request.setdefault("max_tokens", args.max_output_tokens)
        response = client.chat.completions.create(**api_request)
        stats["modelCalls"] += 1
        stats["modelLatencyMs"] += (time.perf_counter() - started) * 1000
        if response.usage is not None:
            stats["inputTokens"] += response.usage.prompt_tokens
            stats["outputTokens"] += response.usage.completion_tokens
        return response.choices[0].message.content or ""

    upstream_medrag_module.openai_client = tracked_openai_client
    if medrag.retrieval_system is not None:
        original_retrieve = medrag.retrieval_system.retrieve

        def tracked_retrieve(question: str, *positional: Any, **keyword: Any):
            started = time.perf_counter()
            retrieved, scores = original_retrieve(question, *positional, **keyword)
            stats["retrievalCalls"] += 1
            stats["retrievedChunks"] += len(retrieved)
            stats["retrievalLatencyMs"] += (time.perf_counter() - started) * 1000
            return retrieved, scores

        medrag.retrieval_system.retrieve = tracked_retrieve

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
            before = dict(stats)
            started = time.perf_counter()
            kwargs: dict[str, Any] = {"max_tokens": args.max_output_tokens}
            error_class: Union[str, None] = None
            try:
                if args.method == "imedrag":
                    raw, _messages = medrag.answer(
                        case["question"], options=case["options"], k=args.k,
                        n_rounds=args.n_rounds, n_queries=args.n_queries, **kwargs,
                    )
                elif args.method == "medrag":
                    raw, _snippets, _scores = medrag.answer(
                        case["question"], options=case["options"], k=args.k, **kwargs,
                    )
                else:
                    raw, _snippets, _scores = medrag.answer(
                        case["question"], options=case["options"], **kwargs,
                    )
            except Exception as exc:
                raw = ""
                error_class = type(exc).__name__
            wall_ms = round((time.perf_counter() - started) * 1000, 1)
            choice, parse_status = parse_choice(raw)
            if error_class is not None:
                parse_status = "runtime_failure"
            delta = {key: stats[key] - before[key] for key in stats}
            result = {
                "id": str(case["id"]),
                "choice": choice,
                "parseStatus": parse_status,
                "rawOutput": raw,
                "wallLatencyMs": wall_ms,
                "errorClass": error_class,
                **delta,
            }
            predictions.write(json.dumps(result, ensure_ascii=False) + "\n")
            trace.write(json.dumps({
                "id": result["id"],
                "method": args.method,
                "modelCalls": delta["modelCalls"],
                "retrievalCalls": delta["retrievalCalls"],
                "retrievedChunks": delta["retrievedChunks"],
                "inputTokens": delta["inputTokens"],
                "outputTokens": delta["outputTokens"],
                "modelLatencyMs": round(float(delta["modelLatencyMs"]), 1),
                "retrievalLatencyMs": round(float(delta["retrievalLatencyMs"]), 1),
                "wallLatencyMs": wall_ms,
                "parseStatus": parse_status,
                "errorClass": error_class,
            }, ensure_ascii=False) + "\n")
            predictions.flush()
            trace.flush()
            print(json.dumps({"id": result["id"], "parseStatus": parse_status, "wallLatencyMs": wall_ms}), flush=True)

    print(json.dumps({
        "count": len(cases),
        "method": args.method,
        "predictions": str(predictions_path),
        "predictionsSha256": sha256(predictions_path),
        "metadataTrace": str(trace_path),
        "metadataTraceSha256": sha256(trace_path),
        "inferenceInputSha256": sha256(args.inference_jsonl),
        "testGoldRead": False,
        "generatorModel": args.served_model,
    }, indent=2))


if __name__ == "__main__":
    main()
