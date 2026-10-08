"""Post-freeze MedQA validation scorer with paired A/B/C diagnostics."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
from pathlib import Path
from statistics import median
from typing import Any

CHOICES = "ABCD"
ID_PATTERN = re.compile(r"^validation-(\d{4})-([0-9a-f]{12})$")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"{path}:{line_number} must contain a JSON object")
            rows.append(row)
    return rows


def question_options_hash(question: str, options: dict[str, str]) -> str:
    canonical = json.dumps(
        {"question": question, "options": options},
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def normalize_gold(value: Any) -> str:
    if isinstance(value, str) and value.strip().upper() in CHOICES:
        return value.strip().upper()
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 4:
        return CHOICES[value]
    raise ValueError("validation answer_idx must be A-D or a zero-based option index")


def percentile(sorted_values: list[float], probability: float) -> float:
    if not sorted_values:
        raise ValueError("percentile requires at least one value")
    position = (len(sorted_values) - 1) * probability
    lower = int(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    fraction = position - lower
    return sorted_values[lower] * (1 - fraction) + sorted_values[upper] * fraction


def paired_bootstrap_ci(
    differences: list[int], *, seed: int = 42, replicates: int = 10_000
) -> dict[str, float]:
    if not differences:
        return {"lower95": 0.0, "upper95": 0.0}
    rng = random.Random(seed)
    count = len(differences)
    means = sorted(
        sum(differences[rng.randrange(count)] for _ in range(count)) / count
        for _ in range(replicates)
    )
    return {
        "lower95": round(percentile(means, 0.025), 4),
        "upper95": round(percentile(means, 0.975), 4),
    }


def wilson_interval(correct: int, count: int, z: float = 1.959963984540054) -> dict[str, float]:
    if count == 0:
        return {"lower95": 0.0, "upper95": 0.0}
    p = correct / count
    denominator = 1 + z * z / count
    center = (p + z * z / (2 * count)) / denominator
    margin = z * ((p * (1 - p) / count + z * z / (4 * count * count)) ** 0.5) / denominator
    return {"lower95": round(center - margin, 4), "upper95": round(center + margin, 4)}


def verify_frozen_outputs(
    freeze_manifest_path: Path,
    inference_jsonl: Path,
    config_json: Path,
) -> dict[str, Any]:
    manifest = json.loads(freeze_manifest_path.read_text(encoding="utf-8"))
    if manifest.get("testGoldRead") is not False or manifest.get("validationLabelsRead") is not False:
        raise ValueError("prediction freeze manifest does not establish pre-score label separation")
    if manifest.get("inferenceInputSha256") != sha256(inference_jsonl):
        raise ValueError("inference projection changed after prediction freeze")
    if manifest.get("configSha256") != sha256(config_json):
        raise ValueError("frozen evaluation config changed after prediction freeze")
    for name in ("A", "B", "C"):
        arm = manifest.get("arms", {}).get(name)
        if not isinstance(arm, dict):
            raise ValueError(f"freeze manifest is missing arm {name}")
        for path_key, hash_key in (
            ("predictionsPath", "predictionsSha256"),
            ("metadataTracePath", "metadataTraceSha256"),
        ):
            path = Path(arm[path_key])
            if not path.is_file() or sha256(path) != arm[hash_key]:
                raise ValueError(f"arm {name} {path_key} changed after prediction freeze")
    return manifest


def score_validation(
    *,
    validation_jsonl: Path,
    inference_jsonl: Path,
    config_json: Path,
    freeze_manifest_path: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    manifest = verify_frozen_outputs(freeze_manifest_path, inference_jsonl, config_json)

    # Gold is opened only after every prediction/config/metadata hash has been checked.
    config = json.loads(config_json.read_text(encoding="utf-8"))
    inference_rows = read_jsonl(inference_jsonl)
    configured_count = config.get("dataset", {}).get("frozenSubsetCount")
    expected_count = configured_count if isinstance(configured_count, int) else len(inference_rows)
    if len(inference_rows) != expected_count:
        raise ValueError("inference count differs from the frozen validation configuration")
    validation_rows = read_jsonl(validation_jsonl)
    if len(validation_rows) != 1272:
        raise ValueError("validation/source counts differ from the frozen contract")

    gold_by_id: dict[str, str] = {}
    for inference_row in inference_rows:
        match = ID_PATTERN.fullmatch(str(inference_row["id"]))
        if match is None:
            raise ValueError("frozen validation ID has an invalid form")
        source_index = int(match.group(1))
        if source_index >= len(validation_rows):
            raise ValueError("frozen validation ID points outside the source split")
        source = validation_rows[source_index]
        options = source.get("options")
        if isinstance(options, list) and len(options) == 4:
            options = dict(zip(CHOICES, options, strict=True))
        elif isinstance(options, dict):
            options = {key: options[key] for key in CHOICES if key in options}
        elif all(key in source for key in ("opa", "opb", "opc", "opd")):
            options = dict(zip(CHOICES, (source[key] for key in ("opa", "opb", "opc", "opd")), strict=True))
        else:
            raise ValueError("validation source row has no recognized four-option format")
        canonical_options = {key: options[key] for key in CHOICES}
        fingerprint = question_options_hash(source["question"], canonical_options)
        if fingerprint[:12] != match.group(2):
            raise ValueError("gold source question/options do not match the frozen inference ID")
        gold_by_id[str(inference_row["id"])] = normalize_gold(source["answer_idx"])

    predictions: dict[str, dict[str, Any]] = {}
    for name in ("A", "B", "C"):
        path = Path(manifest["arms"][name]["predictionsPath"])
        rows = read_jsonl(path)
        if [str(row.get("id", "")) for row in rows] != [str(row["id"]) for row in inference_rows]:
            raise ValueError(f"arm {name} row IDs/order changed after freeze")
        predictions[name] = {str(row["id"]): row for row in rows}

    case_rows: list[dict[str, Any]] = []
    for inference_row in inference_rows:
        case_id = str(inference_row["id"])
        gold = gold_by_id[case_id]
        record: dict[str, Any] = {"id": case_id, "gold": gold, "choices": {}, "correct": {}}
        for name in ("A", "B", "C"):
            row = predictions[name][case_id]
            choice = row.get("choice")
            choice = choice if isinstance(choice, str) and choice in CHOICES else None
            record["choices"][name] = choice
            record["correct"][name] = choice == gold
        case_rows.append(record)

    summaries: dict[str, Any] = {}
    for name in ("A", "B", "C"):
        rows = [predictions[name][case_id] for case_id in gold_by_id]
        correct = sum(row["correct"][name] for row in case_rows)
        latencies = [float(row["wallLatencyMs"]) for row in rows if isinstance(row.get("wallLatencyMs"), (int, float))]
        parse_failures = sum(row.get("parseStatus") != "json_choice" for row in rows)
        runtime_failures = sum(row.get("parseStatus") == "runtime_failure" or row.get("errorClass") is not None for row in rows)
        summaries[name] = {
            "count": len(rows),
            "correct": correct,
            "accuracy": round(correct / len(rows), 4),
            "accuracyWilson95": wilson_interval(correct, len(rows)),
            "parseFailures": parse_failures,
            "runtimeFailures": runtime_failures,
            "medianWallLatencyMs": round(median(latencies), 1) if latencies else None,
            "meanWallLatencyMs": round(sum(latencies) / len(latencies), 1) if latencies else None,
        }

    paired: dict[str, Any] = {}
    for left, right in (("A", "B"), ("B", "C"), ("A", "C")):
        disagreements = [row for row in case_rows if row["choices"][left] != row["choices"][right]]
        differences = [int(row["correct"][left]) - int(row["correct"][right]) for row in case_rows]
        paired[f"{left}-{right}"] = {
            "answerDisagreements": len(disagreements),
            "accuracyDifference": round(sum(differences) / len(differences), 4),
            "pairedBootstrap95": paired_bootstrap_ci(differences),
            "disagreementIds": [row["id"] for row in disagreements],
        }

    score = {
        "task": "HC-RAG-002",
        "split": manifest["split"],
        "sampleCount": len(inference_rows),
        "predictionFreezeManifestSha256": sha256(freeze_manifest_path),
        "testGoldRead": False,
        "validationGoldReadAfterPredictionFreeze": True,
        "arms": summaries,
    }
    paired_summary = {
        "task": "HC-RAG-002",
        "predictionFreezeManifestSha256": sha256(freeze_manifest_path),
        "comparisons": paired,
        "cases": case_rows,
    }
    return score, paired_summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--validation-jsonl", type=Path, required=True)
    parser.add_argument("--inference-jsonl", type=Path, required=True)
    parser.add_argument("--config-json", type=Path, required=True)
    parser.add_argument("--freeze-manifest", type=Path, required=True)
    parser.add_argument("--score-output", type=Path, required=True)
    parser.add_argument("--paired-output", type=Path, required=True)
    args = parser.parse_args()
    score, paired = score_validation(
        validation_jsonl=args.validation_jsonl,
        inference_jsonl=args.inference_jsonl,
        config_json=args.config_json,
        freeze_manifest_path=args.freeze_manifest,
    )
    args.score_output.parent.mkdir(parents=True, exist_ok=True)
    args.paired_output.parent.mkdir(parents=True, exist_ok=True)
    args.score_output.write_text(json.dumps(score, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.paired_output.write_text(json.dumps(paired, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"score": score, "pairedOutput": str(args.paired_output.resolve())}, indent=2))


if __name__ == "__main__":
    main()
