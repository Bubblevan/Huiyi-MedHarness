#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path
from typing import Any

from build_reference_store import session_plan
from common import (
    ARTIFACT_ROOT,
    CONTRACT_MANIFEST,
    DEFAULT_DATASET,
    STATE_COPIES_MANIFEST,
    STATE_MANIFEST,
    STATE_NAME,
    digest_text,
    load_dataset,
    sha256_file,
    state_file_manifest,
)


ARMS = {
    "A_UPSTREAM": "arm-a-upstream",
    "B_SIDECAR": "arm-b-sidecar",
    "C_DSH": "arm-c-dsh",
}


def write_private_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, path)


def validate_complete_conversation_prefix(
    manifest: dict[str, Any], contract: dict[str, Any], dataset: list[dict[str, Any]]
) -> list[str]:
    if contract.get("requiredStoreScope") != "complete-conversation-diagnostic":
        raise ValueError("diagnostic contract must explicitly name complete-conversation-diagnostic scope")
    if manifest.get("dataset_sha256") != contract["dataset"]["sha256"]:
        raise ValueError("frozen state dataset hash differs from diagnostic contract")
    if manifest.get("partial") is not True:
        raise ValueError("diagnostic state must remain explicitly partial")
    max_sessions = manifest.get("max_sessions")
    if not isinstance(max_sessions, int) or max_sessions < 1:
        raise ValueError("diagnostic state must record its bounded session prefix")

    all_sessions = session_plan(dataset, None)
    selected = session_plan(dataset, max_sessions)
    expected_keys = [f"{conv_id}:session-{number:02d}" for conv_id, _, number, _, _ in selected]
    if manifest.get("selected_session_keys") != expected_keys:
        raise ValueError("diagnostic session scope is not the exact dataset-order prefix")
    if manifest.get("completed_session_count") != len(expected_keys):
        raise ValueError("diagnostic completion count does not match its session scope")
    if manifest.get("session_count") != len(expected_keys):
        raise ValueError("diagnostic session count does not match its session scope")

    all_by_conversation: dict[str, list[str]] = {}
    for conv_id, _, number, _, _ in all_sessions:
        all_by_conversation.setdefault(conv_id, []).append(f"{conv_id}:session-{number:02d}")
    selected_conversations = list(dict.fromkeys(conv_id for conv_id, _, _, _, _ in selected))
    for conv_id in selected_conversations:
        if not set(all_by_conversation[conv_id]).issubset(expected_keys):
            raise ValueError(f"diagnostic prefix ends inside {conv_id}; only complete conversations are allowed")
    if manifest.get("included_conversations") != selected_conversations:
        raise ValueError("included conversation list differs from the complete prefix")
    if manifest.get("conversation_count") != len(selected_conversations):
        raise ValueError("diagnostic conversation count does not match the complete prefix")
    if manifest.get("dialogue_items") != sum(len(dialogue) for _, _, _, _, dialogue in selected):
        raise ValueError("diagnostic dialogue-item count differs from the selected conversations")
    return expected_keys


def main() -> None:
    parser = argparse.ArgumentParser(description="Copy a fully completed conversation prefix into diagnostic A/B/C states.")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--allow-complete-conversation-diagnostic", action="store_true", required=True)
    args = parser.parse_args()

    contract = json.loads(CONTRACT_MANIFEST.read_text(encoding="utf-8"))
    manifest = json.loads(STATE_MANIFEST.read_text(encoding="utf-8"))
    dataset = load_dataset(args.dataset)
    expected_keys = validate_complete_conversation_prefix(manifest, contract, dataset)

    source = ARTIFACT_ROOT / STATE_NAME
    if not source.is_dir():
        raise SystemExit(f"frozen diagnostic source is missing: {source}")
    source_files = state_file_manifest(source)
    expected_files = sorted(
        [
            {"path": item["path"], "bytes": int(item["bytes"]), "sha256": item["sha256"]}
            for item in manifest.get("files", [])
        ],
        key=lambda item: item["path"],
    )
    if not expected_files or source_files != expected_files:
        raise SystemExit("frozen diagnostic source does not match its file-hash manifest")
    source_hash = digest_text(json.dumps(source_files, sort_keys=True, separators=(",", ":")))

    entries: dict[str, dict[str, Any]] = {}
    for arm, directory_name in ARMS.items():
        state_dir = ARTIFACT_ROOT / directory_name / "state"
        state_dir.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        state_dir.parent.chmod(0o700)
        if not state_dir.exists():
            shutil.copytree(source, state_dir, copy_function=shutil.copy2)
        actual = state_file_manifest(state_dir)
        if actual != expected_files:
            raise SystemExit(f"{arm} state copy differs from the common diagnostic source")
        entries[arm] = {
            "relative_state_dir": f"{directory_name}/state",
            "tree_sha256": digest_text(json.dumps(actual, sort_keys=True, separators=(",", ":"))),
            "files": actual,
        }
    if len({entry["tree_sha256"] for entry in entries.values()}) != 1:
        raise SystemExit("diagnostic A/B/C state copies are not byte-identical")

    payload = {
        "task": "HC-MEM-003",
        "profile": "complete-conversation-diagnostic",
        "source_state": STATE_NAME,
        "source_manifest_sha256": sha256_file(STATE_MANIFEST),
        "source_tree_sha256": source_hash,
        "selected_session_count": len(expected_keys),
        "included_conversations": manifest["included_conversations"],
        "arms": entries,
        "byte_identical": True,
    }
    if STATE_COPIES_MANIFEST.exists():
        existing = json.loads(STATE_COPIES_MANIFEST.read_text(encoding="utf-8"))
        if existing != payload:
            raise SystemExit("diagnostic copies manifest already exists with a different state")
    else:
        write_private_json(STATE_COPIES_MANIFEST, payload)
    print(f"verified byte-identical diagnostic states: {len(expected_keys)} sessions, {len(entries)} arms, {source_hash}")


if __name__ == "__main__":
    main()
