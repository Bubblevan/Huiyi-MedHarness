#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path
from typing import Any

from common import ARTIFACT_ROOT, DEFAULT_DATASET, STATE_MANIFEST, load_dataset, questions_for_state
from score import aggregate, bleu1, token_f1, verify_scorer_hash


def write_artifact_text(path: Path, value: str) -> None:
    private_output = path.expanduser().resolve().is_relative_to(ARTIFACT_ROOT)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700 if private_output else 0o755)
    if private_output:
        path.parent.chmod(0o700)
    path.write_text(value, encoding="utf-8")
    if private_output:
        path.chmod(0o600)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    values = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if line.strip():
            try:
                values.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSON at {path}:{line_number}") from exc
    return values


def read_index(path: Path) -> dict[str, dict[str, Any]]:
    rows = read_jsonl(path)
    result = {str(row["question_id"]): row for row in rows}
    if len(result) != len(rows):
        raise ValueError(f"duplicate question ids in {path}")
    return result


def values_by_question(arms: dict[str, dict[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    id_sets = {name: set(rows) for name, rows in arms.items()}
    all_ids = set.intersection(*id_sets.values()) if id_sets else set()
    if any(ids != all_ids for ids in id_sets.values()):
        differences = {
            name: {"missing": sorted(all_ids - ids)[:5], "extra": sorted(ids - all_ids)[:5], "count": len(ids)}
            for name, ids in id_sets.items()
        }
        raise ValueError(f"arms do not score identical question ids: {differences}")
    ordered_ids = {name: list(rows) for name, rows in arms.items()}
    if any(ids != ordered_ids["A_UPSTREAM"] for ids in ordered_ids.values()):
        raise ValueError("arms contain the same question ids in different orders")

    result = []
    for question_id, a in arms["A_UPSTREAM"].items():
        b = arms["B_SIDECAR"][question_id]
        c = arms.get("C_DSH", {}).get(question_id)
        for row in (b, c):
            if row is None:
                continue
            if row.get("category") != a.get("category") or row.get("gold_answer") != a.get("gold_answer"):
                raise ValueError(f"dataset labels differ between arms at {question_id}")
        a_hash = a.get("retrieval_hash")
        b_hash = b.get("retrieval_hash")
        c_hash = c.get("snapshot_hash") if c else None
        b_items = b.get("retrieved_items")
        c_items = c.get("retrieved_items") if c else None
        b_source_refs = [
            (item.get("kind"), item.get("content_sha256"), item.get("source_id"))
            for item in b_items
        ] if isinstance(b_items, list) else None
        c_source_refs = [
            (item.get("kind"), item.get("content_sha256"), item.get("source_id"))
            for item in c_items
        ] if isinstance(c_items, list) else None
        result.append({
            "question_id": question_id,
            "conversation_id": a.get("conversation_id"),
            "category": a.get("category"),
            "question": a.get("question"),
            "gold_answer": a.get("gold_answer"),
            "A_correct": None,
            "B_correct": None,
            "C_correct": None,
            "correctness_note": "No comparable LLM-judge protocol was recovered; use per-item Token-F1/BLEU-1 below.",
            "A_token_f1": token_f1(a.get("response", ""), a.get("gold_answer", "")),
            "B_token_f1": token_f1(b.get("response", ""), b.get("gold_answer", "")),
            "C_token_f1": token_f1(c.get("response", ""), c.get("gold_answer", "")) if c else None,
            "A_bleu1": bleu1(a.get("response", ""), a.get("gold_answer", "")),
            "B_bleu1": bleu1(b.get("response", ""), b.get("gold_answer", "")),
            "C_bleu1": bleu1(c.get("response", ""), c.get("gold_answer", "")) if c else None,
            "A_answer": a.get("response", ""),
            "B_answer": b.get("response", ""),
            "C_answer": c.get("response", "") if c else None,
            "A_parse_error": a.get("parse_error"),
            "B_parse_error": b.get("parse_error"),
            "C_parse_error": c.get("parse_error") if c else None,
            "A_turn_reason": a.get("turn_reason"),
            "B_turn_reason": b.get("turn_reason"),
            "C_turn_reason": c.get("turn_reason") if c else None,
            "A_citation_ref_validity": a.get("citation_ref_validity"),
            "B_citation_ref_validity": b.get("citation_ref_validity"),
            "C_citation_ref_validity": c.get("citation_ref_validity") if c else None,
            "A_B_retrieval_equivalent": a_hash == b_hash if a_hash is not None and b_hash is not None else None,
            "B_C_snapshot_equivalent": b_hash == c_hash if c and b_hash is not None and c_hash is not None else None,
            "B_C_source_refs_equal": b_source_refs == c_source_refs if c and b_source_refs is not None and c_source_refs is not None else None,
            "A_B_answer_equal": a.get("response", "") == b.get("response", ""),
            "B_C_answer_equal": b.get("response", "") == c.get("response", "") if c else None,
            "A_retrieval_rounds": a.get("retrieval_rounds"),
            "B_retrieval_rounds": b.get("retrieval_rounds"),
            "C_retrieval_rounds": c.get("retrieval_rounds") if c else None,
            "A_retrieved_kinds": a.get("retrieved_kinds"),
            "B_retrieved_kinds": b.get("retrieved_kinds"),
            "C_retrieved_kinds": c.get("retrieved_kinds") if c else None,
            "A_latency_ms": a.get("latency_ms"),
            "B_latency_ms": b.get("latency_ms"),
            "C_latency_ms": c.get("latency_ms") if c else None,
            "A_usage": a.get("qa_usage"),
            "B_usage": b.get("qa_usage"),
            "C_usage": c.get("qa_usage") if c else None,
            "C_dsh_steps": c.get("model_step_count") if c else None,
            "C_tool_call_count": c.get("tool_call_count") if c else None,
            "C_automatic_recall_count": c.get("automatic_recall_count") if c else None,
            "C_memory_write_count": c.get("memory_write_count") if c else None,
            "A_qa_max_tokens": a.get("qa_max_tokens"),
            "B_qa_max_tokens": b.get("qa_max_tokens"),
            "C_qa_max_tokens": c.get("qa_max_tokens") if c else None,
            "C_commit_status": c.get("commit_status") if c else None,
            "C_turn_reason": c.get("turn_reason") if c else None,
            "C_parse_error": c.get("parse_error") if c else None,
        })
    return result


def metrics_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    def count(predicate):
        return sum(1 for row in rows if predicate(row))

    citation = {}
    for arm in ("A", "B", "C"):
        values = [row.get(f"{arm}_citation_ref_validity") for row in rows]
        values = [value for value in values if isinstance(value, dict)]
        reference_count = sum(int(value.get("reference_count", 0)) for value in values)
        valid_count = sum(int(value.get("valid_reference_count", 0)) for value in values)
        invalid_count = sum(int(value.get("invalid_reference_count", 0)) for value in values)
        citation[arm] = {
            "questions_with_invalid_refs": sum(bool(value.get("has_invalid_reference")) for value in values),
            "questions_with_parsed_citations": sum(int(value.get("reference_count", 0)) > 0 for value in values),
            "total_refs": reference_count,
            "valid_refs": valid_count,
            "invalid_refs": invalid_count,
            "validity_rate": (valid_count / reference_count) if reference_count else None,
        }
    return {
        "count": len(rows),
        "A_B_retrieval_equal": count(lambda row: row["A_B_retrieval_equivalent"] is True),
        "A_B_retrieval_comparable": count(lambda row: row["A_B_retrieval_equivalent"] is not None),
        "B_C_snapshot_equal": count(lambda row: row["B_C_snapshot_equivalent"] is True),
        "B_C_snapshot_comparable": count(lambda row: row["B_C_snapshot_equivalent"] is not None),
        "B_C_source_refs_equal": count(lambda row: row["B_C_source_refs_equal"] is True),
        "B_C_source_refs_comparable": count(lambda row: row["B_C_source_refs_equal"] is not None),
        "A_B_answer_equal": count(lambda row: row["A_B_answer_equal"] is True),
        "B_C_answer_equal": count(lambda row: row["B_C_answer_equal"] is True),
        "C_one_recall": count(lambda row: row["C_automatic_recall_count"] == 1),
        "C_one_model_step": count(lambda row: row["C_dsh_steps"] == 1),
        "C_zero_tool_calls": count(lambda row: row["C_tool_call_count"] == 0),
        "C_zero_memory_writes": count(lambda row: row["C_memory_write_count"] == 0),
        "C_commit_skipped_without_write": count(lambda row: row["C_commit_status"] in {"evaluation_read_only", "turn_max-tokens"}),
        "max_token_failures": {
            arm: count(lambda row: row.get(f"{arm}_turn_reason") == "max-tokens")
            for arm in ("A", "B", "C")
        },
        "citation_ref_validity": citation,
    }


def safe_mean(values: list[float]) -> float | None:
    return statistics.mean(values) if values else None


def usage_summary(arms: dict[str, dict[str, dict[str, Any]]]) -> dict[str, Any]:
    def latency_distribution(rows: list[dict[str, Any]], key: str, fallback: str | None = None) -> dict[str, float | int | None]:
        values = []
        for row in rows:
            latency = row.get("latency_ms") or {}
            value = latency.get(key)
            if value is None and fallback is not None:
                value = latency.get(fallback)
            if isinstance(value, (float, int)):
                values.append(float(value))
        values.sort()
        if not values:
            return {"count": 0, "mean_ms": None, "median_ms": None, "p50_ms": None, "p95_ms": None, "max_ms": None}
        p95_index = max(0, min(len(values) - 1, int((0.95 * len(values) + 0.999999)) - 1))
        median = statistics.median(values)
        return {
            "count": len(values),
            "mean_ms": statistics.mean(values),
            "median_ms": median,
            "p50_ms": median,
            "p95_ms": values[p95_index],
            "max_ms": values[-1],
        }

    def latency_by_turn_reason(rows: list[dict[str, Any]]) -> dict[str, Any]:
        keys = ("recall", "dsh_pre_model", "answer_generation", "first_token", "dsh_turn", "end_to_end")
        return {
            reason: {
                key: latency_distribution(
                    [row for row in rows if row.get("turn_reason") == reason],
                    key,
                    "end_to_end_wall" if key == "end_to_end" else None,
                )
                for key in keys
            }
            for reason in ("completed", "max-tokens")
        }

    def value_distribution(rows: list[dict[str, Any]], key: str) -> dict[str, Any]:
        values = sorted(float(row[key]) for row in rows if isinstance(row.get(key), (int, float)))
        if not values:
            return {"count": 0, "mean": None, "median": None, "p50": None, "p95": None, "max": None}
        p95_index = max(0, min(len(values) - 1, int((0.95 * len(values) + 0.999999)) - 1))
        median = statistics.median(values)
        return {
            "count": len(values),
            "mean": statistics.mean(values),
            "median": median,
            "p50": median,
            "p95": values[p95_index],
            "max": values[-1],
        }

    def histogram(rows: list[dict[str, Any]], key: str) -> dict[str, int]:
        counts: dict[str, int] = {}
        for row in rows:
            value = row.get(key)
            label = str(value) if isinstance(value, (int, float)) else "unknown"
            counts[label] = counts.get(label, 0) + 1
        return dict(sorted(counts.items()))

    result: dict[str, Any] = {}
    for arm, records in arms.items():
        rows = list(records.values())
        qa_usage_rows = [row.get("qa_usage") for row in rows]
        qa_prompt_values = [usage.get("prompt_tokens") for usage in qa_usage_rows if isinstance(usage, dict)]
        qa_completion_values = [usage.get("completion_tokens") for usage in qa_usage_rows if isinstance(usage, dict)]
        qa_total_values = [usage.get("total_tokens") for usage in qa_usage_rows if isinstance(usage, dict)]
        result[arm] = {
            "qa_prompt_tokens": sum(int(value) for value in qa_prompt_values if isinstance(value, (int, float))),
            "qa_completion_tokens": sum(int(value) for value in qa_completion_values if isinstance(value, (int, float))),
            "qa_total_tokens": sum(int(value) for value in qa_total_values if isinstance(value, (int, float))),
            "qa_usage_missing_count": sum(
                1 for usage in qa_usage_rows
                if not isinstance(usage, dict)
                or any(not isinstance(usage.get(key), (int, float)) for key in ("prompt_tokens", "completion_tokens", "total_tokens"))
            ),
            "ama_prompt_tokens": sum(int(row.get("ama_prompt_tokens") or 0) for row in rows),
            "ama_completion_tokens": sum(int(row.get("ama_completion_tokens") or 0) for row in rows),
            "ama_llm_calls": sum(int(row.get("ama_llm_call_count") or 0) for row in rows),
            "ama_usage_report_count": sum(int(row.get("ama_usage_report_count") or 0) for row in rows),
            "retrieval_round_distribution": histogram(rows, "retrieval_rounds"),
            "retrieved_item_count": value_distribution(rows, "retrieved_count"),
            "latency_ms": {
                "recall": latency_distribution(rows, "recall"),
                "dsh_pre_model": latency_distribution(rows, "dsh_pre_model"),
                "answer_generation": latency_distribution(rows, "answer_generation"),
                "first_token": latency_distribution(rows, "first_token"),
                "dsh_turn": latency_distribution(rows, "total_dsh_turn"),
                "end_to_end": latency_distribution(rows, "end_to_end", "end_to_end_wall"),
            },
            "latency_ms_by_turn_reason": latency_by_turn_reason(rows),
        }
    return result


def _deltas(reference: dict[str, Any], candidate: dict[str, Any]) -> dict[str, float | None]:
    result = {}
    for metric in ("token_f1", "bleu1"):
        left = reference.get(metric)
        right = candidate.get(metric)
        result[metric] = None if left is None or right is None else float(right) - float(left)
    return result


def _category_deltas(reference: dict[str, Any], candidate: dict[str, Any]) -> dict[str, dict[str, float | None]]:
    return {
        category: _deltas(reference[category], candidate[category])
        for category in ("1", "3", "2", "4", "overall")
    }


def _material_category_regressions(category_deltas: dict[str, dict[str, float | None]]) -> dict[str, dict[str, float | None]]:
    threshold = 0.05
    return {
        category: deltas
        for category, deltas in category_deltas.items()
        if category != "overall" and any(value is not None and value < -threshold for value in deltas.values())
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare frozen LoCoMo arms and enforce parity gates.")
    parser.add_argument("--arm-a", type=Path, default=ARTIFACT_ROOT / "arm-a-upstream/predictions.jsonl")
    parser.add_argument("--arm-b", type=Path, default=ARTIFACT_ROOT / "arm-b-sidecar/predictions.jsonl")
    parser.add_argument("--arm-c", type=Path, default=ARTIFACT_ROOT / "arm-c-dsh/predictions.jsonl")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--frozen-manifest", type=Path, default=STATE_MANIFEST)
    parser.add_argument("--ab-only", action="store_true", help="Enforce A/B adapter parity before C starts.")
    parser.add_argument("--allow-partial-debug", action="store_true", help="Write a non-gating diff for an explicitly partial diagnostic prefix.")
    args = parser.parse_args()

    verify_scorer_hash()

    arms = {
        "A_UPSTREAM": read_index(args.arm_a),
        "B_SIDECAR": read_index(args.arm_b),
    }
    if not args.ab_only:
        arms["C_DSH"] = read_index(args.arm_c)
    expected_questions = questions_for_state(load_dataset(args.dataset), args.frozen_manifest)
    expected_ids = [item["question_id"] for item in expected_questions]
    for name, rows in arms.items():
        if list(rows) != expected_ids:
            raise ValueError(f"{name} prediction ids differ from frozen session scope: {len(rows)}/{len(expected_ids)}")
    paired = values_by_question(arms)
    output_path = args.output or ARTIFACT_ROOT / ("paired-diff-ab.jsonl" if args.ab_only else "paired-diff.jsonl")
    write_artifact_text(
        output_path,
        "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in paired),
    )

    scope = json.loads(args.frozen_manifest.read_text(encoding="utf-8"))
    expected_count = len(expected_ids)
    complete = len(paired) == expected_count
    score_metrics = {name: aggregate(list(index.values())) for name, index in arms.items()}
    gates = {}
    if args.ab_only:
        deltas = _deltas(score_metrics["A_UPSTREAM"]["overall"], score_metrics["B_SIDECAR"]["overall"])
        category_deltas = _category_deltas(score_metrics["A_UPSTREAM"], score_metrics["B_SIDECAR"])
        category_regressions = _material_category_regressions(category_deltas)
        gates["A_to_B"] = {
            "evaluated": complete,
            "passed": complete and all(value is not None and abs(value) <= 0.01 for value in deltas.values()) and not category_regressions,
            "tolerance": 0.01,
            "deltas": deltas,
            "category_deltas": category_deltas,
            "material_category_regression_threshold": 0.05,
            "material_category_regressions": category_regressions,
        }
    else:
        deltas = _deltas(score_metrics["B_SIDECAR"]["overall"], score_metrics["C_DSH"]["overall"])
        category_deltas = _category_deltas(score_metrics["B_SIDECAR"], score_metrics["C_DSH"])
        category_regressions = _material_category_regressions(category_deltas)
        gates["B_to_C"] = {
            "evaluated": complete,
            "passed": complete and all(value is not None and abs(value) <= 0.01 for value in deltas.values()) and not category_regressions,
            "tolerance": 0.01,
            "deltas": deltas,
            "category_deltas": category_deltas,
            "material_category_regression_threshold": 0.05,
            "material_category_regressions": category_regressions,
        }
    summary = {
        "included_questions": len(paired),
        "expected_included_questions": expected_count,
        "complete": complete,
        "scope": {
            "partial": bool(scope.get("partial")),
            "max_sessions": scope.get("max_sessions"),
            "completed_session_count": scope.get("completed_session_count"),
            "included_conversations": scope.get("included_conversations", []),
            "diagnostic_only": bool(scope.get("partial")),
        },
        "paired_comparison": metrics_summary(paired),
        "metrics": score_metrics,
        "parity_gates": gates,
        "usage_latency": usage_summary(arms),
    }
    output_json = output_path.with_name("comparison-summary-ab.json" if args.ab_only else "comparison-summary.json")
    write_artifact_text(output_json, json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2))

    if not complete and not args.allow_partial_debug:
        raise SystemExit("paired diff is partial; parity gate is not evaluated")
    if gates and any(not gate["passed"] for gate in gates.values()) and not args.allow_partial_debug:
        raise SystemExit("parity gate failed; diagnose the paired diff before continuing")


if __name__ == "__main__":
    main()
