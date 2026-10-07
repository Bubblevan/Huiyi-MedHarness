#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path
from typing import Any

from common import ARTIFACT_ROOT, DEFAULT_DATASET, load_dataset, questions_for_state
from score import aggregate, verify_scorer_hash


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
        result.append({
            "question_id": question_id,
            "conversation_id": a.get("conversation_id"),
            "category": a.get("category"),
            "question": a.get("question"),
            "gold_answer": a.get("gold_answer"),
            "A_correct": None,
            "B_correct": None,
            "C_correct": None,
            "A_answer": a.get("response", ""),
            "B_answer": b.get("response", ""),
            "C_answer": c.get("response", "") if c else None,
            "A_parse_error": a.get("parse_error"),
            "B_parse_error": b.get("parse_error"),
            "C_parse_error": c.get("parse_error") if c else None,
            "A_B_retrieval_equivalent": a_hash == b_hash if a_hash is not None and b_hash is not None else None,
            "B_C_snapshot_equivalent": b_hash == c_hash if c and b_hash is not None and c_hash is not None else None,
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
            "C_automatic_recall_count": c.get("automatic_recall_count") if c else None,
            "C_commit_status": c.get("commit_status") if c else None,
        })
    return result


def metrics_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    def count(predicate):
        return sum(1 for row in rows if predicate(row))

    return {
        "count": len(rows),
        "A_B_retrieval_equal": count(lambda row: row["A_B_retrieval_equivalent"] is True),
        "A_B_retrieval_comparable": count(lambda row: row["A_B_retrieval_equivalent"] is not None),
        "B_C_snapshot_equal": count(lambda row: row["B_C_snapshot_equivalent"] is True),
        "B_C_snapshot_comparable": count(lambda row: row["B_C_snapshot_equivalent"] is not None),
        "A_B_answer_equal": count(lambda row: row["A_B_answer_equal"] is True),
        "B_C_answer_equal": count(lambda row: row["B_C_answer_equal"] is True),
        "C_one_recall": count(lambda row: row["C_automatic_recall_count"] == 1),
        "C_read_only_commit_skipped": count(lambda row: row["C_commit_status"] == "evaluation_read_only"),
    }


def safe_mean(values: list[float]) -> float | None:
    return statistics.mean(values) if values else None


def usage_summary(arms: dict[str, dict[str, dict[str, Any]]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for arm, records in arms.items():
        rows = list(records.values())
        result[arm] = {
            "qa_prompt_tokens": sum(int((row.get("qa_usage") or {}).get("prompt_tokens") or 0) for row in rows),
            "qa_completion_tokens": sum(int((row.get("qa_usage") or {}).get("completion_tokens") or 0) for row in rows),
            "ama_prompt_tokens": sum(int(row.get("ama_prompt_tokens") or 0) for row in rows),
            "ama_completion_tokens": sum(int(row.get("ama_completion_tokens") or 0) for row in rows),
            "ama_llm_calls": sum(int(row.get("ama_llm_call_count") or 0) for row in rows),
            "recall_latency_ms_mean": safe_mean([
                float((row.get("latency_ms") or {}).get("recall")) for row in rows
                if isinstance((row.get("latency_ms") or {}).get("recall"), (float, int))
            ]),
            "answer_latency_ms_mean": safe_mean([
                float((row.get("latency_ms") or {}).get("answer_generation")) for row in rows
                if isinstance((row.get("latency_ms") or {}).get("answer_generation"), (float, int))
            ]),
            "end_to_end_latency_ms_mean": safe_mean([
                float((row.get("latency_ms") or {}).get("end_to_end")) for row in rows
                if isinstance((row.get("latency_ms") or {}).get("end_to_end"), (float, int))
            ]),
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare frozen LoCoMo arms and enforce parity gates.")
    parser.add_argument("--arm-a", type=Path, default=ARTIFACT_ROOT / "arm-a-upstream/predictions.jsonl")
    parser.add_argument("--arm-b", type=Path, default=ARTIFACT_ROOT / "arm-b-sidecar/predictions.jsonl")
    parser.add_argument("--arm-c", type=Path, default=ARTIFACT_ROOT / "arm-c-dsh/predictions.jsonl")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--frozen-manifest", type=Path, default=ARTIFACT_ROOT / "frozen-state-manifest.json")
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
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in paired), encoding="utf-8")

    scope = json.loads(args.frozen_manifest.read_text(encoding="utf-8"))
    expected_count = len(expected_ids)
    complete = len(paired) == expected_count
    score_metrics = {name: aggregate(list(index.values())) for name, index in arms.items()}
    gates = {}
    if args.ab_only:
        deltas = _deltas(score_metrics["A_UPSTREAM"]["overall"], score_metrics["B_SIDECAR"]["overall"])
        gates["A_to_B"] = {
            "evaluated": complete,
            "passed": complete and all(value is not None and abs(value) <= 0.01 for value in deltas.values()),
            "tolerance": 0.01,
            "deltas": deltas,
            "category_deltas": _category_deltas(score_metrics["A_UPSTREAM"], score_metrics["B_SIDECAR"]),
        }
    else:
        deltas = _deltas(score_metrics["B_SIDECAR"]["overall"], score_metrics["C_DSH"]["overall"])
        gates["B_to_C"] = {
            "evaluated": complete,
            "passed": complete and all(value is not None and abs(value) <= 0.01 for value in deltas.values()),
            "tolerance": 0.01,
            "deltas": deltas,
            "category_deltas": _category_deltas(score_metrics["B_SIDECAR"], score_metrics["C_DSH"]),
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
    output_json.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))

    if not complete and not args.allow_partial_debug:
        raise SystemExit("paired diff is partial; parity gate is not evaluated")
    if gates and any(not gate["passed"] for gate in gates.values()) and not args.allow_partial_debug:
        raise SystemExit("parity gate failed; diagnose the paired diff before continuing")


if __name__ == "__main__":
    main()
