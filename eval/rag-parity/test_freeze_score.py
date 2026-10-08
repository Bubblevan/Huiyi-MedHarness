from __future__ import annotations

import json
from pathlib import Path

import pytest

from freeze_predictions import freeze
from score_validation import question_options_hash, score_validation, verify_frozen_outputs


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def test_freeze_then_score_validation_only_after_hash_verification(tmp_path: Path) -> None:
    validation_rows = []
    inference_rows = []
    for index in range(1272):
        options = {key: f"option {key} for question {index}" for key in "ABCD"}
        question = f"validation question {index}"
        validation_rows.append({
            "question": question,
            "options": options,
            "answer_idx": index % 4,
        })
        if index < 100:
            fingerprint = question_options_hash(question, options)[:12]
            inference_rows.append({
                "id": f"validation-{index:04d}-{fingerprint}",
                "question": question,
                "options": options,
            })

    validation_path = tmp_path / "validation.jsonl"
    inference_path = tmp_path / "inference.jsonl"
    config_path = tmp_path / "frozen-config.json"
    write_jsonl(validation_path, validation_rows)
    write_jsonl(inference_path, inference_rows)

    import hashlib

    projection_hash = hashlib.sha256(inference_path.read_bytes()).hexdigest()
    config_path.write_text(json.dumps({
        "status": "frozen-for-100-case-validation",
        "labelsOpened": False,
        "dataset": {"inferenceProjectionSha256": projection_hash},
    }), encoding="utf-8")

    arm_dirs: dict[str, Path] = {}
    for arm in "ABC":
        arm_dir = tmp_path / arm
        arm_dirs[arm] = arm_dir
        predictions = []
        trace = []
        for index, case in enumerate(inference_rows):
            gold = "ABCD"[index % 4]
            choice = gold
            if arm == "B" and index == 0:
                choice = "D" if gold != "D" else "C"
            if arm == "C" and index == 1:
                choice = "D" if gold != "D" else "C"
            predictions.append({
                "id": case["id"],
                "choice": choice,
                "parseStatus": "json_choice",
                "wallLatencyMs": 1000 + index,
            })
            trace.append({"id": case["id"], "turnOutcome": "completed"})
        write_jsonl(arm_dir / "predictions.jsonl", predictions)
        write_jsonl(arm_dir / "metadata-trace.jsonl", trace)

    freeze_path = tmp_path / "freeze.json"
    freeze(
        inference_jsonl=inference_path,
        config_json=config_path,
        arms=[f"{arm}={arm_dirs[arm]}" for arm in "ABC"],
        output=freeze_path,
    )

    score, paired = score_validation(
        validation_jsonl=validation_path,
        inference_jsonl=inference_path,
        config_json=config_path,
        freeze_manifest_path=freeze_path,
    )

    assert score["arms"]["A"]["accuracy"] == 1.0
    assert score["arms"]["B"]["correct"] == 99
    assert paired["comparisons"]["A-B"]["answerDisagreements"] == 1
    assert paired["comparisons"]["B-C"]["answerDisagreements"] == 2

    with (arm_dirs["A"] / "predictions.jsonl").open("a", encoding="utf-8") as stream:
        stream.write("{}\n")
    with pytest.raises(ValueError, match="changed after prediction freeze"):
        verify_frozen_outputs(freeze_path, inference_path, config_path)
