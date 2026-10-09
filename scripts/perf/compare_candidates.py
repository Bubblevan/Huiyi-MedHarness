#!/usr/bin/env python3
"""Summarize metadata-only HC-PERF-001 run directories.

This intentionally reads only benchmark metadata/predictions, not questions,
prompts, model responses, RAG passages, or TEST labels.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p * len(ordered)) - 1)]


def numeric(values: list[Any]) -> list[float]:
    result = []
    for value in values:
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            result.append(number)
    return result


def overlap_maximum(rows: list[dict[str, Any]]) -> tuple[int, int]:
    by_case: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for row in rows:
        if row.get("task") != "specialist-analysis" or row.get("status") != "completed":
            continue
        start, end = row.get("startedAt"), row.get("endedAt")
        if isinstance(start, (int, float)) and isinstance(end, (int, float)) and end >= start:
            by_case[str(row.get("caseHash"))].append((int(start), int(end)))
    maximum = 0
    cases_with_parallel = 0
    for intervals in by_case.values():
        points = [(start, 1) for start, _ in intervals] + [(end, -1) for _, end in intervals]
        active = 0
        case_max = 0
        # End a run before starting another at the same millisecond.
        for _, delta in sorted(points, key=lambda item: (item[0], item[1])):
            active += delta
            case_max = max(case_max, active)
        maximum = max(maximum, case_max)
        cases_with_parallel += case_max > 1
    return maximum, cases_with_parallel


def request_overlap(requests: list[dict[str, Any]], collaboration: list[dict[str, Any]]) -> int:
    specialist_sessions = {
        str(row.get("childRunId"))
        for row in collaboration
        if row.get("event") == "child" and row.get("task") == "specialist-analysis"
    }
    intervals: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for row in requests:
        session = row.get("sessionId")
        start, end = row.get("startedAt"), row.get("endedAt")
        if session in specialist_sessions and isinstance(start, (int, float)) and isinstance(end, (int, float)):
            intervals[str(row.get("caseHash"))].append((int(start), int(end)))
    maximum = 0
    for case_intervals in intervals.values():
        points = [(start, 1) for start, _ in case_intervals] + [(end, -1) for _, end in case_intervals]
        active = 0
        for _, delta in sorted(points, key=lambda item: (item[0], item[1])):
            active += delta
            maximum = max(maximum, active)
    return maximum


def telemetry_summary(rows: list[dict[str, Any]], session_rows: list[dict[str, Any]]) -> dict[str, Any]:
    gpu_rows = [row for row in rows if not row.get("errorClass")]
    start_times = [row.get("time") for row in session_rows if row.get("type") == "turn/start" and isinstance(row.get("time"), (int, float))]
    end_times = [row.get("time") for row in session_rows if row.get("type") == "turn/end" and isinstance(row.get("time"), (int, float))]
    window_start = min(start_times) if start_times else None
    window_end = max(end_times) if end_times else None
    window_rows = []
    if window_start is not None and window_end is not None:
        for row in gpu_rows:
            try:
                timestamp = datetime.fromisoformat(str(row["sampledAtUtc"])).timestamp() * 1000
            except (KeyError, TypeError, ValueError):
                continue
            if window_start <= timestamp <= window_end:
                window_rows.append(row)

    result: dict[str, Any] = {"rows": len(gpu_rows), "turnWindowRows": len(window_rows)}
    for source, target in (
        ("gpuUtilizationPercent", "gpuUtilizationPercent"),
        ("memoryUtilizationPercent", "memoryControllerUtilizationPercent"),
        ("memoryUsedMiB", "memoryUsedMiB"),
        ("powerW", "powerW"),
        ("temperatureC", "temperatureC"),
    ):
        all_values = numeric([row.get(source) for row in gpu_rows])
        in_window = numeric([row.get(source) for row in window_rows])
        if all_values:
            result[target] = {"allSamplesMean": statistics.mean(all_values), "allSamplesMax": max(all_values)}
            if in_window:
                result[target]["turnWindowMean"] = statistics.mean(in_window)
                result[target]["turnWindowMax"] = max(in_window)

    cpu_samples = []
    for row in gpu_rows:
        try:
            timestamp = datetime.fromisoformat(str(row["sampledAtUtc"])).timestamp()
            usage = next(float(line.split()[1]) for line in str(row.get("cgroupCpuStat", "")).splitlines() if line.startswith("usage_usec "))
            cpu_samples.append((timestamp, usage))
        except (KeyError, StopIteration, TypeError, ValueError):
            continue
    cores = []
    for (t0, u0), (t1, u1) in zip(cpu_samples, cpu_samples[1:]):
        if t1 > t0 and u1 >= u0:
            cores.append((u1 - u0) / 1_000_000 / (t1 - t0))
    if cores:
        result["containerCpuCoresApprox"] = {"mean": statistics.mean(cores), "p95": percentile(cores, 0.95), "max": max(cores)}
    memory_bytes = numeric([row.get("cgroupMemoryBytes") for row in gpu_rows])
    if memory_bytes:
        result["cgroupMemoryBytesMax"] = int(max(memory_bytes))
    return result


def prometheus_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    snapshots: dict[str, dict[tuple[str, tuple[tuple[str, str], ...]], float]] = {}
    for row in rows:
        if "metric" not in row:
            continue
        timestamp = str(row.get("timestampUtc", ""))
        key = (str(row["metric"]), tuple(sorted((str(k), str(v)) for k, v in row.get("labels", {}).items())))
        snapshots.setdefault(timestamp, {})[key] = float(row["value"])
    if not snapshots:
        return {"available": False}
    times = sorted(snapshots)
    first, last = snapshots[times[0]], snapshots[times[-1]]

    def series(metric: str) -> list[float]:
        return [
            value
            for sample in snapshots.values()
            for (name, _), value in sample.items()
            if name == metric
        ]

    def counter_delta(metric: str) -> float | None:
        keys = {key for key in set(first) | set(last) if key[0] == metric}
        if not keys:
            return None
        return sum(max(0.0, last.get(key, 0.0) - first.get(key, 0.0)) for key in keys)

    return {
        "available": True,
        "metricNamesObserved": sorted({key[0] for sample in snapshots.values() for key in sample}),
        "maxRunningRequests": max(series("vllm:num_requests_running"), default=None),
        "maxWaitingRequests": max(series("vllm:num_requests_waiting"), default=None),
        "maxKvCacheUsageFraction": max(series("vllm:kv_cache_usage_perc"), default=None),
        "preemptionCounterDelta": counter_delta("vllm:num_preemptions_total"),
        "promptTokensCounterDelta": counter_delta("vllm:prompt_tokens_total"),
        "generationTokensCounterDelta": counter_delta("vllm:generation_tokens_total"),
        "prefixCacheHitsCounterDelta": counter_delta("vllm:prefix_cache_hits_total"),
        "prefixCacheQueriesCounterDelta": counter_delta("vllm:prefix_cache_queries_total"),
        "externalPrefixCacheHitsCounterDelta": counter_delta("vllm:external_prefix_cache_hits_total"),
        "externalPrefixCacheQueriesCounterDelta": counter_delta("vllm:external_prefix_cache_queries_total"),
    }


def summarize(directory: Path, gold: dict[str, str] | None = None) -> dict[str, Any]:
    meta = read_json(directory / "run-metadata.json")
    cases = meta.get("perCase", [])
    requests = read_jsonl(directory / "dsh-requests.jsonl")
    memory = read_jsonl(directory / "memory-requests.jsonl")
    collaboration = read_jsonl(directory / "collaboration-metadata.jsonl")
    predictions = read_jsonl(directory / "predictions.jsonl")
    gpu = read_jsonl(directory / "gpu-telemetry.jsonl")
    vllm = read_jsonl(directory / "vllm-metrics.jsonl")

    makespan_ms = meta.get("throughput", {}).get("makespanMs")
    makespan_s = makespan_ms / 1000 if isinstance(makespan_ms, (int, float)) and makespan_ms > 0 else None
    output_dsh = sum(numeric([row.get("outputTokens")])[0] for row in requests if numeric([row.get("outputTokens")]))
    input_dsh = sum(numeric([row.get("promptTokens")])[0] for row in requests if numeric([row.get("promptTokens")]))
    known_memory = [row for row in memory if row.get("usageReported") is True]
    output_memory = sum(numeric([row.get("outputTokens")])[0] for row in known_memory if numeric([row.get("outputTokens")]))
    input_memory = sum(numeric([row.get("promptTokens")])[0] for row in known_memory if numeric([row.get("promptTokens")]))
    ttft = numeric([row.get("ttftMs") for row in requests])
    tpot = [
        (row["durationMs"] - row["ttftMs"]) / (row["outputTokens"] - 1)
        for row in requests
        if isinstance(row.get("durationMs"), (int, float))
        and isinstance(row.get("ttftMs"), (int, float))
        and isinstance(row.get("outputTokens"), (int, float))
        and row["outputTokens"] > 1
        and row["durationMs"] >= row["ttftMs"]
    ]
    case_latency = numeric([row.get("caseWallLatencyMs") for row in cases])
    successful = sum(row.get("turnReason") == "completed" for row in cases)
    parsed = sum(isinstance(row.get("choice"), str) and bool(row["choice"]) for row in cases)
    role_counts: dict[str, int] = defaultdict(int)
    for row in collaboration:
        if row.get("event") == "child":
            role_counts[str(row.get("task", "unknown"))] += 1
    specialist_overlap, cases_with_parallel = overlap_maximum(collaboration)

    session_rows = read_jsonl(directory / "session-metadata.jsonl")
    gpu_summary = telemetry_summary(gpu, session_rows)

    choice_map = {row.get("id"): row.get("choice") for row in predictions if isinstance(row.get("id"), str)}
    accuracy = None
    if gold is not None:
        matched = [(identifier, choice) for identifier, choice in choice_map.items() if identifier in gold]
        accuracy = {
            "correct": sum(choice == gold[identifier] for identifier, choice in matched),
            "count": len(matched),
        }

    return {
        "label": directory.name,
        "directory": str(directory),
        "input": meta.get("input"),
        "makespanMs": makespan_ms,
        "questionsPerMinute": len(cases) / (makespan_s / 60) if makespan_s else None,
        "completedCases": successful,
        "failedCases": len(cases) - successful,
        "parsedCases": parsed,
        "requestCountDSH": len(requests),
        "memoryModelCalls": len(memory),
        "memoryUsageReportedCalls": len(known_memory),
        "modelCallsTotal": len(requests) + len(memory),
        "specialistRuns": sum(row.get("specialistRuns", 0) for row in cases),
        "moderatorRuns": sum(row.get("moderatorRuns", 0) for row in cases),
        "parallelSpecialistMaxPerCase": specialist_overlap,
        "casesWithParallelSpecialists": cases_with_parallel,
        "maxSimultaneousSpecialistModelRequests": request_overlap(requests, collaboration),
        "taskCounts": dict(role_counts),
        "ragCalls": sum((row.get("evidence") or {}).get("calls", 0) for row in cases),
        "ragHits": sum((row.get("evidence") or {}).get("hitCount", 0) for row in cases),
        "ragDegradedCases": sum(bool((row.get("evidence") or {}).get("degraded")) for row in cases),
        "inputTokensDSH": int(input_dsh),
        "inputTokensMemory": int(input_memory),
        "outputTokensDSH": int(output_dsh),
        "outputTokensMemory": int(output_memory),
        "outputTokensTotalKnown": int(output_dsh + output_memory),
        "aggregateOutputTokensPerSecond": (output_dsh + output_memory) / makespan_s if makespan_s else None,
        "e2eP50Ms": percentile(case_latency, 0.50),
        "e2eP95Ms": percentile(case_latency, 0.95),
        "perCaseWallMs": {"p50": percentile(case_latency, 0.50), "p95": percentile(case_latency, 0.95)},
        "dshTtftMs": {"p50": percentile(ttft, 0.50), "p95": percentile(ttft, 0.95)},
        "dshTpotMs": {"p50": percentile(numeric(tpot), 0.50), "p95": percentile(numeric(tpot), 0.95)},
        "gpu": gpu_summary,
        "vllmMetrics": prometheus_summary(vllm),
        "devAccuracy": accuracy,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="append", required=True, type=Path, help="run directory; may be repeated")
    parser.add_argument("--dev-answer-key", type=Path, help="authorized Dev-only answer key; TEST is not accepted by this tool")
    parser.add_argument("--compare-to", type=Path, help="prediction JSONL for choice-parity counts; only a changed-ID hash is emitted")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    gold: dict[str, str] | None = None
    if args.dev_answer_key:
        raw = read_json(args.dev_answer_key)
        if not isinstance(raw, dict):
            parser.error("Dev answer key must be a mapping")
        authorized_ids = {
            row["id"]
            for directory in args.run
            for row in read_jsonl(directory / "predictions.jsonl")
            if isinstance(row.get("id"), str)
        }
        gold = {
            identifier: str(value.get("answer") if isinstance(value, dict) else value)
            for identifier, value in raw.items()
            if isinstance(identifier, str) and identifier in authorized_ids and identifier.startswith("medqa-dev-")
        }
    comparison: dict[str, str] | None = None
    if args.compare_to:
        comparison = {
            row["id"]: row.get("choice")
            for row in read_jsonl(args.compare_to)
            if isinstance(row.get("id"), str)
        }
    runs = [summarize(directory.resolve(), gold) for directory in args.run]
    if comparison is not None:
        for result, directory in zip(runs, args.run, strict=True):
            predictions = {
                row["id"]: row.get("choice")
                for row in read_jsonl(directory / "predictions.jsonl")
                if isinstance(row.get("id"), str)
            }
            paired = sorted(set(comparison) & set(predictions))
            changed = sorted(identifier for identifier in paired if comparison[identifier] != predictions[identifier])
            result["choiceParityVsComparison"] = {
                "pairedCases": len(paired),
                "sameChoiceCases": len(paired) - len(changed),
                "changedChoiceCases": len(changed),
                "changedCaseIdSha256": hashlib.sha256("\n".join(changed).encode("utf-8")).hexdigest(),
            }
    result = {
        "task": "HC-PERF-001",
        "metadataOnly": True,
        "testLabelsRead": False,
        "devLabelsRead": gold is not None,
        "runs": runs,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
