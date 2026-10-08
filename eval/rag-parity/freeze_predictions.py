"""Freeze validation predictions and metadata before the scorer reads labels."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


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
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number} must contain a JSON object")
            rows.append(value)
    return rows


def freeze(
    *,
    inference_jsonl: Path,
    config_json: Path,
    arms: list[str],
    output: Path,
) -> dict[str, Any]:
    inference_rows = read_jsonl(inference_jsonl)
    expected_ids = [str(row["id"]) for row in inference_rows]
    if not expected_ids or len(set(expected_ids)) != len(expected_ids):
        raise ValueError("the frozen validation projection must contain unique IDs")

    config = json.loads(config_json.read_text(encoding="utf-8"))
    status = config.get("status")
    if status not in {
        "frozen-for-100-case-validation",
        "active-45-case-validation-scope-frozen",
    } or config.get("labelsOpened") is not False:
        raise ValueError("validation config is not frozen with labels still closed")
    configured_count = config.get("dataset", {}).get("frozenSubsetCount")
    if configured_count is not None and configured_count != len(expected_ids):
        raise ValueError("inference projection count differs from the frozen configuration")
    if config.get("dataset", {}).get("inferenceProjectionSha256") != sha256(inference_jsonl):
        raise ValueError("inference projection hash differs from the frozen configuration")

    frozen_arms: dict[str, Any] = {}
    for argument in arms:
        if "=" not in argument:
            raise ValueError("--arm must use NAME=OUTPUT_DIRECTORY")
        name, raw_directory = argument.split("=", 1)
        if name not in {"A", "B", "C"} or name in frozen_arms:
            raise ValueError(f"invalid or duplicate arm name: {name}")
        directory = Path(raw_directory).expanduser().resolve()
        predictions_path = directory / "predictions.jsonl"
        if not predictions_path.is_file():
            raise ValueError(f"missing predictions for arm {name}")
        prediction_rows = read_jsonl(predictions_path)
        actual_ids = [str(row.get("id", "")) for row in prediction_rows]
        if actual_ids != expected_ids:
            raise ValueError(f"arm {name} predictions do not match frozen IDs/order/count")

        trace_candidates = [directory / "metadata-trace.jsonl", directory / "dsh-metadata.jsonl"]
        trace_path = next((path for path in trace_candidates if path.is_file()), None)
        if trace_path is None:
            raise ValueError(f"missing metadata trace for arm {name}")
        trace_rows = read_jsonl(trace_path)
        if [str(row.get("id", "")) for row in trace_rows] != expected_ids:
            raise ValueError(f"arm {name} metadata trace does not match frozen IDs/order/count")

        frozen_arms[name] = {
            "outputDirectory": str(directory),
            "predictionsPath": str(predictions_path),
            "predictionsSha256": sha256(predictions_path),
            "metadataTracePath": str(trace_path),
            "metadataTraceSha256": sha256(trace_path),
            "count": len(prediction_rows),
        }

    if set(frozen_arms) != {"A", "B", "C"}:
        raise ValueError("freeze requires all three arms A, B, and C")

    result = {
        "task": "HC-RAG-002",
        "split": f"MedQA validation frozen {len(expected_ids)}-case subset",
        "sampleCount": len(expected_ids),
        "configStatus": status,
        "frozenAt": datetime.now(timezone.utc).isoformat(),
        "testGoldRead": False,
        "validationLabelsRead": False,
        "inferenceInputPath": str(inference_jsonl.resolve()),
        "inferenceInputSha256": sha256(inference_jsonl),
        "configPath": str(config_json.resolve()),
        "configSha256": sha256(config_json),
        "arms": frozen_arms,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inference-jsonl", type=Path, required=True)
    parser.add_argument("--config-json", type=Path, required=True)
    parser.add_argument("--arm", action="append", default=[], help="NAME=OUTPUT_DIRECTORY; repeat for A/B/C")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = freeze(
        inference_jsonl=args.inference_jsonl,
        config_json=args.config_json,
        arms=args.arm,
        output=args.output,
    )
    print(json.dumps({
        "freezeManifest": str(args.output.resolve()),
        "inferenceInputSha256": manifest["inferenceInputSha256"],
        "arms": {name: item["predictionsSha256"] for name, item in manifest["arms"].items()},
        "testGoldRead": False,
    }, indent=2))


if __name__ == "__main__":
    main()
