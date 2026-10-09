#!/usr/bin/env python3
"""Freeze a small question/options-only MedQA dev diagnostic projection."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


EXPECTED_SOURCE_SHA256 = "6bdc019180ebf82908c5690b6266898341fee5fd3b807ed0201c39c93f3424c6"
SELECTED_INDICES = (0, 50, 100, 150)
LETTERS = ("A", "B", "C", "D", "E")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def answer_letter(row: dict[str, object]) -> str:
    options = row.get("options")
    raw = row.get("answer_idx")
    if isinstance(options, dict):
        if isinstance(raw, str) and raw.upper() in options:
            return raw.upper()
        if isinstance(raw, int) and 0 <= raw < len(LETTERS):
            candidate = LETTERS[raw]
            if candidate in options:
                return candidate
        answer = row.get("answer")
        if isinstance(answer, str):
            for letter, text in options.items():
                if isinstance(text, str) and text.strip() == answer.strip() and letter in LETTERS:
                    return letter
    raise ValueError("selected dev row has no supported answer key")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dataset",
        default="/root/gpufree-data/clinical-r1-repro/upstream/Clinical-R1-3B/data/raw/medqa_dev.jsonl",
    )
    parser.add_argument("--out-dir", default="/root/gpufree-data/repro/hc-ma-002/medqa-dev-diagnostic")
    parser.add_argument("--metadata", default="artifacts/hc-ma-002/diagnostic-selection.json")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    source = Path(args.dataset).resolve()
    if source.name != "medqa_dev.jsonl" or "test" in source.parts:
        raise SystemExit("source must be the pinned MedQA dev split; test split paths are refused")
    raw = source.read_bytes()
    source_sha = sha256_bytes(raw)
    if source_sha != EXPECTED_SOURCE_SHA256:
        raise SystemExit("MedQA dev source hash differs from the frozen HC-MA-002 diagnostic source")

    out_dir = Path(args.out_dir).resolve()
    if out_dir == repo_root or repo_root in out_dir.parents:
        raise SystemExit("raw question projections and answer keys must stay outside the Git worktree")
    out_dir.mkdir(parents=True, exist_ok=True)
    input_path = out_dir / "questions.jsonl"
    answer_key_path = out_dir / "answer-key.json"

    rows = [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]
    if len(rows) != 1272 or max(SELECTED_INDICES) >= len(rows):
        raise SystemExit("MedQA dev row count differs from the frozen selection")

    projections: list[dict[str, object]] = []
    answer_key: dict[str, str] = {}
    selected_metadata: list[dict[str, object]] = []
    for row_index in SELECTED_INDICES:
        row = rows[row_index]
        question = row.get("question")
        options = row.get("options")
        if not isinstance(question, str) or not question.strip() or not isinstance(options, dict):
            raise SystemExit(f"invalid question/options projection at dev row {row_index}")
        if set(options) != set(LETTERS) or not all(isinstance(options[key], str) and options[key].strip() for key in LETTERS):
            raise SystemExit(f"invalid five-choice options at dev row {row_index}")
        case_id = f"medqa-dev-{row_index:05d}"
        ordered_options = {letter: options[letter] for letter in LETTERS}
        projection = {"id": case_id, "question": question.strip(), "options": ordered_options}
        projections.append(projection)
        answer_key[case_id] = answer_letter(row)
        projection_bytes = json.dumps(
            {"question": projection["question"], "options": ordered_options},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        selected_metadata.append({
            "id": case_id,
            "rowIndex": row_index,
            "questionOptionsSha256": sha256_bytes(projection_bytes),
        })

    input_bytes = "".join(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n" for item in projections).encode("utf-8")
    answer_key_bytes = (json.dumps(answer_key, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    input_path.write_bytes(input_bytes)
    answer_key_path.write_bytes(answer_key_bytes)

    metadata_path = Path(args.metadata)
    if not metadata_path.is_absolute():
        metadata_path = repo_root / metadata_path
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata = {
        "task": "HC-MA-002",
        "split": "dev",
        "source": {
            "path": str(source),
            "rowCount": len(rows),
            "sha256": source_sha,
        },
        "selection": selected_metadata,
        "inferenceProjection": {
            "path": str(input_path),
            "fields": ["id", "question", "options"],
            "rowCount": len(projections),
            "sha256": sha256_bytes(input_bytes),
            "answerKeyIncluded": False,
        },
        "separateScoringKey": {
            "path": str(answer_key_path),
            "sha256": sha256_bytes(answer_key_bytes),
        },
        "testLabelsRead": False,
    }
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"split": "dev", "cases": len(projections), "projectionSha256": sha256_bytes(input_bytes)}))


if __name__ == "__main__":
    main()
