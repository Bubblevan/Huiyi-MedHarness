#!/usr/bin/env python3
"""Create a blind qrels packet for candidates returned outside an existing H2 pool."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any


def _read(path: Path) -> tuple[Any, bytes, str]:
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), raw, hashlib.sha256(raw).hexdigest()


def _write(path: Path, value: Any) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_bytes(encoded)
    temp.replace(path)
    return hashlib.sha256(encoded).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--original-packet", required=True, type=Path)
    parser.add_argument("--e-run", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--corpus-root", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--method-label", choices=["E", "E2", "F"], default="E")
    parser.add_argument("--base-pool-label", default="A-D")
    args = parser.parse_args()

    dataset, _dataset_raw, dataset_hash = _read(args.dataset)
    original_packet, _original_raw, original_hash = _read(args.original_packet)
    e_run, _e_raw, e_hash = _read(args.e_run)
    manifest, manifest_raw, manifest_hash = _read(args.manifest)
    if e_run.get("datasetSha256") != dataset_hash or e_run.get("datasetId") != dataset.get("datasetId"):
        raise ValueError("E run does not match the frozen dataset bytes and ID")
    if e_run.get("manifestSha256") != manifest_hash or e_run.get("corpusVersion") != manifest.get("corpusVersion"):
        raise ValueError("E run does not match the frozen corpus manifest")
    if original_packet.get("datasetId") != dataset.get("datasetId"):
        raise ValueError("original qrels packet datasetId differs")
    if original_packet.get("manifestSha256") != manifest_hash:
        raise ValueError("original qrels packet manifest SHA differs")

    questions_by_id = {question["questionId"]: question for question in original_packet["questions"]}
    original_ids: dict[str, set[str]] = {}
    extended_questions: list[dict[str, Any]] = []
    extension_questions: list[dict[str, Any]] = []
    for question_id, question in questions_by_id.items():
        original_ids[question_id] = {
            candidate["documentId"] for candidate in question.get("candidatePool", [])
        }
        base = {key: value for key, value in question.items() if key not in {"candidatePool", "qrels", "annotations"}}
        extended_questions.append({**base, "candidatePool": list(question.get("candidatePool", [])), "qrels": [], "annotations": [], "reviewStatus": question.get("reviewStatus", "pending")})
        extension_questions.append({**base, "candidatePool": [], "qrels": [], "annotations": [], "reviewStatus": "pending_extension_labels"})

    source_files: dict[str, dict[str, Any]] = {}
    for source in manifest.get("sources", []):
        source_name = source.get("name")
        for entry in source.get("chunkFiles", []):
            relative = Path(entry["path"])
            source_document_id = relative.stem
            key = f"{source_name}:{source_document_id}"
            if key in source_files:
                raise ValueError(f"duplicate source-document chunk file: {key}")
            source_files[key] = {"path": relative, "sha256": entry.get("sha256")}

    run_rows = {row["questionId"]: row for row in e_run.get("queries", [])}
    if set(run_rows) != set(questions_by_id):
        raise ValueError("E run question IDs do not exactly match the frozen qrels cohort")
    loaded_chunk_lines: dict[str, list[str]] = {}
    new_candidate_count = 0
    per_question: dict[str, int] = {}
    for qid, question in questions_by_id.items():
        run_row = run_rows[qid]
        packet_extension = extension_questions[list(questions_by_id).index(qid)]
        packet_extended = extended_questions[list(questions_by_id).index(qid)]
        seen_new: set[str] = set()
        for result in run_row.get("results", [])[: args.top_k]:
            document_id = result.get("documentId")
            if not isinstance(document_id, str) or document_id in original_ids[qid] or document_id in seen_new:
                continue
            source, source_document_id, chunk_text = document_id.split(":", 2)
            if result.get("source") != source or not chunk_text.isdigit():
                raise ValueError(f"invalid stable document ID in E run: {document_id}")
            file_key = f"{source}:{source_document_id}"
            file_entry = source_files.get(file_key)
            if file_entry is None:
                raise ValueError(f"E result cannot be mapped to a frozen chunk file: {document_id}")
            path = (args.corpus_root / file_entry["path"]).resolve()
            if not path.is_file():
                raise FileNotFoundError(path)
            if str(path) not in loaded_chunk_lines:
                chunk_file_raw = path.read_bytes()
                if hashlib.sha256(chunk_file_raw).hexdigest() != file_entry["sha256"]:
                    raise ValueError(f"frozen chunk-file SHA-256 differs from the manifest: {path}")
                loaded_chunk_lines[str(path)] = chunk_file_raw.decode("utf-8").splitlines()
            lines = loaded_chunk_lines[str(path)]
            chunk_index = int(chunk_text)
            if not 0 <= chunk_index < len(lines):
                raise ValueError(f"E result chunk line does not exist: {document_id}")
            chunk = json.loads(lines[chunk_index])
            if not isinstance(chunk.get("title"), str) or not isinstance(chunk.get("content"), str):
                raise ValueError(f"frozen chunk is missing title/content: {document_id}")

            candidate_seed = hashlib.sha256(
                f"h2-pilot-blind-v1|{dataset_hash}|{qid}|{document_id}".encode("utf-8")
            ).hexdigest()
            candidate = {
                "blindOrderKey": hashlib.sha256(
                    f"h2-e-extension-order-v1|{dataset_hash}|{qid}|{document_id}".encode("utf-8")
                ).hexdigest(),
                "candidateId": "C-" + candidate_seed[:12],
                "documentId": document_id,
                "source": source,
                "title": chunk["title"],
                "snippet": chunk["content"][:2500],
                "snippetTruncated": len(chunk["content"]) > 2500,
                "sourceUri": chunk.get("sourceUri") or chunk.get("source_uri"),
            }
            packet_extension["candidatePool"].append(candidate)
            packet_extended["candidatePool"].append({key: value for key, value in candidate.items() if key != "blindOrderKey"})
            seen_new.add(document_id)
        packet_extension["candidatePool"].sort(key=lambda item: item["blindOrderKey"])
        for candidate in packet_extension["candidatePool"]:
            candidate.pop("blindOrderKey", None)
        packet_extended["candidatePool"][len(original_ids[qid]):] = sorted(
            packet_extended["candidatePool"][len(original_ids[qid]):],
            key=lambda item: hashlib.sha256(
                f"h2-e-extension-order-v1|{dataset_hash}|{qid}|{item['documentId']}".encode("utf-8")
            ).hexdigest(),
        )
        per_question[qid] = len(seen_new)
        new_candidate_count += len(seen_new)

    extension_packet = {
        "schemaVersion": original_packet.get("schemaVersion", "huiyi-rag-annotation-packet/v1"),
        "datasetId": dataset.get("datasetId"),
        "corpusVersion": manifest.get("corpusVersion"),
        "manifestSha256": manifest_hash,
        "instruction": "Blind incremental labels for previously unpooled retrieval candidates. Method, rank, score, and run identity are not included.",
        "reviewStatus": "pending_blind_incremental_labels",
        "extensionMode": f"new-{args.method_label}-candidate-only; originals retain their frozen qrels",
        "sourceHashes": {
            "datasetSha256": dataset_hash,
            "originalAnnotationPacketSha256": original_hash,
            f"{args.method_label.lower()}RunSha256": e_hash,
            "manifestSha256": manifest_hash,
            "manifestFileSha256": hashlib.sha256(manifest_raw).hexdigest(),
        },
        "candidateCount": new_candidate_count,
        "questions": extension_questions,
    }
    extended_packet = {
        **original_packet,
        "questions": extended_questions,
        "extensionMode": f"original {args.base_pool_label} pool plus {args.method_label}-only candidates; original candidate IDs/order preserved",
        "extensionSourceHashes": extension_packet["sourceHashes"],
        "extensionCandidateCount": new_candidate_count,
    }
    args.out_dir.mkdir(parents=True, exist_ok=True)
    if args.method_label == "E" and args.base_pool_label == "A-D":
        extension_filename = "annotation-packet-e-extension.blinded.json"
        extended_filename = "annotation-packet-abcd-plus-e.blinded.json"
        counts_filename = "e-extension-candidate-counts.json"
    else:
        base_slug = re.sub(r"[^a-z0-9]+", "-", args.base_pool_label.lower()).strip("-")
        extension_filename = f"annotation-packet-{args.method_label.lower()}-extension.blinded.json"
        extended_filename = f"annotation-packet-{base_slug}-plus-{args.method_label.lower()}.blinded.json"
        counts_filename = f"{args.method_label.lower()}-extension-candidate-counts.json"
    extension_path = args.out_dir / extension_filename
    extended_path = args.out_dir / extended_filename
    extension_sha = _write(extension_path, extension_packet)
    extended_sha = _write(extended_path, extended_packet)
    _write(args.out_dir / counts_filename, {
        "datasetId": dataset.get("datasetId"),
        "split": dataset.get("split"),
        "originalCandidateCount": sum(len(q.get("candidatePool", [])) for q in original_packet["questions"]),
        "extensionCandidateCount": new_candidate_count,
        "extendedCandidateCount": sum(len(q.get("candidatePool", [])) for q in extended_questions),
        "questionsWithNewCandidates": sum(count > 0 for count in per_question.values()),
        "perQuestionNewCandidateCounts": per_question,
        "extensionPacketSha256": extension_sha,
        "extendedPacketSha256": extended_sha,
        "datasetSha256": dataset_hash,
        "eRunSha256": e_hash,
        "manifestSha256": manifest_hash,
    })
    print(json.dumps({
        "status": "extension_packets_ready_for_blind_qrels",
        "split": dataset.get("split"),
        "questions": len(questions_by_id),
        "newCandidates": new_candidate_count,
        "questionsWithNewCandidates": sum(count > 0 for count in per_question.values()),
        "extensionPacket": str(extension_path),
        "extendedPoolPacket": str(extended_path),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
