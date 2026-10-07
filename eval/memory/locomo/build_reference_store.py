#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

from common import (
    AMA_ROOT, ARTIFACT_ROOT, CANONICAL_MODEL_ID, DEFAULT_DATASET, LOCAL_MODEL,
    configure_pinned_ama, load_dataset, sha256_file, verify_local_model_endpoint,
)


def sessions_for(row: dict[str, Any]):
    conversation = row["conversation"]
    index = 1
    while f"session_{index}" in conversation:
        dialogue = conversation[f"session_{index}"]
        timestamp = conversation.get(f"session_{index}_date_time", "Unknown time")
        if dialogue:
            yield index, timestamp, dialogue
        index += 1


def write_json(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def recover_working_state(working: Path, backup: Path) -> None:
    if not working.exists() and backup.exists():
        os.replace(backup, working)
    elif working.exists() and backup.exists():
        shutil.rmtree(backup)


def run_session(
    row: dict[str, Any],
    namespace: str,
    session_number: int,
    timestamp: str,
    dialogue: list[dict[str, Any]],
    data_dir: Path,
) -> dict[str, int]:
    configure_pinned_ama()
    sys.path.insert(0, str(AMA_ROOT))
    from Core.AMA import AMA

    memory = AMA(
        user=namespace,
        modelMemory=LOCAL_MODEL,
        temperature=0.0,
        turnRetrieve=1,
        data_dir=str(data_dir),
    )
    calls_before = 0
    original_inference = memory.memoryAgent.inference

    def count_inference(*args: Any, **kwargs: Any) -> Any:
        nonlocal calls_before
        calls_before += 1
        kwargs["showUsage"] = True
        return original_inference(*args, **kwargs)

    memory.memoryAgent.inference = count_inference
    with open(os.devnull, "w", encoding="utf-8") as sink:
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            for item in dialogue:
                entry: dict[str, Any] = {
                    "speaker": item.get("speaker"),
                    "text": item.get("text", ""),
                    "timestamp": timestamp,
                }
                for source, target in (("blip_caption", "blip_caption"), ("query", "query"), ("img_url", "img_url")):
                    value = item.get(source)
                    if value:
                        entry[target] = value
                memory.forwardUser(entry, showUsage=True)
            memory.judgeAndGenerate()

    return {
        "dialogue_items": len(dialogue),
        "llm_calls": calls_before,
        "prompt_tokens": int(memory.memoryAgent.promptToken),
        "completion_tokens": int(memory.memoryAgent.completionToken),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the frozen LoCoMo AMA store using the pinned official construction lifecycle.")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--work-dir", type=Path, default=ARTIFACT_ROOT)
    parser.add_argument("--finalize", action="store_true", help="Freeze/hash the completed store; refuses incomplete conversations.")
    args = parser.parse_args()

    dataset = load_dataset(args.dataset)
    verify_local_model_endpoint()
    work_dir = args.work_dir.expanduser().resolve()
    working = work_dir / "build-state"
    frozen = work_dir / "frozen-state"
    temporary = work_dir / ".session-build-tmp"
    backup = work_dir / ".build-state-backup"
    work_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if work_dir.is_relative_to(ARTIFACT_ROOT):
        work_dir.chmod(0o700)

    if args.finalize:
        if not working.is_dir():
            raise SystemExit("build-state is missing; run construction first")
        progress_path = working / "progress.json"
        progress = json.loads(progress_path.read_text(encoding="utf-8"))
        if progress.get("dataset_sha256") != sha256_file(args.dataset):
            raise SystemExit("dataset SHA256 changed since frozen-store construction began")
        expected = sum(1 for conv_index, row in enumerate(dataset) for session, _, _ in sessions_for(row))
        if len(progress.get("completed_sessions", [])) != expected:
            raise SystemExit(f"refusing to freeze incomplete state: {len(progress.get('completed_sessions', []))}/{expected} sessions")
        if frozen.exists():
            raise SystemExit("frozen-state already exists; refusing to overwrite the frozen benchmark state")
        progress_path.unlink(missing_ok=True)
        entries = []
        for path in sorted(working.rglob("*")):
            if not path.is_file():
                continue
            entries.append({"path": path.relative_to(working).as_posix(), "sha256": sha256_file(path), "bytes": path.stat().st_size})
        write_json(work_dir / "frozen-state-manifest.json", {
            "dataset_sha256": sha256_file(args.dataset),
            "ama_commit": "a770f9aaef527ae589bf13015260cd24eda2d58c",
            "memory_model": CANONICAL_MODEL_ID,
            "memory_api_model": LOCAL_MODEL,
            "embedding_model": os.environ.get("HUIYI_LOCAL_EMBEDDING_MODEL", "Qwen3-Embedding-0.6B"),
            "construction": "official evalProcess protocol: forwardUser each session item, judgeAndGenerate at each session boundary",
            "completed_sessions": expected,
            "dialogue_items": progress["dialogue_items"],
            "llm_calls": progress["llm_calls"],
            "prompt_tokens": progress["prompt_tokens"],
            "completion_tokens": progress["completion_tokens"],
            "files": entries,
        })
        os.replace(working, frozen)
        print(f"frozen state ready: {expected} sessions, {progress['dialogue_items']} dialogue items, {len(entries)} files")
        return

    recover_working_state(working, backup)
    if frozen.exists():
        raise SystemExit("frozen-state exists; refusing to rebuild or overwrite it")
    dataset_hash = sha256_file(args.dataset)
    if not working.exists():
        working.mkdir(parents=True)
        write_json(working / "progress.json", {
            "dataset_sha256": dataset_hash,
            "completed_sessions": [], "dialogue_items": 0, "llm_calls": 0,
            "prompt_tokens": 0, "completion_tokens": 0,
        })

    if temporary.exists():
        shutil.rmtree(temporary)
    progress = json.loads((working / "progress.json").read_text(encoding="utf-8"))
    if progress.get("dataset_sha256") != dataset_hash:
        raise SystemExit("dataset SHA256 changed since frozen-store construction began")
    completed = set(progress["completed_sessions"])
    total_sessions = sum(1 for row in dataset for _ in sessions_for(row))
    done = len(completed)

    for conv_index, row in enumerate(dataset):
        conv_id = str(row.get("sample_id", f"conversation-{conv_index + 1:02d}"))
        namespace = _namespace_for_conv(conv_id)
        for session_number, timestamp, dialogue in sessions_for(row):
            session_key = f"{conv_id}:session-{session_number:02d}"
            if session_key in completed:
                continue
            shutil.copytree(working, temporary)
            stats = run_session(row, namespace, session_number, timestamp, dialogue, temporary)
            progress = json.loads((temporary / "progress.json").read_text(encoding="utf-8"))
            progress["completed_sessions"].append(session_key)
            for key in ("dialogue_items", "llm_calls", "prompt_tokens", "completion_tokens"):
                progress[key] = int(progress.get(key, 0)) + stats[key]
            write_json(temporary / "progress.json", progress)
            os.replace(working, backup)
            os.replace(temporary, working)
            shutil.rmtree(backup)
            completed.add(session_key)
            done += 1
            print(f"session {done}/{total_sessions} frozen into build state; dialogue_items={stats['dialogue_items']} llm_calls={stats['llm_calls']}", flush=True)

    print("construction complete; run with --finalize to hash and freeze the state")


def _namespace_for_conv(conv_id: str) -> str:
    import hashlib

    return f"huiyi_{hashlib.sha256(f'locomo:{conv_id}'.encode('utf-8')).hexdigest()[:32]}"


if __name__ == "__main__":
    main()
