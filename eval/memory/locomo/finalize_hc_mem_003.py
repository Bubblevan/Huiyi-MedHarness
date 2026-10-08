#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from common import ARTIFACT_ROOT, CONTRACT_MANIFEST, DEFAULT_DATASET, STATE_MANIFEST, STATE_NAME, load_dataset, questions_for_state, sha256_file, verify_state_copy
from compare import metrics_summary, read_index, usage_summary, values_by_question, _category_deltas, _deltas, _material_category_regressions
from score import aggregate, validate_ids, verify_scorer_hash


ARM_FILES = {
    "A_UPSTREAM": ARTIFACT_ROOT / "arm-a-upstream" / "predictions.jsonl",
    "B_SIDECAR": ARTIFACT_ROOT / "arm-b-sidecar" / "predictions.jsonl",
    "C_DSH": ARTIFACT_ROOT / "arm-c-dsh" / "predictions.jsonl",
}
DISPLAY_CATEGORIES = {"1": "single-hop", "3": "multi-hop", "2": "temporal", "4": "open-domain"}


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)


def pct(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int((percentile * len(ordered) + 0.999999)) - 1))
    return ordered[index]


def score_table(arms: dict[str, dict[str, dict[str, Any]]]) -> dict[str, dict[str, Any]]:
    return {name: aggregate(list(rows.values())) for name, rows in arms.items()}


def latency_table(arms: dict[str, dict[str, dict[str, Any]]]) -> dict[str, Any]:
    summary = usage_summary(arms)
    return {name: value["latency_ms"] for name, value in summary.items()}


def answer_summary(arms: dict[str, dict[str, dict[str, Any]]]) -> dict[str, Any]:
    rows = {name: list(index.values()) for name, index in arms.items()}
    return {
        name: {
            "parse_error_count": sum(bool(row.get("parse_error")) for row in records),
            "max_token_failure_count": sum(row.get("turn_reason") == "max-tokens" for row in records),
            "retrieval_round_distribution": dict(sorted({
                str(value): sum(row.get("retrieval_rounds") == value for row in records)
                for value in {row.get("retrieval_rounds") for row in records}
            }.items())),
            "retrieved_item_count": {
                "mean": statistics.mean([float(row.get("retrieved_count") or 0) for row in records]) if records else None,
                "p50": statistics.median([float(row.get("retrieved_count") or 0) for row in records]) if records else None,
                "p95": pct([float(row.get("retrieved_count") or 0) for row in records], .95),
                "max": max([int(row.get("retrieved_count") or 0) for row in records], default=None),
            },
            "citation_ref_validity": citation_summary(records),
        }
        for name, records in rows.items()
    }


def citation_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    refs = [row.get("citation_ref_validity") for row in rows]
    refs = [value for value in refs if isinstance(value, dict)]
    total = sum(int(value.get("reference_count") or 0) for value in refs)
    valid = sum(int(value.get("valid_reference_count") or 0) for value in refs)
    invalid = sum(int(value.get("invalid_reference_count") or 0) for value in refs)
    return {
        "questions_with_invalid_refs": sum(bool(value.get("has_invalid_reference")) for value in refs),
        "questions_with_at_least_one_ref": sum(int(value.get("reference_count") or 0) > 0 for value in refs),
        "questions_with_parsed_citation_field": len(refs),
        "total_refs": total,
        "valid_refs": valid,
        "invalid_refs": invalid,
        "validity_rate": valid / total if total else None,
    }


