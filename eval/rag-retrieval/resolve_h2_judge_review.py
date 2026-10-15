#!/usr/bin/env python3
"""Validate and adjudicate the H2 pilot's blinded second-pass labels.

The script keeps evidence excerpts out of the tracked result. It validates
case-sensitive exact quotes against the local candidate packet, then stores a
boolean and quote hash as compact audit evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from judge_pool import support_grade_is_valid


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def exact_quote(label: dict[str, Any], snippet: str) -> bool:
    quote = label.get("evidence_quote")
    grade = label.get("relevance_grade")
    if grade == 0:
        return quote == ""
    return isinstance(quote, str) and bool(quote) and quote in snippet


def valid_label(label: dict[str, Any], snippet: str) -> tuple[bool, list[str]]:
    errors: list[str] = []
    grade = label.get("relevance_grade")
    support = label.get("answer_support")
    allowed_support = {"supported", "partial", "unsupported", "uncertain"}
    allowed_conflicts = {"none", "topic", "population", "time", "source", "other"}
    if isinstance(grade, bool) or grade not in {0, 1, 2}:
        errors.append("invalid_grade")
    if support not in allowed_support:
        errors.append("invalid_answer_support")
    if label.get("conflict_type") not in allowed_conflicts:
        errors.append("invalid_conflict_type")
    if label.get("parse_status") != "ok":
        errors.append("parse_not_ok")
    confidence = label.get("confidence")
    if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        errors.append("invalid_confidence")
    elif confidence < 0.65:
        errors.append("low_confidence")
    if isinstance(grade, int) and not isinstance(grade, bool) and support in allowed_support and not support_grade_is_valid(grade, support):
        errors.append("grade_support_mismatch")
    if not exact_quote(label, snippet):
        errors.append("invalid_exact_quote")
    return not errors, errors


def usage_from_events(path: Path) -> dict[str, int]:
    usage: dict[str, int] = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if event.get("type") != "turn.completed":
            continue
        for key, value in event.get("usage", {}).items():
            if isinstance(value, int):
                usage[key] = usage.get(key, 0) + value
    return usage


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--batch-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--adjudication-out", type=Path, required=True)
    args = parser.parse_args()

    dataset = read_json(args.data_dir / "pilot-queries.pending.json")
    pool = read_json(args.data_dir / "annotation-packet.blinded.json")
    scoring_pool = read_json(args.data_dir / "candidate-pool.private.json")
    review_packet = read_json(args.batch_dir / "review-flagged.json")
    review_raw = read_json(args.batch_dir / "review-flagged.raw.json")

    dataset_questions = dataset["questions"]
    pool_questions = pool["questions"]
    if len(dataset_questions) != len(pool_questions):
        raise ValueError("dataset and candidate packet question counts differ")

    # Anonymous pool IDs are mapped to frozen dataset ordinals by exact query.
    dataset_ordinal_by_query = {question["query"]: i for i, question in enumerate(dataset_questions, 1)}
    if len(dataset_ordinal_by_query) != len(dataset_questions):
        raise ValueError("dataset contains duplicate query text; ordinal mapping is ambiguous")

    snippets: dict[tuple[str, str], str] = {}
    qid_to_ordinal: dict[str, int] = {}
    for question in pool_questions:
        qid = question["questionId"]
        query = question["query"]
        if query not in dataset_ordinal_by_query:
            raise ValueError(f"blinded query does not map to frozen dataset: {qid}")
        qid_to_ordinal[qid] = dataset_ordinal_by_query[query]
        for candidate in question.get("candidatePool", []):
            key = (qid, candidate["candidateId"])
            if key in snippets:
                raise ValueError(f"duplicate candidate in pool: {key}")
            snippets[key] = candidate["snippet"]

    private_candidates: set[tuple[str, str]] = set()
    for item in scoring_pool.get("questions", []):
        for candidate in item.get("candidatePool", []):
            blind_id = item.get("blindQuestionId")
            actual_id = item.get("questionId")
            if blind_id not in qid_to_ordinal or actual_id != dataset_questions[qid_to_ordinal[blind_id] - 1]["questionId"]:
                raise ValueError(f"private scoring pool question mapping mismatch: {blind_id} -> {actual_id}")
            private_candidates.add((blind_id, candidate["candidateId"]))
    if private_candidates != set(snippets):
        raise ValueError(
            f"private scoring pool candidate coverage mismatch: private={len(private_candidates)} "
            f"blind={len(snippets)}"
        )

    initial: dict[tuple[str, str], dict[str, Any]] = {}
    batch_paths = [args.batch_dir / f"batch-{i:02d}.raw.json" for i in range(1, 5)]
    for path in batch_paths:
        raw = read_json(path)
        for question in raw.get("questions", []):
            qid = question["questionId"]
            for label in question.get("judgments", []):
                key = (qid, label["candidateId"])
                if key in initial:
                    raise ValueError(f"duplicate initial label: {key}")
                if key not in snippets:
                    raise ValueError(f"initial label is absent from candidate pool: {key}")
                initial[key] = label

    expected_keys = set(snippets)
    if set(initial) != expected_keys:
        raise ValueError(
            f"initial coverage mismatch: expected={len(expected_keys)} labels={len(initial)} "
            f"missing={len(expected_keys - set(initial))} extra={len(set(initial) - expected_keys)}"
        )

    flagged: set[tuple[str, str]] = set()
    initial_validity: dict[tuple[str, str], tuple[bool, list[str]]] = {}
    for key, label in initial.items():
        validity = valid_label(label, snippets[key])
        initial_validity[key] = validity
        if not validity[0]:
            flagged.add(key)

    packet_keys = {
        (question["questionId"], candidate["candidateId"])
        for question in review_packet.get("questions", [])
        for candidate in question.get("candidatePool", [])
    }
    reviewed: dict[tuple[str, str], dict[str, Any]] = {}
    for question in review_raw.get("questions", []):
        qid = question["questionId"]
        for label in question.get("judgments", []):
            key = (qid, label["candidateId"])
            if key in reviewed:
                raise ValueError(f"duplicate second-pass label: {key}")
            reviewed[key] = label
    if packet_keys != flagged or set(reviewed) != flagged:
        not_in_packet = sorted(flagged - packet_keys)
        unexpected_in_packet = sorted(packet_keys - flagged)
        raise ValueError(
            f"second-pass coverage mismatch: expected={len(flagged)} packet={len(packet_keys)} "
            f"reviewed={len(reviewed)} notInPacket={not_in_packet} "
            f"unexpectedInPacket={unexpected_in_packet} "
            f"notInPacketReasons={[(key, initial_validity[key][1]) for key in not_in_packet]}"
        )

    final_by_question: dict[str, list[dict[str, Any]]] = {}
    review_required_by_question: dict[str, list[str]] = {}
    adjudication_rows: list[dict[str, Any]] = []
    for key in sorted(expected_keys, key=lambda item: (qid_to_ordinal[item[0]], item[1])):
        qid, candidate_id = key
        first = initial[key]
        chosen = first
        outcome = "first_pass_valid"
        reasons: list[str] = []
        second = reviewed.get(key)
        first_valid, first_errors = initial_validity[key]
        if key in flagged:
            second_valid, second_errors = valid_label(second, snippets[key])
            same_decision = (
                first.get("relevance_grade") == second.get("relevance_grade")
                and first.get("answer_support") == second.get("answer_support")
            )
            if second_valid and same_decision:
                chosen = second
                outcome = "resolved_by_agreeing_second_pass"
                reasons = first_errors
            else:
                outcome = "review_required"
                reasons = sorted(set(first_errors + second_errors + ([] if same_decision else ["pass_disagreement"])))
                review_required_by_question.setdefault(qid, []).append(candidate_id)

        final = {
            "candidateId": candidate_id,
            "relevanceGrade": chosen["relevance_grade"],
            "answer_support": chosen["answer_support"],
            "conflict_type": chosen["conflict_type"],
            "explanation": chosen["explanation"],
            "confidence": chosen["confidence"],
            "parse_status": chosen["parse_status"],
            "exactQuoteVerified": exact_quote(chosen, snippets[key]),
            "evidenceQuoteSha256": hashlib.sha256(chosen["evidence_quote"].encode("utf-8")).hexdigest()
            if chosen["evidence_quote"]
            else None,
        }
        final_by_question.setdefault(qid, []).append(final)
        row: dict[str, Any] = {
            "questionId": qid,
            "candidateId": candidate_id,
            "outcome": outcome,
            "firstPassGrade": first.get("relevance_grade"),
            "secondPassGrade": second.get("relevance_grade") if second else None,
            "firstPassConfidence": first.get("confidence"),
            "secondPassConfidence": second.get("confidence") if second else None,
            "firstPassExactQuote": exact_quote(first, snippets[key]),
            "secondPassExactQuote": exact_quote(second, snippets[key]) if second else None,
            "reasonCodes": reasons,
        }
        if key in flagged:
            adjudication_rows.append(row)

    judgments = []
    for question in pool_questions:
        qid = question["questionId"]
        judgments.append(
            {
                "questionOrdinal": qid_to_ordinal[qid],
                "status": "ok",
                "judgments": sorted(final_by_question[qid], key=lambda item: item["candidateId"]),
                "reviewRequiredIds": sorted(review_required_by_question.get(qid, [])),
            }
        )
    unresolved = sum(1 for row in adjudication_rows if row["outcome"] == "review_required")
    accepted_second_pass = sum(
        1 for row in adjudication_rows if row["outcome"] == "resolved_by_agreeing_second_pass"
    )

    event_paths = [args.batch_dir / f"batch-{i:02d}.events.jsonl" for i in range(1, 5)]
    event_paths.append(args.batch_dir / "review-flagged.events.jsonl")
    prompt_paths = [
        args.batch_dir / "prompt.md",
        args.batch_dir / "review-prompt.md",
        *(args.batch_dir / f"batch-{i:02d}.json" for i in range(1, 5)),
    ]
    token_usage: dict[str, int] = {}
    for path in event_paths:
        for name, count in usage_from_events(path).items():
            token_usage[name] = token_usage.get(name, 0) + count

    input_paths = [
        args.data_dir / "pilot-queries.pending.json",
        args.data_dir / "annotation-packet.blinded.json",
        args.data_dir / "candidate-pool.private.json",
        args.batch_dir / "review-flagged.json",
        args.batch_dir / "review-flagged.raw.json",
        *prompt_paths,
        *batch_paths,
        *event_paths,
    ]
    result = {
        "schemaVersion": "huiyi-rag-llm-judge-run/v1",
        "status": "complete_with_review" if unresolved else "complete",
        "datasetId": dataset.get("datasetId"),
        "split": dataset.get("split"),
        "corpusVersion": dataset.get("corpusVersion"),
        "judge": {
            "executionMode": "codex_cli_blinded_llm_judge_with_agreeing_second_pass",
            "exactModelIdAvailable": "gpt-6-luna",
            "externalGoldAgreement": None,
            "humanReview": False,
        },
        "questionCount": len(dataset_questions),
        "candidateLabelCount": len(initial),
        "resolvedCandidateLabelCount": len(initial) - unresolved,
        "reviewRequiredLabelCount": unresolved,
        "reviewRequiredLabelsIncluded": False,
        "pooledQrelsOnly": True,
        "fullCorpusRecallClaimed": False,
        "relevanceGradeMeaning": {"0": "irrelevant", "1": "partial/topical", "2": "direct support"},
        "relevanceThresholdForPrecisionRecallMrr": 2,
        "contextRelevanceThreshold": 1,
        "resolutionSummary": {
            "firstPassCandidateCount": len(initial),
            "secondPassCandidateCount": len(reviewed),
            "flaggedCandidateCount": len(flagged),
            "resolvedByAgreeingSecondPass": accepted_second_pass,
            "reviewRequired": unresolved,
        },
        "tokenUsage": token_usage,
        "resolutionScriptSha256": sha256(Path(__file__).resolve()),
        "judgments": judgments,
        "inputHashes": {str(path): sha256(path) for path in input_paths},
    }
    adjudication = {
        "schemaVersion": "huiyi-rag-judge-adjudication/v1",
        "judgeModel": "gpt-6-luna",
        "humanReview": False,
        "policy": "Use first pass when valid; flagged labels resolve only when an independent second pass is valid and agrees on grade and support. Otherwise exclude from scoring.",
        "resolutionScriptSha256": sha256(Path(__file__).resolve()),
        "summary": result["resolutionSummary"],
        "candidateDecisions": adjudication_rows,
        "inputHashes": {str(path): sha256(path) for path in input_paths},
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.adjudication_out.parent.mkdir(parents=True, exist_ok=True)
    args.adjudication_out.write_text(json.dumps(adjudication, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "status": result["status"],
                "questionCount": result["questionCount"],
                "candidateLabels": result["candidateLabelCount"],
                "flagged": len(flagged),
                "secondPassAgreed": accepted_second_pass,
                "reviewRequired": unresolved,
                "tokenUsage": token_usage,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
