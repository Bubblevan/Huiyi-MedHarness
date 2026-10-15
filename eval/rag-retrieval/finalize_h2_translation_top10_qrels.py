#!/usr/bin/env python3
"""Validate and merge blind BM25-translation Top-10 labels with existing qrels."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
from typing import Any

from judge_pool import support_grade_is_valid


def load(path: Path) -> tuple[Any, bytes]:
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), raw


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def valid(label: dict[str, Any], snippet: str) -> list[str]:
    issues = []
    grade = label.get("relevance_grade")
    quote = label.get("evidence_quote")
    support = label.get("answer_support")
    if label.get("parse_status") != "ok":
        issues.append("invalid_parse_status")
    if isinstance(grade, bool) or grade not in (0, 1, 2):
        issues.append("invalid_grade")
    if support not in {"supported", "partial", "unsupported", "uncertain"}:
        issues.append("invalid_answer_support")
    if not isinstance(quote, str):
        issues.append("invalid_quote_type")
    elif grade == 0 and quote:
        issues.append("grade_zero_quote_nonempty")
    elif grade in (1, 2) and (not quote or quote not in snippet):
        issues.append("quote_not_verbatim")
    if isinstance(grade, int) and not isinstance(grade, bool) and support in {"supported", "partial", "unsupported", "uncertain"} and not support_grade_is_valid(grade, support):
        issues.append("grade_support_mismatch")
    explanation = label.get("explanation")
    if not isinstance(explanation, str) or not explanation.strip() or len(explanation.split()) > 12:
        issues.append("explanation_invalid_or_too_long")
    confidence = label.get("confidence")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        issues.append("invalid_confidence")
    return issues


def to_resolved_judgment(label: dict[str, Any], snippet: str) -> dict[str, Any]:
    quote = label["evidence_quote"]
    return {
        "relevanceGrade": label["relevance_grade"],
        "answer_support": label["answer_support"],
        "conflict_type": label["conflict_type"],
        "explanation": label["explanation"],
        "confidence": label["confidence"],
        "parse_status": label["parse_status"],
        "exactQuoteVerified": (label["relevance_grade"] == 0 and not quote) or (label["relevance_grade"] > 0 and quote in snippet),
        "evidenceQuoteSha256": hashlib.sha256(quote.encode("utf-8")).hexdigest() if quote else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--candidate-pool", type=Path, required=True)
    parser.add_argument("--judge-run", type=Path, required=True)
    parser.add_argument("--adjudication", type=Path, required=True)
    parser.add_argument("--packet", type=Path, required=True)
    parser.add_argument("--private-map", type=Path, required=True)
    parser.add_argument("--first-pass", type=Path, required=True)
    parser.add_argument("--second-pass", type=Path, required=True)
    parser.add_argument("--expanded-run", type=Path, required=True)
    parser.add_argument("--out-pool", type=Path, required=True)
    parser.add_argument("--out-judge-run", type=Path, required=True)
    parser.add_argument("--out-top10-run", type=Path, required=True)
    parser.add_argument("--out-adjudication", type=Path, required=True)
    args = parser.parse_args()

    dataset, dataset_raw = load(args.dataset)
    pool, pool_raw = load(args.candidate_pool)
    judge, judge_raw = load(args.judge_run)
    old_adj, old_adj_raw = load(args.adjudication)
    packet, packet_raw = load(args.packet)
    private_map, map_raw = load(args.private_map)
    first, first_raw = load(args.first_pass)
    second, second_raw = load(args.second_pass)
    expanded, expanded_raw = load(args.expanded_run)
    if sha(packet_raw) != private_map.get("annotationPacketSha256"):
        raise ValueError("private candidate map is not bound to the blinded packet")
    if sha(expanded_raw) != private_map.get("expandedRunSha256") or sha(dataset_raw) != private_map.get("datasetSha256"):
        raise ValueError("private candidate map is not bound to the exact dataset and expanded run")

    packet_questions = {q["questionId"]: q for q in packet.get("questions", [])}
    first_rows = {q["questionId"]: {x["candidateId"]: x for x in q.get("judgments", [])} for q in first.get("questions", [])}
    second_rows = {q["questionId"]: {x["candidateId"]: x for x in q.get("judgments", [])} for q in second.get("questions", [])}
    private_questions = private_map.get("questions", {})
    pool_questions = {q["questionId"]: q for q in pool.get("questions", [])}
    dataset_by_blind = {pool_questions[qid]["blindQuestionId"]: qid for qid in pool_questions}
    judge_by_ordinal = {row.get("questionOrdinal"): row for row in judge.get("judgments", [])}
    decisions = {(item.get("questionId"), item.get("candidateId")): item for item in old_adj.get("candidateDecisions", [])}

    extended_pool = copy.deepcopy(pool)
    extended_judge = copy.deepcopy(judge)
    extended_rows = {row.get("questionOrdinal"): row for row in extended_judge.get("judgments", [])}
    expanded_by_qid = {row["questionId"]: row for row in expanded.get("queries", [])}
    adjudication_items = []
    new_count = resolved_count = unresolved_count = control_count = control_first_agree = control_final_agree = 0

    for blind_qid, mapping_rows in private_questions.items():
        if blind_qid not in packet_questions or blind_qid not in first_rows:
            raise ValueError(f"missing packet/first-pass question {blind_qid}")
        expected_ids = {row["candidateId"] for row in mapping_rows}
        if set(first_rows[blind_qid]) != expected_ids:
            raise ValueError(f"first-pass candidate coverage mismatch for {blind_qid}")
        review_ids = set(second_rows.get(blind_qid, {}))
        should_review = set()
        snippets = {item["candidateId"]: item["snippet"] for item in packet_questions[blind_qid]["candidatePool"]}
        qid = dataset_by_blind[blind_qid]
        pool_row = next(q for q in extended_pool["questions"] if q["questionId"] == qid)
        qordinal = next(index for index, q in enumerate(dataset.get("questions", []), start=1) if q["questionId"] == qid)
        judge_row = extended_rows[qordinal]
        judge_labels = {item["candidateId"]: item for item in judge_row.get("judgments", [])}
        for entry in mapping_rows:
            cid = entry["candidateId"]
            first_label = first_rows[blind_qid][cid]
            snippet = snippets[cid]
            first_issues = valid(first_label, snippet)
            if isinstance(first_label.get("confidence"), (int, float)) and first_label["confidence"] < 0.65:
                first_issues.append("low_confidence")
            origin = entry["origin"]
            second_label = second_rows.get(blind_qid, {}).get(cid)

            if origin == "previously-judged-control":
                control_count += 1
                prior_grade = int(entry["priorGrade"])
                first_agrees = first_label.get("relevance_grade") == prior_grade and not first_issues
                control_first_agree += int(first_agrees)
                if first_agrees:
                    final_grade = prior_grade
                    final_agree = True
                    outcome = "first_pass_agreed_with_existing_adjudicated_control"
                else:
                    second_issues = valid(second_label or {}, snippet) if second_label else ["second_pass_missing"]
                    second_confident = isinstance((second_label or {}).get("confidence"), (int, float)) and second_label["confidence"] >= 0.65
                    final_grade = (second_label or {}).get("relevance_grade")
                    final_agree = not second_issues and second_confident and final_grade == prior_grade
                    outcome = "second_pass_agreed_with_existing_adjudicated_control" if final_agree else "control_unresolved"
                control_final_agree += int(final_agree)
                adjudication_items.append({"blindQuestionId": blind_qid, "candidateId": cid, "origin": origin, "priorGrade": prior_grade, "firstPassGrade": first_label.get("relevance_grade"), "secondPassGrade": (second_label or {}).get("relevance_grade"), "firstPassIssues": first_issues, "outcome": outcome, "controlAgreement": final_agree})
                continue

            new_count += 1
            chosen = first_label
            outcome = "resolved_on_first_pass"
            resolved = not first_issues
            second_issues = []
            if first_issues:
                if second_label is None:
                    resolved = False
                    second_issues = ["second_pass_missing"]
                else:
                    second_issues = valid(second_label, snippet)
                    second_confident = isinstance(second_label.get("confidence"), (int, float)) and second_label["confidence"] >= 0.65
                    agrees = (
                        not second_issues
                        and second_confident
                        and second_label.get("relevance_grade") == first_label.get("relevance_grade")
                        and second_label.get("answer_support") == first_label.get("answer_support")
                    )
                    if agrees:
                        resolved = True
                        chosen = second_label
                        outcome = "resolved_by_agreeing_second_pass"
                    else:
                        resolved = False
                        outcome = "review_required_disagreement_or_invalid_second_pass"
            if not resolved:
                should_review.add(cid)
                unresolved_count += 1
            else:
                resolved_count += 1
            doc_id = entry["documentId"]
            source = doc_id.split(":", 1)[0]
            pool_row["candidatePool"].append({
                "candidateId": cid,
                "documentId": doc_id,
                "source": source,
                "title": "",
                "candidateMethods": ["bm25-english-translation-top10"],
            })
            stored = to_resolved_judgment(chosen, snippet)
            judge_labels[cid] = {"candidateId": cid, **stored}
            adjudication_items.append({"blindQuestionId": blind_qid, "candidateId": cid, "documentId": doc_id, "origin": origin, "firstPassGrade": first_label.get("relevance_grade"), "secondPassGrade": (second_label or {}).get("relevance_grade"), "firstPassConfidence": first_label.get("confidence"), "secondPassConfidence": (second_label or {}).get("confidence"), "firstPassIssues": first_issues, "secondPassIssues": second_issues, "outcome": outcome, "includedInScoring": resolved})
        judge_row["judgments"] = list(judge_labels.values())
        prior_review = set(judge_row.get("reviewRequiredIds", []))
        judge_row["reviewRequiredIds"] = sorted(prior_review | should_review)

    extended_judge["candidateLabelCount"] = int(judge.get("candidateLabelCount", 0)) + new_count
    extended_judge["resolvedCandidateLabelCount"] = int(judge.get("resolvedCandidateLabelCount", 0)) + resolved_count
    extended_judge["reviewRequiredLabelCount"] = int(judge.get("reviewRequiredLabelCount", 0)) + unresolved_count
    extended_judge["status"] = "complete_with_review" if extended_judge["reviewRequiredLabelCount"] else "complete"
    extended_judge.setdefault("inputHashes", {}).update({
        str(args.packet): sha(packet_raw),
        str(args.private_map): sha(map_raw),
        str(args.first_pass): sha(first_raw),
        str(args.second_pass): sha(second_raw),
        str(args.expanded_run): sha(expanded_raw),
    })
    extended_judge["incrementalTop10"] = {
        "newCandidateCount": new_count,
        "newResolvedCount": resolved_count,
        "newUnresolvedCount": unresolved_count,
        "controlCandidateCount": control_count,
        "controlInitialGradeAgreement": "see separate adjudication summary",
        "controlFinalAgreementCount": control_final_agree,
        "controlFinalAgreementRate": round(control_final_agree / control_count, 6) if control_count else None,
    }

    top10_run = copy.deepcopy(expanded)
    top10_run["method"] = "bm25-english-translation-top10"
    top10_run["candidateBudget"] = 10
    top10_run["queries"] = [
        {**row, "results": row.get("results", [])[:10]}
        for row in expanded.get("queries", [])
    ]
    top10_run["derivedFrom"] = {"runSha256": sha(expanded_raw), "truncation": "retain ranks 1-10; no reranking"}

    review_summary = {
        "schemaVersion": "huiyi-h2-translation-top10-adjudication/v1",
        "status": "exploratory_model_judgment_not_human_review",
        "judgeModel": "gpt-6-luna",
        "humanReview": False,
        "newCandidateCount": new_count,
        "newResolvedCount": resolved_count,
        "newUnresolvedCount": unresolved_count,
        "totalCandidatePairsJudgedIncludingControls": new_count + control_count,
        "controls": {
            "count": control_count,
            "firstPassExactGradeAgreementCount": control_first_agree,
            "secondPassAgreementWithExistingAdjudicatedGradeCount": control_final_agree,
            "finalAgreementRate": round(control_final_agree / control_count, 6) if control_count else None,
        },
        "adjudicationPolicy": "Non-flagged valid labels retained. Flagged new labels included only when an independent second pass is valid, confidence >=0.65, and agrees on grade and support; otherwise kept unresolved and excluded. Controls were checked against prior adjudicated grades and not relabeled.",
        "candidateDecisions": adjudication_items,
        "inputHashes": {
            "dataset": sha(dataset_raw),
            "oldCandidatePool": sha(pool_raw),
            "oldJudgeRun": sha(judge_raw),
            "oldAdjudication": sha(old_adj_raw),
            "blindPacket": sha(packet_raw),
            "privateMap": sha(map_raw),
            "firstPass": sha(first_raw),
            "secondPass": sha(second_raw),
            "expandedRun": sha(expanded_raw),
        },
    }

    for path, value in ((args.out_pool, extended_pool), (args.out_judge_run, extended_judge), (args.out_top10_run, top10_run), (args.out_adjudication, review_summary)):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "newCandidates": new_count,
        "newResolved": resolved_count,
        "newUnresolved": unresolved_count,
        "controlCount": control_count,
        "controlFirstPassAgreement": f"{control_first_agree}/{control_count}",
        "controlFinalAgreement": f"{control_final_agree}/{control_count}",
        "augmentedPoolSize": sum(len(q.get("candidatePool", [])) for q in extended_pool.get("questions", [])),
        "extendedJudgeStatus": extended_judge["status"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
