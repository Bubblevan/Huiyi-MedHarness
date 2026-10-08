#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import random
from collections import defaultdict
from pathlib import Path
from statistics import mean
from typing import Any

from common import ARTIFACT_ROOT


PAIRS = (("A", "B", "A_to_B"), ("B", "C", "B_to_C"), ("A", "C", "A_to_C"))
METRICS = (("token_f1", "Token-F1"), ("bleu1", "BLEU-1"))


def percentile(sorted_values: list[float], percent: float) -> float:
    if not sorted_values:
        raise ValueError("cannot calculate a percentile from an empty sample")
    position = (len(sorted_values) - 1) * percent / 100.0
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return sorted_values[lower]
    weight = position - lower
    return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight


def bootstrap_summary(rows: list[dict[str, Any]], replicates: int = 10_000, seed: int = 3003) -> dict[str, Any]:
    if replicates < 1 or not rows:
        raise ValueError("bootstrap requires at least one row and one replicate")
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row["conversation_id"])].append(row)
    conversations = sorted(grouped)
    n = len(rows)
    result: dict[str, Any] = {
        "method": "paired percentile bootstrap; questions resampled with replacement; cluster bootstrap resamples conversations and retains all questions per sampled cluster",
        "replicates": replicates,
        "seed": seed,
        "confidence_level": 0.95,
        "question_count": n,
        "conversation_count": len(conversations),
        "comparisons": {},
    }

    for pair_index, (left, right, label) in enumerate(PAIRS):
        result["comparisons"][label] = {}
        for metric_index, (metric, display_name) in enumerate(METRICS):
            delta_key = f"{right}_{metric}"
            left_key = f"{left}_{metric}"
            deltas = [float(row[delta_key]) - float(row[left_key]) for row in rows]
            rng = random.Random(seed + pair_index * 100 + metric_index)
            question_boot = [
                mean(deltas[rng.randrange(n)] for _ in range(n))
                for _ in range(replicates)
            ]
            question_boot.sort()

            cluster_sums: dict[str, float] = {}
            cluster_counts: dict[str, int] = {}
            for conversation_id, conversation_rows in grouped.items():
                values = [float(row[delta_key]) - float(row[left_key]) for row in conversation_rows]
                cluster_sums[conversation_id] = sum(values)
                cluster_counts[conversation_id] = len(values)
            cluster_rng = random.Random(seed + 10_000 + pair_index * 100 + metric_index)
            cluster_boot: list[float] = []
            for _ in range(replicates):
                selected = [conversations[cluster_rng.randrange(len(conversations))] for _ in conversations]
                total = sum(cluster_sums[conversation_id] for conversation_id in selected)
                count = sum(cluster_counts[conversation_id] for conversation_id in selected)
                cluster_boot.append(total / count)
            cluster_boot.sort()

            result["comparisons"][label][display_name] = {
                "point_delta": mean(deltas),
                "question_level": {
                    "lower_95": percentile(question_boot, 2.5),
                    "upper_95": percentile(question_boot, 97.5),
                },
                "conversation_cluster": {
                    "lower_95": percentile(cluster_boot, 2.5),
                    "upper_95": percentile(cluster_boot, 97.5),
                },
            }
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Paired question and conversation-cluster bootstrap for full LoCoMo A/B/C parity.")
    parser.add_argument("--paired", type=Path, default=ARTIFACT_ROOT / "paired-diff.jsonl")
    parser.add_argument("--output", type=Path, default=ARTIFACT_ROOT / "bootstrap-summary.json")
    parser.add_argument("--replicates", type=int, default=10_000)
    parser.add_argument("--seed", type=int, default=3003)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.paired.read_text(encoding="utf-8").splitlines() if line.strip()]
    payload = bootstrap_summary(rows, args.replicates, args.seed)
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.output.chmod(0o600)
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
