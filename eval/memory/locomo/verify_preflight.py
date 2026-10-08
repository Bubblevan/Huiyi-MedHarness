#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from common import ARTIFACT_ROOT, CONTRACT_MANIFEST, DEFAULT_DATASET, included_questions, load_dataset, sha256_file


ARMS = {
    "A_UPSTREAM": "arm-a-upstream",
    "B_SIDECAR": "arm-b-sidecar",
    "C_DSH": "arm-c-dsh",
}
RUNAWAY_ID = "conv-30:qa-0001"


def read_rows(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate the common-token-cap HC-MEM-003 preflight on the immutable HC-MEM-002 store.")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--old-artifact-root", type=Path, default=Path("artifacts/hc-mem-002"))
    parser.add_argument("--slice-size", type=int, default=12)
    args = parser.parse_args()
    contract = json.loads(CONTRACT_MANIFEST.read_text(encoding="utf-8"))
    cap = int(contract["generation"]["maxTokens"])
    old_root = args.old_artifact_root.expanduser().resolve()
    old_manifest_path = old_root / "frozen-state-manifest.json"
    old_manifest = json.loads(old_manifest_path.read_text(encoding="utf-8"))
    if old_manifest.get("partial") is not True or old_manifest.get("max_sessions") != 30:
        raise ValueError("P0 preflight must use the immutable 30-session diagnostic state")
    questions = included_questions(load_dataset(args.dataset))
    selected = [q for q in questions if q["conversation_id"] in old_manifest["included_conversations"]]
    expected = [q["question_id"] for q in selected[:args.slice_size]]
    if RUNAWAY_ID not in {q["question_id"] for q in selected}:
        raise ValueError("the known runaway question is not in the old diagnostic scope")
    expected.append(RUNAWAY_ID)

    arms: dict[str, list[dict[str, Any]]] = {}
    for arm, directory in ARMS.items():
        path = ARTIFACT_ROOT / "preflight" / directory / "predictions.jsonl"
        rows = read_rows(path)
        ids = [row.get("question_id") for row in rows]
        if ids != expected:
            raise ValueError(f"{arm} did not run the identical 12-question slice plus runaway question")
        if any(row.get("qa_max_tokens") != cap for row in rows):
            raise ValueError(f"{arm} did not use the common {cap}-token output cap")
        if any(row.get("seed") != 0 for row in rows):
            raise ValueError(f"{arm} did not use the frozen generation seed")
        runaway_usage = rows[-1].get("qa_usage") or {}
        runaway_completion = runaway_usage.get("completion_tokens")
        if isinstance(runaway_completion, int) and runaway_completion > cap:
            raise ValueError(f"{arm} runaway question exceeded the common {cap}-token output cap")
        if rows[-1].get("finish_reason") == "length" and runaway_completion != cap:
            raise ValueError(f"{arm} reported a cap stop without exactly {cap} completion tokens")
        arms[arm] = rows

    summaries: dict[str, Any] = {}
    for arm, rows in arms.items():
        normal = rows[:-1]
        pathological = rows[-1]
        unparseable_normal = [row["question_id"] for row in normal if row.get("parse_error")]
        if unparseable_normal:
            raise ValueError(f"{arm} normal diagnostic answers are not parseable: {unparseable_normal[:3]}")
        if arm == "C_DSH":
            if pathological.get("turn_reason") != "max-tokens" or pathological.get("parse_error") != "TurnMaxTokens":
                raise ValueError("the known DSH pathological generation was not recorded as a max-token failure")
            if (pathological.get("qa_usage") or {}).get("completion_tokens") != cap:
                raise ValueError("the DSH runaway generation did not stop at the common output token cap")
            if pathological.get("response") != "" or pathological.get("automatic_recall_count") != 1:
                raise ValueError("the DSH max-token failure leaked a partial answer or violated recall-once")
            if pathological.get("model_step_count") != 1 or pathological.get("tool_call_count") != 0:
                raise ValueError("the DSH max-token diagnostic violated the one-step, no-tool profile")
            if pathological.get("memory_write_count") != 0 or pathological.get("commit_status") not in {"evaluation_read_only", "turn_max-tokens"}:
                raise ValueError("the DSH max-token diagnostic attempted a memory write")
        summaries[arm] = {
            "question_count": len(rows),
            "normal_parseable_count": len(normal) - len(unparseable_normal),
            "runaway_turn_reason": pathological.get("turn_reason"),
            "runaway_completion_tokens": (pathological.get("qa_usage") or {}).get("completion_tokens"),
            "runaway_parse_error": pathological.get("parse_error"),
            "runaway_read_only": pathological.get("memory_write_count", 0) == 0,
        }

    payload = {
        "task": "HC-MEM-003",
        "status": "P0_CAP_VERIFIED",
        "old_state_manifest_sha256": sha256_file(old_manifest_path),
        "question_ids_sha256": sha256_file(ARTIFACT_ROOT / "preflight" / "question-ids.txt")
        if (ARTIFACT_ROOT / "preflight" / "question-ids.txt").is_file() else None,
        "qa_max_tokens": cap,
        "slice_size": args.slice_size,
        "runaway_question_id": RUNAWAY_ID,
        "arms": summaries,
    }
    output = ARTIFACT_ROOT / "preflight" / "summary.json"
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    output.chmod(0o600)
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
