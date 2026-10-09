#!/usr/bin/env python3
"""Freeze the authorized 68-case HC-MA-002 Dev subset and a metadata-stratified pilot."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


ROOT = Path("/root/gpufree-data")
QUESTIONS = ROOT / "repro/hc-ma-002/medqa-dev-e2e-all-harness-20261009/questions.jsonl"
PREDICTIONS = ROOT / "repro/hc-ma-002/medqa-dev-e2e-final-harness-promptfix-v2-20261009/predictions.jsonl"
QUOTAS = {"basic": 8, "intermediate": 13, "advanced": 3}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def case_text(row: dict) -> str:
    return row["question"] + "\n\nOptions\n" + "\n".join(
        f"{key}. {value}" for key, value in row["options"].items()
    )


def write_jsonl(path: Path, rows: list[dict]) -> str:
    payload = "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    path.chmod(0o600)
    return sha256(payload)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()

    all_questions = {row["id"]: row for row in read_jsonl(QUESTIONS)}
    predictions = read_jsonl(PREDICTIONS)
    ids = [row["id"] for row in predictions]
    expected = [f"medqa-dev-{index:05d}" for index in range(68)]
    if ids != expected or len(set(ids)) != 68:
        raise SystemExit("the existing prompt-fix prediction file is not the authorized ordered 68-case set")

    cases = []
    for prediction in predictions:
        question = all_questions.get(prediction["id"])
        if question is None or set(question) != {"id", "question", "options"}:
            raise SystemExit(f"missing or non-gold-free input row for {prediction['id']}")
        if set(question["options"]) != {"A", "B", "C", "D", "E"}:
            raise SystemExit(f"unexpected option set for {prediction['id']}")
        if sha256(case_text(question).encode()) != prediction.get("caseHash"):
            raise SystemExit(f"case hash mismatch for {prediction['id']}")
        cases.append(question)

    by_id = {row["id"]: row for row in predictions}
    selected: set[str] = set()
    for complexity, quota in QUOTAS.items():
        members = [case for case in cases if by_id[case["id"]].get("complexity") == complexity]
        members.sort(key=lambda row: (len(case_text(row)), row["id"]))
        if len(members) < quota:
            raise SystemExit(f"not enough cases for the {complexity} pilot quota")
        if quota == len(members):
            selected.update(row["id"] for row in members)
        else:
            for slot in range(quota):
                index = min(len(members) - 1, int((slot + 0.5) * len(members) / quota))
                selected.add(members[index]["id"])

    full_hash = write_jsonl(args.output_dir / "questions-68.jsonl", cases)
    pilot = [case for case in cases if case["id"] in selected]
    pilot_hash = write_jsonl(args.output_dir / "questions-pilot-24.jsonl", pilot)
    pilot_ids = [case["id"] for case in pilot]
    id_hash = sha256(("\n".join(ids) + "\n").encode())
    manifest = {
        "task": "HC-PERF-001",
        "sourceQuestionFileSha256": sha256(QUESTIONS.read_bytes()),
        "sourcePredictionFileSha256": sha256(PREDICTIONS.read_bytes()),
        "caseCount": 68,
        "caseIds": ids,
        "caseIdSha256": id_hash,
        "caseHashValidation": "68/68 matched the existing prediction metadata",
        "selectedInput": {"file": "questions-68.jsonl", "sha256": full_hash, "fields": ["id", "question", "options"]},
        "pilot": {
            "file": "questions-pilot-24.jsonl",
            "sha256": pilot_hash,
            "count": len(pilot),
            "quotasByHistoricalComplexity": QUOTAS,
            "caseIds": pilot_ids,
        },
        "labelsRead": False,
    }
    manifest_path = args.output_dir / "calibration-manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    manifest_path.chmod(0o600)
    print(json.dumps({"count": 68, "idSha256": id_hash, "pilotCount": len(pilot), "pilotIds": pilot_ids}))


if __name__ == "__main__":
    main()
