#!/usr/bin/env python3
"""Summarize H2 answer-support engineering judgments with explicit denominators."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def load(path: Path) -> tuple[dict[str, Any], str]:
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), hashlib.sha256(raw).hexdigest()


def ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 6) if denominator else None


def summarize(items: list[dict[str, Any]], private_map: dict[str, dict[str, Any]], packet_tasks: dict[str, dict[str, Any]]) -> dict[str, Any]:
    generated = Counter()
    abstentions = Counter()
    relevancy = Counter()
    claim_support = Counter()
    citation_refs = Counter()
    source_uri_refs = Counter()
    category_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    task_rows = []

    for item in items:
        key = item["itemKey"]
        identity = private_map[key]
        task = packet_tasks[key]
        method = identity["method"]
        category = identity["taskCategory"]
        generated[(method, item["generationStatus"])] += 1
        if item["generationStatus"] == "ok":
            abstentions[(method, bool(item.get("abstained")))] += 1
        if item.get("answerRelevancy"):
            relevancy[(method, item["answerRelevancy"])] += 1

        for claim in item.get("claims", []):
            support = claim.get("support") or "unresolved"
            claim_support[(method, support)] += 1
            cited = claim.get("citedEvidenceIds", [])
            valid = set(claim.get("validCitedEvidenceIds", []))
            evidence_by_id = {entry["evidenceId"]: entry for entry in task.get("evidenceSet", [])}
            for evidence_id in cited:
                citation_refs[(method, "total")] += 1
                if evidence_id in valid and evidence_id in evidence_by_id:
                    citation_refs[(method, "valid")] += 1
                    if evidence_by_id[evidence_id].get("sourceUri"):
                        source_uri_refs[(method, "withSourceUri")] += 1

        row = {
            "itemKey": key,
            "questionId": identity["questionId"],
            "method": method,
            "taskCategory": category,
            "answerability": identity["answerability"],
            "generationStatus": item["generationStatus"],
            "abstained": item.get("abstained"),
            "answerRelevancy": item.get("answerRelevancy"),
            "claimCount": len(item.get("claims", [])),
            "supportCounts": dict(Counter(claim.get("support") or "unresolved" for claim in item.get("claims", []))),
            "assessableClaimCount": sum((claim.get("support") in {"supported", "partial", "unsupported"}) for claim in item.get("claims", [])),
            "fullySupportedClaimRate": ratio(sum(claim.get("support") == "supported" for claim in item.get("claims", [])), sum((claim.get("support") in {"supported", "partial", "unsupported"}) for claim in item.get("claims", []))),
            "supportedOrPartialClaimRate": ratio(sum(claim.get("support") in {"supported", "partial"} for claim in item.get("claims", [])), sum((claim.get("support") in {"supported", "partial", "unsupported"}) for claim in item.get("claims", []))),
            "hasUnsupportedClaim": any(claim.get("support") == "unsupported" for claim in item.get("claims", [])),
            "citationReferenceCount": sum(len(claim.get("citedEvidenceIds", [])) for claim in item.get("claims", [])),
            "validCitationReferenceCount": sum(len(claim.get("validCitedEvidenceIds", [])) for claim in item.get("claims", [])),
            "judgeStatus": item["judgeStatus"],
        }
        task_rows.append(row)
        category_rows[f"{method}|{category}"].append(row)

    methods = sorted({identity["method"] for identity in private_map.values()})
    by_method: dict[str, Any] = {}
    for method in methods:
        task_n = sum(row["method"] == method for row in task_rows)
        generation_ok = generated[(method, "ok")]
        judged = sum(count for (m, _), count in relevancy.items() if m == method)
        rel_relevant = relevancy[(method, "relevant")]
        abstain_n = abstentions[(method, True)]
        support_counts = {name: count for (m, name), count in claim_support.items() if m == method}
        assessed = sum(support_counts.get(name, 0) for name in ("supported", "partial", "unsupported"))
        cited_total = citation_refs[(method, "total")]
        valid_cited = citation_refs[(method, "valid")]
        by_method[method] = {
            "taskCount": task_n,
            "generationSuccessCount": generation_ok,
            "generationSuccessRate": ratio(generation_ok, task_n),
            "answerRelevancyJudgedCount": judged,
            "answerRelevancyCounts": {name: count for (m, name), count in relevancy.items() if m == method},
            "relevantAnswerRateAmongJudged": ratio(rel_relevant, judged),
            "abstentionCount": abstain_n,
            "abstentionRateAmongGenerated": ratio(abstain_n, generation_ok),
            "claimSupportCounts": support_counts,
            "assessableClaimCount": assessed,
            "fullySupportedClaimRateAmongAssessable": ratio(support_counts.get("supported", 0), assessed),
            "supportedOrPartialClaimRateAmongAssessable": ratio(support_counts.get("supported", 0) + support_counts.get("partial", 0), assessed),
            "unsupportedClaimRateAmongAssessable": ratio(support_counts.get("unsupported", 0), assessed),
            "citationReferenceCount": cited_total,
            "validCitationReferenceCount": valid_cited,
            "citationIdValidityRate": ratio(valid_cited, cited_total),
            "validCitationReferencesWithSourceUri": source_uri_refs[(method, "withSourceUri")],
            "sourceUriMetadataCoverageAmongValidCitations": ratio(source_uri_refs[(method, "withSourceUri")], valid_cited),
            "citationMeaning": "valid same-answer Evidence IDs point to supplied local chunks; sourceUri metadata presence is counted, but external URL/DOI resolution is not tested",
        }

    by_method_category: dict[str, Any] = {}
    for key, rows in sorted(category_rows.items()):
        method, category = key.split("|", 1)
        judged = [row for row in rows if row["answerRelevancy"]]
        rel_count = sum(row["answerRelevancy"] == "relevant" for row in judged)
        by_method_category[key] = {
            "taskCount": len(rows),
            "generationSuccessCount": sum(row["generationStatus"] == "ok" for row in rows),
            "answerRelevancyJudgedCount": len(judged),
            "relevantAnswerCount": rel_count,
            "relevantAnswerRateAmongJudged": ratio(rel_count, len(judged)),
            "abstainedCount": sum(bool(row["abstained"]) for row in rows if row["generationStatus"] == "ok"),
            "answerabilityCounts": dict(Counter(row["answerability"] for row in rows)),
        }

    return {
        "methods": by_method,
        "methodsByCategory": by_method_category,
        "perTask": task_rows,
        "claimCompleteness": "not measured: structured claim lists are evaluated; answer prose is not exhaustively atomized",
        "judgmentScope": "GPT-6-Luna engineering assessment against supplied snippets; not clinical review, external gold, or human adjudication",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packet", required=True, type=Path)
    parser.add_argument("--private-map", required=True, type=Path)
    parser.add_argument("--generation-run", required=True, type=Path)
    parser.add_argument("--judge-run", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    packet, packet_hash = load(args.packet)
    private, _private_hash = load(args.private_map)
    generation, generation_hash = load(args.generation_run)
    judge, judge_hash = load(args.judge_run)
    if generation.get("packetSha256") != packet_hash or judge.get("packetSha256") != packet_hash:
        raise ValueError("packet SHA does not match generation/judge records")
    if judge.get("generationRunSha256") != generation_hash:
        raise ValueError("judge run is not bound to the supplied generation run")
    if private.get("packetSha256") != packet_hash:
        raise ValueError("private task map is not bound to the supplied packet")

    private_map = private.get("items", {})
    packet_tasks = {row["itemKey"]: row for row in packet.get("generatorTasks", [])}
    generation_rows = {row["itemKey"]: row for row in generation.get("tasks", [])}
    judge_rows = {row["itemKey"]: row for row in judge.get("tasks", [])}
    expected = set(packet_tasks)
    if not (expected == set(private_map) == set(generation_rows) == set(judge_rows)):
        raise ValueError("packet, private map, generation, and judge task keys differ")
    result = summarize(list(judge_rows.values()), private_map, packet_tasks)
    result["schemaVersion"] = "huiyi-h2-answer-support-score/v1"
    result["status"] = "complete" if generation.get("status") == "complete" and judge.get("status") == "complete" else "partial"
    result["datasetId"] = packet.get("datasetId")
    result["datasetSha256"] = packet.get("datasetSha256")
    result["packetSha256"] = packet_hash
    result["generationRunSha256"] = generation_hash
    result["judgeRunSha256"] = judge_hash
    result["questionSelection"] = packet.get("selection")
    result["generatorModel"] = generation.get("judgeModel")
    result["judgeModel"] = judge.get("judgeModel")
    result["generatorTokens"] = generation.get("totalCodexTokensUsed")
    result["judgeTokens"] = judge.get("totalCodexTokensUsed")
    result["externalGoldAgreement"] = judge.get("externalGoldAgreement")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "methods": result["methods"], "out": str(args.out)}, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
