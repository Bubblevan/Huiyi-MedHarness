#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from common import (
    ARTIFACT_ROOT,
    CONTRACT_MANIFEST,
    STATE_MANIFEST,
    STATE_COPIES_MANIFEST,
    digest_text,
    sha256_file,
    state_file_manifest,
)


ARMS = {
    "A_UPSTREAM": "arm-a-upstream",
    "B_SIDECAR": "arm-b-sidecar",
    "C_DSH": "arm-c-dsh",
}


def write_json_private(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, path)


def main() -> None:
    contract = json.loads(CONTRACT_MANIFEST.read_text(encoding="utf-8"))
    manifest = json.loads(STATE_MANIFEST.read_text(encoding="utf-8"))
    if contract.get("requiredStoreScope") != "full":
        raise SystemExit("arm state preparation requires the HC-MEM-003 full-store contract")
    if manifest.get("dataset_sha256") != contract["dataset"]["sha256"]:
        raise SystemExit("full-store dataset hash differs from the HC-MEM-003 contract")
    if manifest.get("partial") is not False or manifest.get("max_sessions") is not None:
        raise SystemExit("refusing to copy a partial memory store into the full benchmark arms")
    if manifest.get("conversation_count") != 10 or manifest.get("session_count") != 272:
        raise SystemExit("full-store manifest does not cover all 10 conversations and 272 sessions")
    if manifest.get("dialogue_items") != 5882:
        raise SystemExit("full-store manifest dialogue-item count differs from the frozen dataset")

    source = ARTIFACT_ROOT / "frozen-state-full"
    if not source.is_dir():
        raise SystemExit(f"full frozen source state is missing: {source}")
    source_files = state_file_manifest(source)
    expected_files = sorted(
        [
            {"path": entry["path"], "bytes": int(entry["bytes"]), "sha256": entry["sha256"]}
            for entry in manifest.get("files", [])
        ],
        key=lambda item: item["path"],
    )
    if not expected_files or source_files != expected_files:
        raise SystemExit("full frozen source state does not match its hash manifest")
    source_tree_hash = digest_text(json.dumps(source_files, sort_keys=True, separators=(",", ":")))

    ARTIFACT_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    ARTIFACT_ROOT.chmod(0o700)
    entries: dict[str, dict] = {}
    for arm, directory_name in ARMS.items():
        state_dir = ARTIFACT_ROOT / directory_name / "state"
        state_dir.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        state_dir.parent.chmod(0o700)
        if not state_dir.exists():
            shutil.copytree(source, state_dir, copy_function=shutil.copy2)
        actual = state_file_manifest(state_dir)
        if actual != expected_files:
            raise SystemExit(f"{arm} state copy differs from the common frozen source")
        entries[arm] = {
            "relative_state_dir": f"{directory_name}/state",
            "tree_sha256": digest_text(json.dumps(actual, sort_keys=True, separators=(",", ":"))),
            "files": actual,
        }
    if len({entry["tree_sha256"] for entry in entries.values()}) != 1:
        raise SystemExit("A/B/C state copies are not byte-identical")

    payload = {
        "task": "HC-MEM-003",
        "source_state": "frozen-state-full",
        "source_manifest_sha256": sha256_file(STATE_MANIFEST),
        "source_tree_sha256": source_tree_hash,
        "arms": entries,
        "byte_identical": True,
    }
    if STATE_COPIES_MANIFEST.exists():
        existing = json.loads(STATE_COPIES_MANIFEST.read_text(encoding="utf-8"))
        if existing != payload:
            raise SystemExit("arm copies manifest already exists with different state; refusing overwrite")
    else:
        write_json_private(STATE_COPIES_MANIFEST, payload)
    print(f"verified byte-identical full-state copies for {len(entries)} arms: {source_tree_hash}")


if __name__ == "__main__":
    main()
