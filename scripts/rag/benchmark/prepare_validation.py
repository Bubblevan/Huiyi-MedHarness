#!/usr/bin/env python3
"""Create the frozen 100-case validation inference projection (no gold fields)."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def question_options_hash(question: str, options: dict[str, str]) -> str:
    canonical = json.dumps(
        {"question": question, "options": options},
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def extract_question_options(row: dict[str, Any]) -> tuple[str, dict[str, str]]:
    question = row.get("question")
    raw_options = row.get("options")
    if isinstance(raw_options, list) and len(raw_options) == 4:
        options = dict(zip("ABCD", raw_options, strict=True))
    elif isinstance(raw_options, dict):
        options = {key: raw_options[key] for key in "ABCD" if key in raw_options}
    elif all(key in row for key in ("opa", "opb", "opc", "opd")):
        options = dict(zip("ABCD", (row[key] for key in ("opa", "opb", "opc", "opd")), strict=True))
    else:
        raise ValueError("validation row does not expose four options")
    if not isinstance(question, str) or not question.strip() or set(options) != set("ABCD"):
        raise ValueError("validation row has invalid question/options")
    if any(not isinstance(value, str) or not value.strip() for value in options.values()):
        raise ValueError("validation row has an empty/non-text option")
    return question, {key: options[key] for key in "ABCD"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--validation-jsonl", type=Path, required=True)
    parser.add_argument("--selection-manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    source_rows = [json.loads(line) for line in args.validation_jsonl.read_text(encoding="utf-8").splitlines() if line.strip()]
    selection = json.loads(args.selection_manifest.read_text(encoding="utf-8"))["selection"]["items"]
    if len(source_rows) != 1272 or len(selection) != 100:
        raise ValueError("validation source/selection counts differ from the frozen contract")

    projected: list[dict[str, Any]] = []
    for item in selection:
        index = item["sourceIndex"]
        row = source_rows[index]
        question, options = extract_question_options(row)
        fingerprint = question_options_hash(question, options)
        if fingerprint != item["questionOptionsSha256"]:
            raise ValueError(f"frozen question/options fingerprint differs at validation row {index}")
        projected.append({
            "id": f"validation-{index:04d}-{fingerprint[:12]}",
            "question": question,
            "options": options,
        })

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as stream:
        for row in projected:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(json.dumps({
        "sourceSha256": hashlib.sha256(args.validation_jsonl.read_bytes()).hexdigest(),
        "sourceCount": len(source_rows),
        "selectedCount": len(projected),
        "inferenceProjectionSha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
        "output": str(args.output),
        "goldFieldsProjected": False,
    }, indent=2))


if __name__ == "__main__":
    main()
