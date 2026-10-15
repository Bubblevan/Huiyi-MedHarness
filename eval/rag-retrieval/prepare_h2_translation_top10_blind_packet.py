#!/usr/bin/env python3
"""Build a blinded incremental qrel packet for English-BM25 Top-10 candidates."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sqlite3
from pathlib import Path
from typing import Any


def read(path: Path) -> tuple[Any, bytes]:
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), raw


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--candidate-pool", type=Path, required=True)
    parser.add_argument("--annotation-packet", type=Path, required=True)
    parser.add_argument("--judge-run", type=Path, required=True)
    parser.add_argument("--adjudication", type=Path, required=True)
    parser.add_argument("--expanded-run", type=Path, required=True)
    parser.add_argument("--sparse-index", type=Path, required=True)
    parser.add_argument("--corpus-root", type=Path, required=True)
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--out-packet", type=Path, required=True)
    parser.add_argument("--out-private-map", type=Path, required=True)
    args = parser.parse_args()
    if args.top_k < 1:
        parser.error("--top-k must be positive")

    dataset, dataset_raw = read(args.dataset)
    pool, _ = read(args.candidate_pool)
    old_packet, _ = read(args.annotation_packet)
    judge, _ = read(args.judge_run)
    adjudication, _ = read(args.adjudication)
    run, run_raw = read(args.expanded_run)
    if dataset.get("datasetId") != run.get("datasetId") or dataset.get("corpusVersion") != run.get("corpusVersion"):
        raise ValueError("expanded run does not match the frozen dataset/corpus")

    pool_by_id = {row["questionId"]: row for row in pool.get("questions", [])}
    old_packet_by_blind = {row["questionId"]: row for row in old_packet.get("questions", [])}
    judge_by_ordinal = {row.get("questionOrdinal"): row for row in judge.get("judgments", [])}
    decision_map = {
        (item.get("questionId"), item.get("candidateId")): item
        for item in adjudication.get("candidateDecisions", [])
    }
    run_by_id = {row["questionId"]: row for row in run.get("queries", [])}
    db = sqlite3.connect(f"file:{args.sparse_index.resolve().as_posix()}?mode=ro", uri=True)
    doc_meta: dict[str, tuple[str, int, int, str]] = {}
    candidate_pairs: dict[str, list[dict[str, Any]]] = {}
    private_map: dict[str, list[dict[str, str]]] = {}
    packet_questions = []
    total_new = 0
    total_controls = 0
    for ordinal, question in enumerate(dataset.get("questions", []), start=1):
        qid = question["questionId"]
        pool_row = pool_by_id[qid]
        blind_qid = pool_row["blindQuestionId"]
        existing_doc_ids = {item["documentId"] for item in pool_row.get("candidatePool", [])}
        expanded_row = run_by_id.get(qid)
        if not expanded_row or expanded_row.get("status") != "ok":
            raise ValueError(f"expanded run missing successful row for {qid}")
        top_results = expanded_row.get("results", [])[: args.top_k]
        new_doc_ids = []
        for item in top_results:
            doc_id = item.get("documentId")
            if isinstance(doc_id, str) and doc_id not in existing_doc_ids and doc_id not in new_doc_ids:
                new_doc_ids.append(doc_id)

        judge_batch = judge_by_ordinal.get(ordinal)
        if not judge_batch or judge_batch.get("status") != "ok":
            raise ValueError(f"existing judge labels unavailable for control selection in {qid}")
        unresolved_ids = set(judge_batch.get("reviewRequiredIds", []))
        labels = {item["candidateId"]: item for item in judge_batch.get("judgments", [])}
        old_candidates = {item["candidateId"]: item for item in pool_row.get("candidatePool", [])}
        old_snippets = {item["candidateId"]: item.get("snippet", "") for item in old_packet_by_blind[blind_qid].get("candidatePool", [])}
        old_grade_by_doc: dict[str, tuple[int, str]] = {}
        for cid, label in labels.items():
            old = old_candidates.get(cid)
            if not old:
                continue
            decision = decision_map.get((blind_qid, cid))
            if cid in unresolved_ids:
                if decision and decision.get("outcome") == "resolved_by_agreeing_second_pass":
                    grade = decision.get("secondPassGrade")
                else:
                    continue
            elif decision and decision.get("outcome") == "review_required":
                continue
            else:
                grade = label.get("relevanceGrade")
            if isinstance(grade, int):
                old_grade_by_doc[old["documentId"]] = (grade, cid)

        new_candidates: list[dict[str, Any]] = []
        for doc_id in new_doc_ids:
            if doc_id not in doc_meta:
                row = db.execute(
                    "SELECT path,byte_offset,byte_length,title FROM sparse_meta WHERE document_id=?",
                    (doc_id,),
                ).fetchone()
                if not row:
                    raise ValueError(f"document missing from sparse metadata: {doc_id}")
                doc_meta[doc_id] = (row[0], int(row[1]), int(row[2]), row[3])
            relpath, offset, length, title = doc_meta[doc_id]
            raw_chunk = (args.corpus_root / Path(relpath)).open("rb")
            try:
                raw_chunk.seek(offset)
                chunk = json.loads(raw_chunk.read(length).decode("utf-8"))
            finally:
                raw_chunk.close()
            snippet = chunk.get("content", "")[:2500]
            if not isinstance(snippet, str) or not snippet:
                raise ValueError(f"empty chunk snippet: {doc_id}")
            new_candidates.append({"documentId": doc_id, "title": title, "snippet": snippet, "origin": "new-expanded-top10"})

        excluded_new = set(new_doc_ids)
        controls: list[dict[str, Any]] = []
        for target_grade in (2, 0):
            options = [
                (doc_id, cid, grade)
                for doc_id, (grade, cid) in old_grade_by_doc.items()
                if grade == target_grade and doc_id not in excluded_new and doc_id not in {item["documentId"] for item in controls}
            ]
            if not options:
                options = [
                    (doc_id, cid, grade)
                    for doc_id, (grade, cid) in old_grade_by_doc.items()
                    if doc_id not in excluded_new and doc_id not in {item["documentId"] for item in controls}
                ]
            if options:
                chosen_doc, chosen_cid, chosen_grade = sorted(options, key=lambda item: digest(f"control|{blind_qid}|{item[0]}"))[0]
                source_candidate = old_packet_by_blind[blind_qid]["candidatePool"]
                source_candidate = next(item for item in source_candidate if item["candidateId"] == chosen_cid)
                controls.append({
                    "documentId": chosen_doc,
                    "title": source_candidate.get("title", ""),
                    "snippet": source_candidate.get("snippet", ""),
                    "origin": "previously-judged-control",
                    "priorGrade": chosen_grade,
                })

        combined = new_candidates + controls
        if not combined:
            raise ValueError(f"no candidate items for blind question {blind_qid}")
        for item in combined:
            cid = "C-" + digest(f"h2-translation-top10-blind-v1|{hashlib.sha256(dataset_raw).hexdigest()}|{blind_qid}|{item['documentId']}")[:12]
            item["candidateId"] = cid
        combined.sort(key=lambda item: digest(f"shuffle|{blind_qid}|{item['candidateId']}"))
        candidate_pairs[blind_qid] = combined
        total_new += len(new_candidates)
        total_controls += len(controls)
        packet_questions.append({
            "questionId": blind_qid,
            "query": question["query"],
            "candidatePool": [{"candidateId": item["candidateId"], "snippet": item["snippet"]} for item in combined],
        })
        private_map[blind_qid] = [
            {"candidateId": item["candidateId"], "documentId": item["documentId"], "origin": item["origin"], **({"priorGrade": str(item["priorGrade"])} if "priorGrade" in item else {})}
            for item in combined
        ]
    db.close()

    packet = {"schemaVersion": "huiyi-h2-blinded-incremental-qrels/v1", "questions": packet_questions}
    packet_raw = (json.dumps(packet, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    args.out_packet.parent.mkdir(parents=True, exist_ok=True)
    args.out_packet.write_bytes(packet_raw)
    private_output = {
        "schemaVersion": "huiyi-h2-private-incremental-qrel-map/v1",
        "datasetSha256": hashlib.sha256(dataset_raw).hexdigest(),
        "expandedRunSha256": hashlib.sha256(run_raw).hexdigest(),
        "annotationPacketSha256": hashlib.sha256(packet_raw).hexdigest(),
        "topK": args.top_k,
        "newCandidatePairs": total_new,
        "controlCandidatePairs": total_controls,
        "questions": private_map,
    }
    args.out_private_map.parent.mkdir(parents=True, exist_ok=True)
    args.out_private_map.write_text(json.dumps(private_output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "questionCount": len(packet_questions),
        "newCandidatePairs": total_new,
        "previouslyJudgedBlindControls": total_controls,
        "totalCandidatePairs": total_new + total_controls,
        "packetSha256": hashlib.sha256(packet_raw).hexdigest(),
        "packet": str(args.out_packet),
        "privateMap": str(args.out_private_map),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
