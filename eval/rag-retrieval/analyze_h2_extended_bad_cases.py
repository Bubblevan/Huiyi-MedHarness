#!/usr/bin/env python3
"""Extract paired, pooled-qrels regressions across final H2 A-F HOLDOUT runs."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


METHODS = ("A", "B", "C", "D", "E", "F")


def read(path: Path) -> tuple[Any, str]:
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), hashlib.sha256(raw).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--candidate-pool", required=True, type=Path)
    parser.add_argument("--judge-run", required=True, type=Path)
    parser.add_argument("--score", required=True, type=Path)
    parser.add_argument("--anchors", required=True, type=Path)
    parser.add_argument("--reference-key", required=True, type=Path)
    parser.add_argument("--run", action="append", required=True, help="METHOD=PATH for A-F")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    dataset, dataset_hash = read(args.dataset)
    pool, pool_hash = read(args.candidate_pool)
    judge, judge_hash = read(args.judge_run)
    score, score_hash = read(args.score)
    anchors_doc, anchors_hash = read(args.anchors)
    reference_key, reference_hash = read(args.reference_key)
    if dataset.get("split") != "holdout" or dataset_hash != pool.get("extensionSourceHashes", {}).get("datasetSha256"):
        raise ValueError("bad-case inputs are not bound to the frozen HOLDOUT")
    if pool.get("datasetId") != dataset.get("datasetId") or score.get("datasetId") != dataset.get("datasetId"):
        raise ValueError("dataset IDs differ")
    run_paths: dict[str, Path] = {}
    for spec in args.run:
        method, separator, value = spec.partition("=")
        if not separator or method not in METHODS or method in run_paths:
            parser.error("--run must provide unique A-F=PATH entries")
        run_paths[method] = Path(value)
    if set(run_paths) != set(METHODS):
        parser.error("all A-F runs are required")
    runs: dict[str, dict[str, Any]] = {}
    run_hashes: dict[str, str] = {}
    for method, path in run_paths.items():
        run, digest = read(path)
        if run.get("datasetId") != dataset.get("datasetId") or run.get("datasetSha256") != dataset_hash:
            raise ValueError(f"{method} run does not match final HOLDOUT bytes")
        runs[method] = {row["questionId"]: row for row in run.get("queries", [])}
        run_hashes[method] = digest

    pool_by_qid = {q["questionId"]: q for q in pool.get("questions", [])}
    anchors_by_qid = {q["questionId"]: q for q in anchors_doc.get("questions", [])}
    reference_by_qid = reference_key.get("questions", {})
    labels_by_qid: dict[str, dict[str, dict[str, Any]]] = {}
    for question in pool.get("questions", []):
        qid = question["questionId"]
        labels_by_qid[qid] = {}
    for batch in judge.get("judgments", []):
        qid = batch.get("questionId")
        if batch.get("status") != "ok" or qid not in labels_by_qid:
            continue
        for label in batch.get("judgments", []):
            labels_by_qid[qid][label["candidateId"]] = label
    score_rows = {
        method: {row["questionId"]: row for row in score["perMethodPerQuestion"][method]}
        for method in METHODS
    }
    dataset_by_id = {q["questionId"]: q for q in dataset["questions"]}
    packet_by_qid = pool_by_qid
    candidates: list[tuple[float, str, str, str]] = []

    def add_group(focus: str, comparator: str, count: int, group: str, *, categories: set[str] | None = None, answerable_only: bool = False, min_delta: float = 0.0) -> None:
        possible = []
        for qid, question in dataset_by_id.items():
            if qid not in packet_by_qid or qid not in score_rows[focus] or qid not in score_rows[comparator]:
                continue
            if score_rows[focus][qid].get("metricEligibility@10") != "eligible" or score_rows[comparator][qid].get("metricEligibility@10") != "eligible":
                continue
            if categories is not None and question.get("taskCategory") not in categories:
                continue
            if answerable_only and question.get("answerability") != "answerable":
                continue
            left = score_rows[focus][qid].get("ndcg@10")
            right = score_rows[comparator][qid].get("ndcg@10")
            if not isinstance(left, (int, float)) or not isinstance(right, (int, float)):
                continue
            delta = left - right
            if delta < min_delta:
                possible.append((delta, qid, focus, group))
        possible.sort()
        selected = 0
        for row in possible:
            if row[1] in {item[1] for item in candidates}:
                continue
            candidates.append(row)
            selected += 1
            if selected >= count:
                break

    add_group("B", "A", 4, "BM25 below Dense; lexical-match regression", categories={"bilingual"})
    add_group("C", "A", 4, "RRF below Dense; fusion-order regression", categories={"semantic", "exact_term", "multi_hop", "applicability_boundary"}, min_delta=-0.05)
    add_group("D", "C", 3, "Reranker below RRF; reranking regression", answerable_only=True, min_delta=-0.01)
    add_group("E", "D", 4, "Iterative retrieval below reranker; retrieval/planner regression", answerable_only=True, min_delta=-0.01)
    add_group("F", "D", 3, "Adaptive sufficiency retrieval below reranker nDCG on answerable task", answerable_only=True, min_delta=-0.01)
    if len(candidates) < 15:
        raise ValueError(f"only {len(candidates)} distinct eligible regressions; cannot claim 15")

    cases = []
    for index, (delta, qid, focus, group) in enumerate(candidates, 1):
        question = dataset_by_id[qid]
        pooled = pool_by_qid[qid]
        candidate_by_id = {c["candidateId"]: c for c in pooled.get("candidatePool", [])}
        labels = labels_by_qid.get(qid, {})
        grade_by_doc = {
            candidate_by_id[cid]["documentId"]: label["relevanceGrade"]
            for cid, label in labels.items()
            if cid in candidate_by_id and isinstance(label.get("relevanceGrade"), int)
        }
        methods = {}
        for method in METHODS:
            run_row = runs[method].get(qid, {})
            docs = []
            for rank, result in enumerate(run_row.get("results", [])[:5] if run_row.get("status") == "ok" else [], 1):
                document_id = result.get("documentId")
                candidate = next((c for c in pooled.get("candidatePool", []) if c.get("documentId") == document_id), {})
                docs.append({"rank": rank, "documentId": document_id, "source": result.get("source", candidate.get("source")), "title": result.get("title", candidate.get("title")), "relevanceGrade": grade_by_doc.get(document_id)})
            methods[method] = {"ndcgAt10": score_rows[method][qid].get("ndcg@10"), "top5": docs}
        relevant_evidence = []
        for candidate in pooled.get("candidatePool", []):
            label = labels.get(candidate["candidateId"])
            if label and label.get("relevanceGrade") == 2:
                relevant_evidence.append({"documentId": candidate["documentId"], "source": candidate.get("source"), "title": candidate.get("title"), "evidenceQuote": label.get("evidenceQuote"), "judgeExplanation": label.get("explanation")})
        anchor_by_id = {item["anchorId"]: item for item in anchors_by_qid.get(qid, {}).get("anchors", [])}
        source_anchor_evidence = []
        for required in reference_by_qid.get(qid, {}).get("evidence", []):
            anchor = anchor_by_id.get(required.get("anchorId"), {})
            source_anchor_evidence.append({
                "anchorId": required.get("anchorId"),
                "source": anchor.get("source"),
                "title": anchor.get("title"),
                "passageSha256": anchor.get("passageSha256"),
                "requiredEvidenceElement": required.get("requiredEvidenceElement"),
                "exactQuote": required.get("exactQuote"),
            })
        comparator = {"B": "A", "C": "A", "D": "C", "E": "D", "F": "D"}[focus]
        cases.append({
            "caseId": f"H2-H-EXT-BC-{index:02d}",
            "questionId": qid,
            "query": question["query"],
            "taskCategory": question.get("taskCategory"),
            "answerability": question.get("answerability"),
            "observedFailure": group,
            "focusMethod": focus,
            "comparatorMethod": comparator,
            "ndcgAt10Difference": round(delta, 6),
            "fullyResolvedPooledQrels": True,
            "methods": methods,
            "sourceAnchorEvidence": source_anchor_evidence,
            "directSupportEvidence": relevant_evidence,
            "pooledDirectSupportDocumentCount": len(relevant_evidence),
            "failureStage": {"B": "sparse retrieval", "C": "rank fusion", "D": "cross-encoder reranking", "E": "iterative query planning/merge", "F": "adaptive stop/search/retrieval"}[focus],
            "rootCauseStatus": "observed paired ranking loss; causal mechanism not isolated",
            "rootCauseHypothesis": group + "; inspect the shown query, grade-2 evidence, and Top-5 ranks. No fix is claimed without an intervention.",
            "fixStatus": "not tested in this frozen HOLDOUT comparison",
            "clinicalReview": False,
        })

    out = {
        "schemaVersion": "huiyi-h2-extended-quality-bad-cases/v1",
        "status": "engineering-review-no-clinician-validation",
        "datasetId": dataset.get("datasetId"),
        "datasetSha256": dataset_hash,
        "candidatePoolSha256": pool_hash,
        "judgeRunSha256": judge_hash,
        "scoreSha256": score_hash,
        "sourceAnchorManifestSha256": anchors_hash,
        "privateReferenceKeySha256": reference_hash,
        "runSha256": run_hashes,
        "candidatePoolCount": judge.get("candidateCount"),
        "resolvedCandidateCount": judge.get("resolvedCount"),
        "unresolvedCandidateCount": judge.get("unresolvedCount"),
        "candidateCoverage": judge.get("coverage"),
        "caseCount": len(cases),
        "observedQualityRegressionCount": len(cases),
        "cases": cases,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"caseCount": len(cases), "observedQualityRegressionCount": len(cases), "out": str(args.out)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
