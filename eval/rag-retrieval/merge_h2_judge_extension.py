#!/usr/bin/env python3
"""Merge blind incremental candidate judgments into an extended H2 qrels pool."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
from typing import Any


def _read(path: Path) -> tuple[Any, bytes, str]:
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), raw, hashlib.sha256(raw).hexdigest()


def _write(path: Path, value: Any) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(encoded)
    temporary.replace(path)
    return hashlib.sha256(encoded).hexdigest()


def _label_map(judge: dict[str, Any], packet: dict[str, Any]) -> dict[str, dict[str, dict[str, Any]]]:
    question_ids = [item["questionId"] for item in packet.get("questions", [])]
    grouped: dict[str, dict[str, dict[str, Any]]] = {}
    for batch in judge.get("judgments", []):
        if batch.get("status") != "ok":
            continue
        qid = batch.get("questionId")
        if not isinstance(qid, str) and isinstance(batch.get("questionOrdinal"), int):
            ordinal = batch["questionOrdinal"]
            if 1 <= ordinal <= len(question_ids):
                qid = question_ids[ordinal - 1]
        if not isinstance(qid, str):
            continue
        target = grouped.setdefault(qid, {})
        for item in batch.get("judgments", []):
            candidate_id = item.get("candidateId")
            if isinstance(candidate_id, str):
                if candidate_id in target and target[candidate_id] != item:
                    raise ValueError(f"conflicting labels for {qid}/{candidate_id}")
                target[candidate_id] = item
    return grouped


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extended-packet", required=True, type=Path)
    parser.add_argument("--base-judge", required=True, type=Path)
    parser.add_argument("--extension-judge", required=True, type=Path)
    parser.add_argument("--out-packet", required=True, type=Path)
    parser.add_argument("--out-judge", required=True, type=Path)
    parser.add_argument("--extension-label", choices=["E", "E2", "F"], default="E")
    args = parser.parse_args()

    packet, _packet_raw, packet_hash = _read(args.extended_packet)
    base, _base_raw, base_hash = _read(args.base_judge)
    extension, _extension_raw, extension_hash = _read(args.extension_judge)
    if base.get("status") not in {"complete", "complete_with_review", "partial"}:
        raise ValueError(f"base judge is not a usable completed/partial run: {base.get('status')}")
    if extension.get("status") not in {"complete", "complete_with_review", "partial"}:
        raise ValueError(f"extension judge is not a usable completed/partial run: {extension.get('status')}")
    if base.get("judgeMode", "").startswith("human") or extension.get("judgeMode", "").startswith("human"):
        raise ValueError("this merger is only for blind engineering-judge runs")

    pool_ids: dict[str, set[str]] = {}
    total_candidates = 0
    for question in packet.get("questions", []):
        qid = question["questionId"]
        candidates = question.get("candidatePool", [])
        ids = [item.get("candidateId") for item in candidates]
        if any(not isinstance(candidate_id, str) for candidate_id in ids) or len(set(ids)) != len(ids):
            raise ValueError(f"extended pool has malformed/duplicate candidate IDs for {qid}")
        pool_ids[qid] = set(ids)
        total_candidates += len(ids)

    base_labels = _label_map(base, packet)
    extension_labels = _label_map(extension, packet)
    combined_labels: dict[str, dict[str, dict[str, Any]]] = {}
    for qid, candidate_ids in pool_ids.items():
        labels = dict(base_labels.get(qid, {}))
        for candidate_id, item in extension_labels.get(qid, {}).items():
            if candidate_id in labels and labels[candidate_id] != item:
                raise ValueError(f"extension attempted to replace an existing label: {qid}/{candidate_id}")
            labels[candidate_id] = item
        unknown = set(labels) - candidate_ids
        if unknown:
            raise ValueError(f"judge run contains labels outside the extended pool for {qid}: {sorted(unknown)[:3]}")
        combined_labels[qid] = labels

    combined = copy.deepcopy(base)
    records = list(combined.get("judgments", []))
    for batch in extension.get("judgments", []):
        updated = dict(batch)
        updated["baseBatchId"] = updated.get("batchId")
        updated["batchId"] = args.extension_label + "-" + str(updated.get("batchId", "unknown"))
        records.append(updated)
    combined["judgments"] = records
    combined["runId"] = str(base.get("runId", "h2-base")) + f"+{args.extension_label.lower()}-qrel-extension"
    combined["judgeMode"] = f"blind_pooled_candidates_codex_cli_plus_{args.extension_label.lower()}"
    combined["annotationPacketSha256"] = packet_hash
    combined["candidateCount"] = total_candidates
    combined["judgedCount"] = sum(len(labels) for labels in combined_labels.values())
    review_by_qid: dict[str, set[str]] = {}
    for batch in records:
        qid = batch.get("questionId")
        if not isinstance(qid, str) and isinstance(batch.get("questionOrdinal"), int):
            ordinal = batch["questionOrdinal"]
            packet_questions = packet.get("questions", [])
            if 1 <= ordinal <= len(packet_questions):
                qid = packet_questions[ordinal - 1]["questionId"]
        if isinstance(qid, str):
            review_by_qid.setdefault(qid, set()).update(batch.get("reviewRequiredIds", []))
    review_ids = set().union(*review_by_qid.values()) if review_by_qid else set()
    combined["reviewRequiredCount"] = len(review_ids)
    combined["unresolvedCount"] = total_candidates - combined["judgedCount"]
    combined["resolvedCount"] = max(0, combined["judgedCount"] - len(review_ids))
    combined["coverage"] = round(combined["resolvedCount"] / total_candidates, 6) if total_candidates else 0.0
    combined["status"] = "complete" if combined["unresolvedCount"] == 0 and not review_ids else ("complete_with_review" if combined["unresolvedCount"] == 0 else "partial")
    known_tokens = [
        int(record["codexTokensUsed"])
        for record in records
        if isinstance(record.get("codexTokensUsed"), int)
    ]
    combined["codexTokensUsed"] = sum(known_tokens) if known_tokens else None
    combined["tokenUsageKnownBatchCount"] = len(known_tokens)
    combined["qrelExtensionProvenance"] = {
        "baseJudgeRunSha256": base_hash,
        "extensionJudgeRunSha256": extension_hash,
        "extendedAnnotationPacketSha256": packet_hash,
        "methodAndRankHiddenInBothPackets": True,
        "originalLabelsPreserved": True,
        "externalGoldAgreement": "not available; no human labels were used",
    }

    packet_hash_out = _write(args.out_packet, packet)
    combined["annotationPacketSha256"] = packet_hash_out
    judge_hash_out = _write(args.out_judge, combined)
    print(json.dumps({
        "status": combined["status"],
        "candidateCount": combined["candidateCount"],
        "judgedCount": combined["judgedCount"],
        "resolvedCount": combined["resolvedCount"],
        "reviewRequiredCount": combined["reviewRequiredCount"],
        "unresolvedCount": combined["unresolvedCount"],
        "coverage": combined["coverage"],
        "extendedPacketSha256": packet_hash_out,
        "combinedJudgeSha256": judge_hash_out,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