def category_table(metrics: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {
        DISPLAY_CATEGORIES[category]: {
            arm: {
                "count": values[category]["count"],
                "token_f1": values[category]["token_f1"],
                "bleu1": values[category]["bleu1"],
                "parse_error_count": values[category]["parse_error_count"],
            }
            for arm, values in metrics.items()
        }
        for category in DISPLAY_CATEGORIES
    }


def make_gates(metrics: dict[str, dict[str, Any]], paired_summary: dict[str, Any], expected: int) -> dict[str, Any]:
    ab = _deltas(metrics["A_UPSTREAM"]["overall"], metrics["B_SIDECAR"]["overall"])
    bc = _deltas(metrics["B_SIDECAR"]["overall"], metrics["C_DSH"]["overall"])
    ac = _deltas(metrics["A_UPSTREAM"]["overall"], metrics["C_DSH"]["overall"])
    ab_categories = _category_deltas(metrics["A_UPSTREAM"], metrics["B_SIDECAR"])
    bc_categories = _category_deltas(metrics["B_SIDECAR"], metrics["C_DSH"])
    ac_categories = _category_deltas(metrics["A_UPSTREAM"], metrics["C_DSH"])
    ab_regressions = _material_category_regressions(ab_categories)
    bc_regressions = _material_category_regressions(bc_categories)
    ac_regressions = _material_category_regressions(ac_categories)
    complete = paired_summary["count"] == expected
    a_b_retrieval_equal = paired_summary["A_B_retrieval_equal"] == expected
    b_c_snapshot_equal = paired_summary["B_C_snapshot_equal"] == expected
    b_c_source_equal = paired_summary["B_C_source_refs_equal"] == expected
    c_single_recall = paired_summary["C_one_recall"] == expected
    c_one_step = paired_summary["C_one_model_step"] == expected
    c_no_tools = paired_summary["C_zero_tool_calls"] == expected
    c_no_writes = paired_summary["C_zero_memory_writes"] == expected
    return {
        "artifact_integrity": {"passed": complete and a_b_retrieval_equal and b_c_snapshot_equal and b_c_source_equal and c_single_recall and c_one_step and c_no_tools and c_no_writes},
        "A_to_B": {
            "passed": complete and a_b_retrieval_equal and all(value is not None and abs(value) <= .01 for value in ab.values()) and not ab_regressions,
            "tolerance": .01,
            "deltas": ab,
            "category_deltas": ab_categories,
            "material_category_regressions": ab_regressions,
        },
        "B_to_C": {
            "passed": complete and b_c_snapshot_equal and b_c_source_equal and c_single_recall and c_one_step and c_no_tools and c_no_writes
            and all(value is not None and abs(value) <= .01 for value in bc.values()) and not bc_regressions,
            "tolerance": .01,
            "deltas": bc,
            "category_deltas": bc_categories,
            "material_category_regressions": bc_regressions,
        },
        "A_to_C": {
            "passed": complete and all(value is not None and value >= -.01 for value in ac.values()),
            "minimum_delta": -.01,
            "deltas": ac,
            "category_deltas": ac_categories,
            "material_category_regressions": ac_regressions,
        },
        "retrieval_integrity": {
            "A_B_equal": a_b_retrieval_equal,
            "A_B_equal_count": paired_summary["A_B_retrieval_equal"],
            "B_C_snapshot_equal": b_c_snapshot_equal,
            "B_C_snapshot_equal_count": paired_summary["B_C_snapshot_equal"],
            "B_C_source_refs_equal": b_c_source_equal,
            "B_C_source_refs_equal_count": paired_summary["B_C_source_refs_equal"],
        },
        "C_runtime_invariants": {
            "one_recall_each": c_single_recall,
            "one_model_step_each": c_one_step,
            "zero_tool_calls_each": c_no_tools,
            "zero_memory_writes_each": c_no_writes,
        },
    }


def render_report(payload: dict[str, Any], bootstrap: dict[str, Any]) -> str:
    model_table = payload["metrics"]
    usage = payload["usage_latency"]
    lines = [
        "# HC-MEM-003 Full LoCoMo DSH Parity",
        "",
        f"Generated: {payload['generated_at_utc']}",
        "",
        "## Reproduction configuration",
        "",
        f"- Dataset SHA-256: `{payload['dataset']['sha256']}`",
        f"- Scope: {payload['dataset']['conversation_count']} conversations, {payload['dataset']['session_count']} sessions, {payload['dataset']['dialogue_item_count']} dialogue items, {payload['dataset']['included_question_count']} scored questions; category 5 excluded ({payload['dataset']['excluded_category_5_count']}).",
        f"- AMA: `{payload['ama_commit']}`; DSH: `{payload['dsh_commit']}` (`{payload['dsh_version']}`).",
        f"- QA model: `{payload['models']['qa_id']}` revision `{payload['models']['qa_revision']}`; alias `{payload['models']['served_alias']}`; context `{payload['models']['context_window']}`; vLLM `{payload['models']['vllm_version']}` ({payload['models']['vllm_dtype']}, max model length `{payload['models']['vllm_max_model_len']}`).",
        f"- Embedding: `{payload['models']['embedding_id']}` revision `{payload['models']['embedding_revision']}`, native {payload['models']['embedding_native_dimension']} dimensions, zero-padded to 3072.",
        f"- Generation: temperature `{payload['generation']['temperature']}`, seed `{payload['generation']['seed']}`, thinking `{payload['generation']['thinking_enabled']}`, `max_tokens={payload['generation']['max_tokens']}` in every arm.",
        f"- Retrieval: `strongRetrieve={payload['retrieval']['strongRetrieve']}`, `turnRetrieve={payload['retrieval']['turnRetrieve']}`, `topK={payload['retrieval']['topK']}`; construction uses `turnRetrieve=1`, `strongRetrieve=false`.",
        f"- Store construction: {payload['construction']['session_count']} sessions, {payload['construction']['dialogue_items']} dialogue items, {payload['construction']['llm_calls']} AMA model calls, {payload['construction']['prompt_tokens']} prompt tokens, {payload['construction']['completion_tokens']} completion tokens.",
        f"- Scorer SHA-256: `{payload['scorer_sha256']}`. No LLM judge was run.",
        "",
        "## Full A/B/C results",
        "",
        "| Arm | Token-F1 | BLEU-1 | Parse errors | QA prompt tokens | QA completion tokens | P50 end-to-end (ms) | P95 end-to-end (ms) |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for arm, label in (("A_UPSTREAM", "A upstream"), ("B_SIDECAR", "B sidecar"), ("C_DSH", "C DSH")):
        overall = model_table[arm]["overall"]
        latency = usage[arm]["latency_ms_by_turn_reason"]["completed"]["end_to_end"]
        tokens = payload["usage_latency"][arm]
        lines.append(
            f"| {label} | {overall['token_f1']:.4f} | {overall['bleu1']:.4f} | {overall['parse_error_count']} | "
            f"{tokens['qa_prompt_tokens']} | {tokens['qa_completion_tokens']} | {latency['p50_ms']:.1f} | {latency['p95_ms']:.1f} |"
        )
    lines.extend(["", "## Category breakdown", "", "| Category | Count | A F1 / BLEU | B F1 / BLEU | C F1 / BLEU |", "|---|---:|---:|---:|---:|"])
    for category, arms in payload["category_metrics"].items():
        count = arms["A_UPSTREAM"]["count"]
        values = [f"{arms[name]['token_f1']:.4f} / {arms[name]['bleu1']:.4f}" for name in ("A_UPSTREAM", "B_SIDECAR", "C_DSH")]
        lines.append(f"| {category} | {count} | {values[0]} | {values[1]} | {values[2]} |")
    lines.extend(["", "## Parity deltas and paired confidence intervals", ""])
    for gate, label in (("A_to_B", "A → B"), ("B_to_C", "B → C"), ("A_to_C", "A → C")):
        gate_data = payload["gates"][gate]
        boot = bootstrap["comparisons"][gate.replace("_to_", "_to_")]
        f1_ci = boot["Token-F1"]
        bleu_ci = boot["BLEU-1"]
        lines.append(
            f"- {label}: Token-F1 Δ `{gate_data['deltas']['token_f1']:+.4f}` (question 95% CI `{f1_ci['question_level']['lower_95']:+.4f}` to `{f1_ci['question_level']['upper_95']:+.4f}`; conversation-cluster CI `{f1_ci['conversation_cluster']['lower_95']:+.4f}` to `{f1_ci['conversation_cluster']['upper_95']:+.4f}`); "
            f"BLEU-1 Δ `{gate_data['deltas']['bleu1']:+.4f}` (question CI `{bleu_ci['question_level']['lower_95']:+.4f}` to `{bleu_ci['question_level']['upper_95']:+.4f}`; cluster CI `{bleu_ci['conversation_cluster']['lower_95']:+.4f}` to `{bleu_ci['conversation_cluster']['upper_95']:+.4f}`)."
        )
    lines.extend(["", "## Integrity and runtime diagnostics", ""])
    paired = payload["paired_integrity"]
    lines.append(f"- A/B retrieval equality: {paired['A_B_retrieval_equal']}/{payload['dataset']['included_question_count']}; B/C snapshot equality: {paired['B_C_snapshot_equal']}/{payload['dataset']['included_question_count']}; B/C source-reference equality: {paired['B_C_source_refs_equal']}/{payload['dataset']['included_question_count']}.")
    lines.append(f"- C one recall / one model step / zero tool calls / zero writes: {paired['C_one_recall']}/{payload['dataset']['included_question_count']}, {paired['C_one_model_step']}/{payload['dataset']['included_question_count']}, {paired['C_zero_tool_calls']}/{payload['dataset']['included_question_count']}, {paired['C_zero_memory_writes']}/{payload['dataset']['included_question_count']}.")
    lines.append(f"- Max-token failures A/B/C: {payload['answer_diagnostics']['A_UPSTREAM']['max_token_failure_count']}/{payload['answer_diagnostics']['B_SIDECAR']['max_token_failure_count']}/{payload['answer_diagnostics']['C_DSH']['max_token_failure_count']}.")
    for arm, label in (("A_UPSTREAM", "A"), ("B_SIDECAR", "B"), ("C_DSH", "C")):
        citation = payload["answer_diagnostics"][arm]["citation_ref_validity"]
        lines.append(f"- {label} citation refs: {citation['valid_refs']}/{citation['total_refs']} valid; {citation['invalid_refs']} invalid across {citation['questions_with_invalid_refs']} questions.")
    lines.extend(["", "## Token use and warm latency", ""])
    for arm, label in (("A_UPSTREAM", "A"), ("B_SIDECAR", "B"), ("C_DSH", "C")):
        values = payload["usage_latency"][arm]
        e2e = values["latency_ms"]["end_to_end"]
        normal = values["latency_ms_by_turn_reason"]["completed"]["end_to_end"]
        capped = values["latency_ms_by_turn_reason"]["max-tokens"]["end_to_end"]
        lines.append(f"- {label}: QA prompt/completion/total `{values['qa_prompt_tokens']}/{values['qa_completion_tokens']}/{values['qa_total_tokens']}` (usage missing on {values['qa_usage_missing_count']} questions); AMA prompt/completion/calls `{values['ama_prompt_tokens']}/{values['ama_completion_tokens']}/{values['ama_llm_calls']}`; completed end-to-end mean/median/P95/max `{normal['mean_ms']:.1f}/{normal['median_ms']:.1f}/{normal['p95_ms']:.1f}/{normal['max_ms']:.1f} ms; all-turn range median/P95/max `{e2e['median_ms']:.1f}/{e2e['p95_ms']:.1f}/{e2e['max_ms']:.1f} ms; capped-run count/max latency `{capped['count']}/{capped['max_ms']}`.")
    qa_a, qa_b, qa_c = (payload["usage_latency"][name]["qa_prompt_tokens"] for name in ("A_UPSTREAM", "B_SIDECAR", "C_DSH"))
    lines.append(f"- QA prompt-token deltas: A→B `{qa_b - qa_a:+d}`; B→C `{qa_c - qa_b:+d}`.")
    lines.append("- Cold startup is excluded. AMA Token-F1/BLEU paper scores use an external GPT-4o-mini judge only for the paper's LLM Score; this task does not evaluate or compare that score.")
    local_reference = payload["local_frozen_reference"]
    lines.extend([
        "",
        "## Local frozen reference",
        "",
        f"Status: `{local_reference['status']}`. {local_reference['provenanceCompleteness']}. The previously located smoke runs are not used as a parity baseline; Arm A is the canonical same-machine upstream reference for A/B/C.",
        "",
        "## Paper reference and final status",
        "",
        "Qwen3-8B AMA paper reference: Token-F1 `0.510`, BLEU-1 `0.432`, LLM Score `0.707` (GPT-4o-mini). The LLM Score is not directly evaluated here.",
        "",
    ])
    for key, value in payload["final_status"].items():
        lines.append(f"- `{key}`: `{value}`")
    lines.extend(["", "This is the full frozen LoCoMo evaluation. Local frozen reproduction parity is reported separately because the previous full local reference was not recovered; Arm A is the canonical local upstream reference for this run.", ""])
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Freeze sanitized HC-MEM-003 full LoCoMo metrics and final report.")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--bootstrap", type=Path, default=ARTIFACT_ROOT / "bootstrap-summary.json")
    args = parser.parse_args()

    contract = json.loads(CONTRACT_MANIFEST.read_text(encoding="utf-8"))
    if contract.get("task") != "HC-MEM-003" or contract.get("requiredStoreScope") != "full":
        raise SystemExit("finalization requires the HC-MEM-003 full-store contract")
    manifest = json.loads(STATE_MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("partial") is not False or manifest.get("max_sessions") is not None:
        raise SystemExit("cannot finalize metrics from a partial memory store")
    if len(manifest.get("included_conversations", [])) != 10 or manifest.get("session_count") != 272 or manifest.get("dialogue_items") != 5882:
        raise SystemExit("full frozen memory state does not match the 10-conversation construction scope")
    expected_questions = questions_for_state(load_dataset(args.dataset), STATE_MANIFEST)
    if len(expected_questions) != 1540:
        raise SystemExit("full scored cohort must contain exactly 1540 non-category-5 questions")
    preflight_path = ARTIFACT_ROOT / "preflight" / "summary.json"
    if not preflight_path.is_file():
        raise SystemExit("the common-cap preflight must pass before full evaluation is finalized")
    preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
    if preflight.get("status") != "P0_CAP_VERIFIED" or preflight.get("qa_max_tokens") != int(contract["generation"]["maxTokens"]):
        raise SystemExit("the common-cap preflight did not pass with the frozen HC-MEM-003 token cap")
    for directory in ("arm-a-upstream", "arm-b-sidecar", "arm-c-dsh"):
        verify_state_copy(ARTIFACT_ROOT / directory / "state")
    verify_scorer_hash()

    arms = {name: read_index(path) for name, path in ARM_FILES.items()}
    expected_ids = [row["question_id"] for row in expected_questions]
    for name, rows in arms.items():
        if list(rows) != expected_ids:
            raise SystemExit(f"{name} must contain the same ordered 1540 question IDs")
        validate_ids(list(rows.values()), expected_questions, allow_partial=False)
        for row in rows.values():
            if row.get("qa_max_tokens") != int(contract["generation"]["maxTokens"]):
                raise SystemExit(f"{name} contains a question with a non-contract output cap")
            if row.get("seed") != int(contract["generation"]["randomSeed"]):
                raise SystemExit(f"{name} contains a question with a non-contract generation seed")
            if row.get("temperature") != float(contract["generation"]["temperature"]):
                raise SystemExit(f"{name} contains a question with a non-contract temperature")
            if row.get("model") != contract["models"]["qaGenerator"]["id"]:
                raise SystemExit(f"{name} contains a question from a different QA generator model")
            if row.get("api_model") != contract["models"]["qaGenerator"]["servedModelName"]:
                raise SystemExit(f"{name} contains a question from a different served QA model")
            if row.get("memory_model") != contract["models"]["memoryGenerator"]["id"]:
                raise SystemExit(f"{name} contains a question from a different AMA memory model")
            if row.get("memory_api_model") != contract["models"]["memoryGenerator"]["servedModelName"]:
                raise SystemExit(f"{name} contains a question from a different served AMA memory model")
            if row.get("top_k") != int(contract["memoryRetrieval"]["topK"]):
                raise SystemExit(f"{name} contains a question with a different topK setting")
            if row.get("turn_retrieve") != int(contract["memoryRetrieval"]["turnRetrieve"]):
                raise SystemExit(f"{name} contains a question with a different turnRetrieve setting")
            if row.get("strong_retrieve") is not contract["memoryRetrieval"]["strongRetrieve"]:
                raise SystemExit(f"{name} contains a question with a different strongRetrieve setting")
            if row.get("read_only") is not True:
                raise SystemExit(f"{name} contains a QA turn that was not read-only")

    paired = values_by_question(arms)
    paired_summary = metrics_summary(paired)
    metrics = score_table(arms)
    gates = make_gates(metrics, paired_summary, len(expected_questions))
    usage = usage_summary(arms)
    diagnostics = answer_summary(arms)
    paper = contract["paperReference"]
    paper_target = {
        "token_f1_target": float(paper["tokenF1"]),
        "bleu1_target": float(paper["bleu1"]),
        "token_f1_passed": float(metrics["C_DSH"]["overall"]["token_f1"]) >= float(paper["tokenF1"]),
        "bleu1_passed": float(metrics["C_DSH"]["overall"]["bleu1"]) >= float(paper["bleu1"]),
        "judge_score": "not evaluated; exact GPT-4o-mini protocol not run",
    }
    parity_passed = all(gates[name]["passed"] for name in ("artifact_integrity", "A_to_B", "B_to_C", "A_to_C"))
    if parity_passed and paper_target["token_f1_passed"] and paper_target["bleu1_passed"]:
        final_status = {"parity": "PASS_FULL_DSH_PARITY", "paper_target": "PASS_PAPER_TARGET", "completion": "HC_MEM_COMPLETE"}
    elif parity_passed:
        final_status = {"parity": "PASS_FULL_DSH_PARITY", "paper_target": "FAIL_PAPER_TARGET", "completion": "HC_MEM_EVALUATION_COMPLETE"}
    elif not gates["A_to_B"]["passed"]:
        final_status = {"parity": "FAIL_HUIYI_ADAPTER_PARITY", "paper_target": "NOT_ASSESSED", "completion": "HC_MEM_EVALUATION_COMPLETE"}
    else:
        final_status = {"parity": "FAIL_DSH_PARITY", "paper_target": "NOT_ASSESSED", "completion": "HC_MEM_EVALUATION_COMPLETE"}

    bootstrap = json.loads(args.bootstrap.read_text(encoding="utf-8"))
    if bootstrap.get("question_count") != 1540 or bootstrap.get("conversation_count") != 10 or bootstrap.get("replicates") != 10_000:
        raise SystemExit("bootstrap summary does not match the frozen full-cohort settings")
    all_states_path = ARTIFACT_ROOT / f"{STATE_NAME}-copies-manifest.json"
    if not all_states_path.is_file():
        raise SystemExit("A/B/C frozen state copy manifest is missing")
    state_copies = json.loads(all_states_path.read_text(encoding="utf-8"))
    if state_copies.get("byte_identical") is not True or state_copies.get("source_manifest_sha256") != sha256_file(STATE_MANIFEST):
        raise SystemExit("A/B/C state copies do not share the verified full-state source manifest")
    copy_tree_hashes = {entry.get("tree_sha256") for entry in state_copies.get("arms", {}).values()}
    if len(state_copies.get("arms", {})) != 3 or len(copy_tree_hashes) != 1 or None in copy_tree_hashes:
        raise SystemExit("A/B/C full-state copies are not recorded as byte-identical")

    generated = datetime.now(timezone.utc).isoformat()
    sanitized = {
        "task": "HC-MEM-003",
        "generated_at_utc": generated,
        "baseline_commit": "92252c96ad28e642631a9175f74f9b9af30b1a4e",
        "source_commit_before_finalization": __import__("subprocess").check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "ama_commit": contract["amaCommit"],
        "dsh_commit": contract["dshCommit"],
        "dsh_version": contract["dshVersion"],
        "dataset": {
            "sha256": contract["dataset"]["sha256"],
            "conversation_count": 10,
            "session_count": 272,
            "dialogue_item_count": 5882,
            "total_question_count": 1986,
            "included_question_count": 1540,
            "excluded_category_5_count": 446,
            "category_counts_included": contract["dataset"]["categoryCountsIncluded"],
        },
        "models": {
            "qa_id": contract["models"]["qaGenerator"]["id"],
            "qa_revision": contract["models"]["qaGenerator"]["sourceRevision"],
            "served_alias": contract["models"]["qaGenerator"]["servedModelName"],
            "context_window": contract["models"]["qaGenerator"]["contextWindow"],
            "vllm_version": contract["inferenceEngine"]["version"],
            "vllm_dtype": contract["inferenceEngine"].get("dtype"),
            "vllm_max_model_len": contract["inferenceEngine"]["maxModelLen"],
            "vllm_gpu_memory_utilization": contract["inferenceEngine"].get("gpuMemoryUtilization"),
            "embedding_id": contract["models"]["embedding"]["id"],
            "embedding_revision": contract["models"]["embedding"]["sourceRevision"],
            "embedding_native_dimension": contract["models"]["embedding"]["nativeOutputDimension"],
            "embedding_ama_dimension": contract["models"]["embedding"]["amaDimension"],
        },
        "generation": {
            "temperature": contract["generation"]["temperature"],
            "seed": contract["generation"]["randomSeed"],
            "thinking_enabled": contract["models"]["qaGenerator"]["thinkingEnabled"],
            "max_tokens": int(contract["generation"]["maxTokens"]),
        },
        "retrieval": {
            "strongRetrieve": contract["memoryRetrieval"]["strongRetrieve"],
            "turnRetrieve": contract["memoryRetrieval"]["turnRetrieve"],
            "topK": contract["memoryRetrieval"]["topK"],
            "construction_turnRetrieve": contract["memoryRetrieval"]["construction"]["turnRetrieve"],
            "construction_strongRetrieve": contract["memoryRetrieval"]["construction"]["strongRetrieve"],
        },
        "construction": {
            "conversation_count": manifest["conversation_count"],
            "session_count": manifest["session_count"],
            "dialogue_items": manifest["dialogue_items"],
            "llm_calls": manifest["construction_llm_calls"],
            "prompt_tokens": manifest["construction_prompt_tokens"],
            "completion_tokens": manifest["construction_completion_tokens"],
            "settings": manifest["construction_settings"],
            "state_file_count": len(manifest["files"]),
            "state_tree_sha256": json.loads((ARTIFACT_ROOT / f"{STATE_NAME}-copies-manifest.json").read_text(encoding="utf-8"))["source_tree_sha256"],
        },
        "scorer_sha256": contract["scorer"]["localImplementationSha256"],
        "metrics": metrics,
        "category_metrics": category_table(metrics),
        "deltas": {
            "A_to_B": gates["A_to_B"]["deltas"],
            "B_to_C": gates["B_to_C"]["deltas"],
            "A_to_C": gates["A_to_C"]["deltas"],
        },
        "paired_integrity": paired_summary,
        "gates": gates,
        "answer_diagnostics": diagnostics,
        "usage_latency": usage,
        "token_deltas": {
            "A_to_B_prompt_tokens": usage["B_SIDECAR"]["qa_prompt_tokens"] - usage["A_UPSTREAM"]["qa_prompt_tokens"],
            "B_to_C_prompt_tokens": usage["C_DSH"]["qa_prompt_tokens"] - usage["B_SIDECAR"]["qa_prompt_tokens"],
        },
        "bootstrap_summary_sha256": sha256_file(args.bootstrap),
        "frozen_state_manifest_sha256": sha256_file(STATE_MANIFEST),
        "frozen_state_copies_sha256": sha256_file(all_states_path),
        "paper_reference": paper,
        "paper_target": paper_target,
        "local_frozen_reference": contract["localFrozenReference"],
        "final_status": final_status,
    }
    write_json(ARTIFACT_ROOT / "aggregate-metrics.json", sanitized)
    write_json(ARTIFACT_ROOT / "reference" / "local-reproduction.json", contract["localFrozenReference"])
    write_json(ARTIFACT_ROOT / "readiness.json", {
        "task": "HC-MEM-003",
        "baselineCommit": sanitized["baseline_commit"],
        "sourceCommitBeforeFinalization": sanitized["source_commit_before_finalization"],
        "amaCommit": sanitized["ama_commit"],
        "dshCommit": sanitized["dsh_commit"],
        "datasetHash": sanitized["dataset"]["sha256"],
        "includedCount": 1540,
        "excludedCategory5Count": 446,
        "model": sanitized["models"],
        "generation": sanitized["generation"],
        "retrieval": sanitized["retrieval"],
        "construction": sanitized["construction"],
        "metrics": metrics,
        "deltas": sanitized["deltas"],
        "gates": gates,
        "tokenAccounting": usage,
        "latency": latency_table(arms),
        "paperTarget": paper_target,
        "localReference": sanitized["local_frozen_reference"],
        "finalStatus": final_status,
    })
    write_json(ARTIFACT_ROOT / "benchmark-manifest.json", {
        **contract,
        "resolved": {
            "qaMaxTokens": int(contract["generation"]["maxTokens"]),
            "fullStoreManifestSha256": sanitized["frozen_state_manifest_sha256"],
            "fullStoreCopiesManifestSha256": sanitized["frozen_state_copies_sha256"],
            "stateTreeSha256": state_copies["source_tree_sha256"],
            "preflightSummarySha256": sha256_file(ARTIFACT_ROOT / "preflight" / "summary.json"),
            "scorerSha256Verified": verify_scorer_hash(),
        },
    })
    report = render_report(sanitized, bootstrap)
    report_path = ARTIFACT_ROOT / "final-report.md"
    report_path.write_text(report, encoding="utf-8")
    report_path.chmod(0o600)
    print(json.dumps({"final_status": final_status, "metrics": {name: values["overall"] for name, values in metrics.items()}, "report": str(report_path)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
