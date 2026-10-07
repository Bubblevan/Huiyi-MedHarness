#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import nltk
from nltk.translate.bleu_score import SmoothingFunction, sentence_bleu

from common import ARTIFACT_ROOT, CONTRACT_MANIFEST, DEFAULT_DATASET, included_questions, load_dataset, sha256_file

_NLTK_READY = False


def verify_scorer_hash() -> str:
    manifest = json.loads(CONTRACT_MANIFEST.read_text(encoding="utf-8"))
    expected = manifest["scorer"].get("localImplementationSha256")
    actual = sha256_file(Path(__file__))
    if expected != actual:
        raise ValueError(f"local scorer SHA256 differs from the frozen contract: {actual}")
    return actual


def ensure_nltk_resources() -> None:
    global _NLTK_READY
    if _NLTK_READY:
        return
    resources = (
        ("tokenizers/punkt", "punkt"),
        ("tokenizers/punkt_tab/english", "punkt_tab"),
        ("corpora/wordnet", "wordnet"),
    )
    for resource, package in resources:
        try:
            nltk.data.find(resource)
        except LookupError:
            if not nltk.download(package, quiet=True):
                raise RuntimeError(f"NLTK resource is unavailable: {package}")
    _NLTK_READY = True


def simple_tokenize(text: Any) -> list[str]:
    return str(text).lower().replace(".", " ").replace(",", " ").replace("!", " ").replace("?", " ").split()


def token_f1(prediction: Any, reference: Any) -> float:
    if not prediction or not reference:
        return 0.0
    pred_tokens = set(simple_tokenize(str(prediction).strip()))
    ref_tokens = set(simple_tokenize(str(reference).strip()))
    common = pred_tokens & ref_tokens
    if not pred_tokens or not ref_tokens:
        return 0.0
    precision = len(common) / len(pred_tokens)
    recall = len(common) / len(ref_tokens)
    return 2 * precision * recall / (precision + recall) if precision + recall else 0.0


def bleu1(prediction: Any, reference: Any) -> float:
    if not prediction or not reference:
        return 0.0
    ensure_nltk_resources()
    pred_tokens = nltk.word_tokenize(str(prediction).strip().lower())
    ref_tokens = [nltk.word_tokenize(str(reference).strip().lower())]
    return float(sentence_bleu(ref_tokens, pred_tokens, weights=(1, 0, 0, 0), smoothing_function=SmoothingFunction().method1))


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSON at {path}:{line_number}") from exc
    return rows


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[str(row["category"])].append(row)
    result = {}
    all_scores: list[dict[str, float]] = []
    for category in ("1", "3", "2", "4"):
        category_rows = groups.get(category, [])
        scores = [{
            "token_f1": token_f1(row.get("response", ""), row.get("gold_answer", "")),
            "bleu1": bleu1(row.get("response", ""), row.get("gold_answer", "")),
        } for row in category_rows]
        all_scores.extend(scores)
        result[category] = {
            "count": len(category_rows),
            "token_f1": mean(item["token_f1"] for item in scores),
            "bleu1": mean(item["bleu1"] for item in scores),
            "parse_error_count": sum(1 for row in category_rows if row.get("parse_error")),
        }
    result["overall"] = {
        "count": len(rows),
        "token_f1": mean(item["token_f1"] for item in all_scores),
        "bleu1": mean(item["bleu1"] for item in all_scores),
        "parse_error_count": sum(1 for row in rows if row.get("parse_error")),
    }
    return result


def mean(values) -> float | None:
    data = list(values)
    return sum(data) / len(data) if data else None


def validate_ids(rows: list[dict[str, Any]], expected: list[dict[str, Any]], allow_partial: bool) -> None:
    actual_ids = [row.get("question_id") for row in rows]
    if len(actual_ids) != len(set(actual_ids)):
        raise ValueError("prediction JSONL contains duplicate question ids")
    expected_ids = [item["question_id"] for item in expected]
    expected_by_id = {item["question_id"]: item for item in expected}
    if allow_partial:
        if any(question_id not in set(expected_ids) for question_id in actual_ids):
            raise ValueError("prediction JSONL contains question ids outside the frozen included set")
    elif actual_ids != expected_ids:
        raise ValueError(f"prediction ids differ from frozen expected ids: {len(actual_ids)}/{len(expected_ids)}")
    for row in rows:
        item = expected_by_id[row["question_id"]]
        if int(row["category"]) != item["category"] or row.get("gold_answer") != item["gold_answer"]:
            raise ValueError(f"prediction category/gold answer differs from the frozen dataset at {item['question_id']}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Score one LoCoMo arm with the pinned AMA Token-F1 and BLEU-1 definitions.")
    parser.add_argument("predictions", type=Path)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--allow-partial", action="store_true")
    args = parser.parse_args()

    scorer_sha256 = verify_scorer_hash()
    expected = included_questions(load_dataset(args.dataset))
    rows = load_jsonl(args.predictions)
    validate_ids(rows, expected, args.allow_partial)
    metrics = aggregate(rows)
    payload = {
        "arm": rows[0].get("arm") if rows else None,
        "question_count": len(rows),
        "included_count": len(expected),
        "excluded_category_5_count": sum(1 for row in load_dataset(args.dataset) for qa in row.get("qa", []) if int(qa.get("category", 0)) == 5),
        "category_order": ["single-hop:1", "multi-hop:3", "temporal:2", "open-domain:4"],
        "scorer": {
            "source": "pinned AMA Core/eval.py token_f1 + nltk BLEU-1 (method1 smoothing)",
            "localImplementationSha256": scorer_sha256,
            "nltkVersion": nltk.__version__,
        },
        "llm_judge": {"status": "not_run", "reason": "no full frozen local reproduction judge protocol was recoverable; paper GPT-4o-mini score is external-only"},
        "metrics": metrics,
    }
    output = args.output or args.predictions.with_name("metrics.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
