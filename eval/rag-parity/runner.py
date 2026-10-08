"""Run one DSH headless Session per sanitized MedQA case; never opens gold labels."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from answer_parser import parse_choice


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_NODE = Path("/root/.nvm/versions/node/v22.23.3/bin/node")
DEFAULT_DSH_ENTRY = Path("/root/.nvm/versions/node/v22.23.3/lib/node_modules/@deepseek-ai/dsh/lib/bin.js")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_prompt(method: str, case: dict[str, Any]) -> str:
    options = case["options"]
    option_text = "\n".join(f"{key}. {options[key]}" for key in ("A", "B", "C", "D"))
    prompt = f"Here is the question:\n{case['question']}\n\nHere are the potential choices:\n{option_text}"
    if method == "cot":
        return f"{prompt}\n\nPlease think step-by-step and generate your output in json:\n"
    if method == "medrag":
        return f"{prompt}\n\nCall the retrieval tool once, then answer the original question in JSON."
    return f"{prompt}\n\nCall the research tool once, then answer the original question in JSON."


def load_inference_cases(path: Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    forbidden = {"answer", "gold", "goldAnswer", "correct", "correctOption", "label", "score"}
    with path.open("r", encoding="utf-8") as stream:
        for line_no, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            case = json.loads(line)
            if not isinstance(case, dict) or set(case) != {"id", "question", "options"}:
                raise ValueError(f"inference case {line_no} must have exactly id, question, options")
            if forbidden.intersection(case):
                raise ValueError(f"inference case {line_no} contains a forbidden gold/scoring field")
            if not isinstance(case["options"], dict) or set(case["options"]) != {"A", "B", "C", "D"}:
                raise ValueError(f"inference case {line_no} has invalid MedQA options")
            if not isinstance(case["question"], str) or any(not isinstance(case["options"][key], str) for key in "ABCD"):
                raise ValueError(f"inference case {line_no} has invalid question/option text")
            cases.append(case)
    if not cases:
        raise ValueError("inference file has no cases")
    return cases


def run_one(
    case: dict[str, Any],
    method: str,
    profile: str,
    dsh_home: Path,
    node: Path,
    dsh_entry: Path,
    timeout_seconds: int,
) -> dict[str, Any]:
    case_key = str(case["id"])
    run_key = f"{method}-{hashlib.sha256(case_key.encode('utf-8')).hexdigest()[:16]}-{uuid.uuid4().hex[:8]}"
    rag_trace_path = dsh_home / "rag-traces" / f"{run_key}.jsonl"
    env = os.environ.copy()
    env["DSH_HOME"] = str(dsh_home)
    env["HUIYI_RAG_BENCHMARK_METHOD"] = method
    env["HUIYI_RAG_BENCHMARK_TRACE_FILE"] = str(rag_trace_path)
    node_dir = str(node.parent)
    env["PATH"] = f"{node_dir}{os.pathsep}{env.get('PATH', '')}"
    command = [
        str(node), str(dsh_entry), "--profile", profile,
        "--json", "-",
    ]
    started = time.perf_counter()
    try:
        completed = subprocess.run(
            command,
            input=canonical_prompt(method, case),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            timeout=timeout_seconds,
            check=False,
        )
        wall_ms = round((time.perf_counter() - started) * 1000, 1)
    except subprocess.TimeoutExpired:
        return {
            "id": case_key,
            "choice": None,
            "parseStatus": "runtime_failure",
            "rawOutput": "",
            "sessionId": None,
            "toolCalls": 0,
            "unexpectedToolCalls": 0,
            "turnOutcome": "timeout",
            "exitCode": None,
            "wallLatencyMs": round((time.perf_counter() - started) * 1000, 1),
            "stderrHash": None,
        }

    events = parse_json_events(completed.stdout)
    session_event = next((event for event in events if event.get("type") == "session"), {})
    session_id = session_event.get("sessionId")
    final = next((event.get("text", "") for event in reversed(events) if event.get("type") == "final"), "")
    choice, parse_status = parse_choice(final)
    tool_calls = [event for event in events if event.get("type") == "tool_call"]
    expected_tool = {"imedrag": "research_medical_question", "medrag": "retrieve_medical_documents"}.get(method)
    benchmark_calls = [event for event in tool_calls if event.get("tool") == expected_tool]
    unexpected = len(tool_calls) - len(benchmark_calls)
    call_ids = {event.get("callId") for event in benchmark_calls}
    tool_results = [
        event for event in events
        if event.get("type") == "tool_result" and event.get("callId") in call_ids
    ]
    tool_failures = sum(event.get("status") == "error" for event in tool_results)
    rag_metadata = read_rag_metadata(rag_trace_path)
    turn_ends = [event for event in events if event.get("type") == "status" and event.get("phase") == "turn_end"]
    reason = turn_ends[-1].get("reason") if turn_ends else None
    turn_outcome = reason.get("kind", "unknown") if isinstance(reason, dict) else str(reason or "missing_turn_end")
    if completed.returncode != 0 or turn_outcome != "completed":
        parse_status = "runtime_failure"
    if method in {"imedrag", "medrag"} and len(benchmark_calls) != 1:
        parse_status = "research_call_count_failure"
    if method == "cot" and tool_calls:
        parse_status = "unexpected_research_call"
    if unexpected:
        parse_status = "unexpected_tool_call"
    if method in {"imedrag", "medrag"} and tool_failures:
        parse_status = "research_tool_failure"
    if method in {"imedrag", "medrag"} and not tool_results and len(benchmark_calls) == 1:
        parse_status = "research_result_missing"
    if method == "imedrag" and rag_metadata is None and not tool_failures:
        parse_status = "research_metadata_missing"
    usage: list[dict[str, Any]] = [
        event["usage"] for event in events
        if event.get("type") == "status" and event.get("phase") == "step_end" and isinstance(event.get("usage"), dict)
    ]
    return {
        "id": case_key,
        "choice": choice,
        "parseStatus": parse_status,
        "rawOutput": final,
        "sessionId": session_id if isinstance(session_id, str) else None,
        "toolCalls": len(benchmark_calls),
        "unexpectedToolCalls": unexpected,
        "turnOutcome": turn_outcome,
        "exitCode": completed.returncode,
        "wallLatencyMs": wall_ms,
        "tokenUsageByStep": usage,
        "researchMetadata": rag_metadata,
        "toolFailures": tool_failures,
        "stderrHash": hashlib.sha256(completed.stderr.encode("utf-8")).hexdigest() if completed.stderr else None,
    }


def parse_json_events(stdout: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict) or not isinstance(value.get("type"), str):
            raise ValueError("DSH headless JSON output contained an invalid event")
        events.append(value)
    return events


def read_rag_metadata(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    values = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not values or not isinstance(values[-1], dict):
        return None
    allowed = {
        "caseId", "corpusVersion", "method", "promptVersion", "plannerModel",
        "roundsCompleted", "generatedQueries", "modelCalls", "retrievalCalls",
        "retrievedDocuments", "inputTokens", "outputTokens", "retrievalLatencyMs",
        "modelLatencyMs", "latencyMs", "parseFailures",
    }
    return {key: value for key, value in values[-1].items() if key in allowed}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inference-jsonl", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--method", choices=("cot", "medrag", "imedrag"), required=True)
    parser.add_argument("--profile", default="hc-rag-002")
    parser.add_argument("--dsh-home", type=Path, required=True)
    parser.add_argument("--node", type=Path, default=DEFAULT_NODE)
    parser.add_argument("--dsh-entry", type=Path, default=DEFAULT_DSH_ENTRY)
    parser.add_argument("--timeout-seconds", type=int, default=600)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    cases = load_inference_cases(args.inference_jsonl)
    if args.limit is not None:
        if args.limit < 1:
            raise SystemExit("--limit must be positive")
        cases = cases[:args.limit]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    predictions_path = args.output_dir / "predictions.jsonl"
    trace_path = args.output_dir / "dsh-metadata.jsonl"
    with predictions_path.open("w", encoding="utf-8") as predictions, trace_path.open("w", encoding="utf-8") as trace:
        for case in cases:
            result = run_one(
                case, args.method, args.profile, args.dsh_home.resolve(),
                args.node.resolve(), args.dsh_entry.resolve(), args.timeout_seconds,
            )
            predictions.write(json.dumps(result, ensure_ascii=False) + "\n")
            trace.write(json.dumps({
                "id": result["id"],
                "sessionId": result["sessionId"],
                "turnOutcome": result["turnOutcome"],
                "toolCalls": result["toolCalls"],
                "toolFailures": result.get("toolFailures", 0),
                "unexpectedToolCalls": result["unexpectedToolCalls"],
                "parseStatus": result["parseStatus"],
                "wallLatencyMs": result["wallLatencyMs"],
                "tokenUsageByStep": result.get("tokenUsageByStep", []),
                "researchMetadata": result.get("researchMetadata"),
            }, ensure_ascii=False) + "\n")
            predictions.flush()
            trace.flush()
            print(json.dumps({"id": result["id"], "parseStatus": result["parseStatus"], "wallLatencyMs": result["wallLatencyMs"]}), flush=True)

    print(json.dumps({
        "count": len(cases),
        "predictions": str(predictions_path),
        "predictionsSha256": sha256(predictions_path),
        "metadataTrace": str(trace_path),
        "metadataTraceSha256": sha256(trace_path),
        "inferenceInputSha256": sha256(args.inference_jsonl),
        "testGoldRead": False,
    }, indent=2))


if __name__ == "__main__":
    main()
