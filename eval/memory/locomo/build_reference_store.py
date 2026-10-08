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
    AMA_ROOT, ARTIFACT_ROOT, CANONICAL_MODEL_ID, CONTRACT_MANIFEST, DEFAULT_DATASET, LOCAL_MODEL,
    STATE_NAME,
    configure_pinned_ama, load_dataset, sha256_file, verify_embedding_endpoint, verify_local_model_endpoint,
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


def session_plan(dataset: list[dict[str, Any]], max_sessions: int | None) -> list[tuple[str, dict[str, Any], int, str, list[dict[str, Any]]]]:
    plan = []
    for conv_index, row in enumerate(dataset):
        conv_id = str(row.get("sample_id", f"conversation-{conv_index + 1:02d}"))
        for session_number, timestamp, dialogue in sessions_for(row):
            plan.append((conv_id, row, session_number, timestamp, dialogue))
    if max_sessions is not None:
        if max_sessions < 1 or max_sessions > len(plan):
            raise SystemExit(f"--max-sessions must be in 1..{len(plan)}")
        return plan[:max_sessions]
    return plan


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
    parser.add_argument("--state-name", default=STATE_NAME, help="Frozen store name, e.g. frozen-state-full.")
    parser.add_argument("--max-sessions", type=int, help="Build the first N sessions in dataset order as an explicitly partial diagnostic store.")
    parser.add_argument("--finalize", action="store_true", help="Freeze/hash the completed selected session scope.")
    args = parser.parse_args()

    if not args.state_name.startswith("frozen-state") or "/" in args.state_name or "\\" in args.state_name:
        raise SystemExit("--state-name must be a simple name starting with 'frozen-state'")
    dataset = load_dataset(args.dataset)
    plan = session_plan(dataset, args.max_sessions)
    selected_keys = [f"{conv_id}:session-{session_number:02d}" for conv_id, _, session_number, _, _ in plan]
    selected_conversations = list(dict.fromkeys(conv_id for conv_id, _, _, _, _ in plan))
    work_dir = args.work_dir.expanduser().resolve()
    contract = json.loads(CONTRACT_MANIFEST.read_text(encoding="utf-8"))
    build_name = args.state_name.replace("frozen-state", "build-state", 1)
    working = work_dir / build_name
    frozen = work_dir / args.state_name
    manifest_path = work_dir / f"{args.state_name}-manifest.json"
    temporary = work_dir / f".{build_name}-session-tmp"
    backup = work_dir / f".{build_name}-backup"
    work_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if work_dir.is_relative_to(ARTIFACT_ROOT):
        work_dir.chmod(0o700)

    if not args.finalize:
        configure_pinned_ama()
        verify_local_model_endpoint()
        verify_embedding_endpoint()

    if args.finalize:
        if not working.is_dir():
            raise SystemExit("build-state is missing; run construction first")
        progress_path = working / "progress.json"
        progress = json.loads(progress_path.read_text(encoding="utf-8"))
        if progress.get("dataset_sha256") != sha256_file(args.dataset):
            raise SystemExit("dataset SHA256 changed since frozen-store construction began")
        if progress.get("selected_session_keys") != selected_keys:
            raise SystemExit("finalize scope differs from the scope used by the construction run; pass the same --max-sessions value")
        expected = len(selected_keys)
        if set(progress.get("completed_sessions", [])) != set(selected_keys):
            raise SystemExit(f"refusing to freeze incomplete state: {len(progress.get('completed_sessions', []))}/{expected} sessions")
        if contract.get("requiredStoreScope") == "full" and (
            args.max_sessions is not None
            or len(selected_conversations) != contract["dataset"]["conversationCount"]
            or expected != contract["dataset"]["sessionCount"]
            or progress["dialogue_items"] != contract["dataset"]["dialogueItemCount"]
        ):
            raise SystemExit("refusing to finalize a store that does not cover the frozen full-dataset scope")
        if frozen.exists() or manifest_path.exists():
            raise SystemExit("frozen store or manifest already exists; refusing to overwrite it")
        progress_path.unlink(missing_ok=True)
        entries = []
        for path in sorted(working.rglob("*")):
            if not path.is_file():
                continue
            entries.append({"path": path.relative_to(working).as_posix(), "sha256": sha256_file(path), "bytes": path.stat().st_size})
        write_json(manifest_path, {
            "dataset_sha256": sha256_file(args.dataset),
            "ama_commit": "a770f9aaef527ae589bf13015260cd24eda2d58c",
            "memory_model": CANONICAL_MODEL_ID,
            "memory_api_model": LOCAL_MODEL,
            "memory_model_revision": contract["models"]["memoryGenerator"]["sourceRevision"],
            "embedding_model": os.environ.get("HUIYI_LOCAL_EMBEDDING_MODEL", "Qwen3-Embedding-0.6B"),
            "embedding_model_revision": contract["models"]["embedding"]["sourceRevision"],
            "construction": "official evalProcess protocol: forwardUser each session item, judgeAndGenerate at each session boundary",
            "construction_settings": {
                "turnRetrieve": 1,
                "strongRetrieve": False,
                "temperature": 0.0,
                "dialogue_items_are_history_source_of_truth": True,
                "assistant_replies_generated": False,
            },
            "partial": args.max_sessions is not None,
            "max_sessions": args.max_sessions,
            "conversation_count": len(selected_conversations),
            "session_count": expected,
            "expected_sessions": expected,
            "completed_session_count": expected,
            "selected_session_keys": selected_keys,
            "included_conversations": selected_conversations,
            "dialogue_items": progress["dialogue_items"],
            "construction_llm_calls": progress["llm_calls"],
            "construction_prompt_tokens": progress["prompt_tokens"],
            "construction_completion_tokens": progress["completion_tokens"],
            "llm_calls": progress["llm_calls"],
            "prompt_tokens": progress["prompt_tokens"],
            "completion_tokens": progress["completion_tokens"],
            "files": entries,
        })
        os.replace(working, frozen)
        print(f"frozen state ready: {expected} sessions, {progress['dialogue_items']} dialogue items, {len(entries)} files")
        return

    recover_working_state(working, backup)
    if frozen.exists() or manifest_path.exists():
        raise SystemExit("frozen store or manifest exists; refusing to rebuild or overwrite it")
    dataset_hash = sha256_file(args.dataset)
    if not working.exists():
        working.mkdir(parents=True)
        write_json(working / "progress.json", {
            "dataset_sha256": dataset_hash,
            "completed_sessions": [], "dialogue_items": 0, "llm_calls": 0,
            "prompt_tokens": 0, "completion_tokens": 0,
            "max_sessions": args.max_sessions,
            "selected_session_keys": selected_keys,
        })

    if temporary.exists():
        shutil.rmtree(temporary)
    progress = json.loads((working / "progress.json").read_text(encoding="utf-8"))
    if progress.get("dataset_sha256") != dataset_hash:
        raise SystemExit("dataset SHA256 changed since frozen-store construction began")
    recorded_scope = progress.get("selected_session_keys")
    if recorded_scope is None:
        # Permit upgrading the existing pre-scope checkpoint only when all durable sessions
        # are contained in the requested deterministic prefix.
        if not set(progress.get("completed_sessions", [])).issubset(set(selected_keys)):
            raise SystemExit("existing build checkpoint is outside the requested session scope")
        progress["max_sessions"] = args.max_sessions
        progress["selected_session_keys"] = selected_keys
        write_json(working / "progress.json", progress)
    elif recorded_scope != selected_keys or progress.get("max_sessions") != args.max_sessions:
        raise SystemExit("resume scope differs from the existing build checkpoint")
    completed = set(progress["completed_sessions"])
    total_sessions = len(selected_keys)
    done = len(completed)

    for conv_id, row, session_number, timestamp, dialogue in plan:
        namespace = _namespace_for_conv(conv_id)
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

    print(f"construction complete for {total_sessions} selected sessions; run with the same --max-sessions value and --finalize to hash and freeze the state")


def _namespace_for_conv(conv_id: str) -> str:
    import hashlib

    return f"huiyi_{hashlib.sha256(f'locomo:{conv_id}'.encode('utf-8')).hexdigest()[:32]}"


if __name__ == "__main__":
    main()
