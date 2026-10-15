#!/usr/bin/env python3
"""Freeze a stratified, method-blind H2 answer-support task packet."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def read(path: Path) -> tuple[dict[str, Any], bytes, str]:
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), raw, hashlib.sha256(raw).hexdigest()


def write(path: Path, value: Any) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_bytes(raw)
    temp.replace(path)
    return hashlib.sha256(raw).hexdigest()


def split_spec(value: str) -> tuple[str, Path]:
    name, separator, path = value.partition("=")
    if not separator or not name or not path:
        raise argparse.ArgumentTypeError("run must be METHOD=PATH")
    return name, Path(path)


def get_chunk(document_id: str, by_source: dict[str, Any]) -> Any:
    parts = document_id.split(":", 2)
    if len(parts) != 3 or not parts[2].isdigit():
        raise ValueError(f"invalid stable documentId: {document_id}")
    return by_source[parts[0]].chunks[(parts[1], int(parts[2]))]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--corpus-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--runs", type=split_spec, action="append", required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--per-category", type=int, default=20)
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--snippet-chars", type=int, default=2000)
    args = parser.parse_args()
    if args.per_category < 1 or args.top_k < 1 or args.snippet_chars < 300:
        parser.error("per-category/top-k must be positive and snippets >= 300 chars")

    dataset, _dataset_raw, dataset_hash = read(args.dataset)
    manifest, _manifest_raw, manifest_hash = read(args.manifest)
    if dataset.get("split") != "holdout" or dataset.get("corpusVersion") != manifest.get("corpusVersion"):
        raise ValueError("answer-support selection must use the frozen HOLDOUT and matching corpus")
    if len({name for name, _path in args.runs}) != len(args.runs):
        raise ValueError("run method labels must be unique")

    repo_root = Path(__file__).resolve().parents[2]
    import sys
    sys.path.insert(0, str(repo_root / "services" / "health-engine" / "src"))
    from huiyi_health_engine.rag.corpus import CorpusRepository

    corpus = CorpusRepository(args.corpus_root, args.manifest, verify_hashes=False).load()
    if corpus.version != manifest["corpusVersion"]:
        raise ValueError("loaded corpus version differs from manifest")
    chunks_by_source = {bundle.corpus: bundle for bundle in corpus.indices}

    grouped: dict[str, list[dict[str, Any]]] = {}
    for question in dataset["questions"]:
        category = question.get("taskCategory")
        grouped.setdefault(category, []).append(question)
    selected: list[dict[str, Any]] = []
    selection_counts: dict[str, int] = {}
    for category in sorted(grouped):
        ordered = sorted(
            grouped[category],
            key=lambda item: hashlib.sha256(f"h2-answer-support-v1|{item['questionId']}".encode()).hexdigest(),
        )
        if len(ordered) < args.per_category:
            raise ValueError(f"category {category} has fewer than {args.per_category} holdout questions")
        chosen = ordered[: args.per_category]
        selected.extend(chosen)
        selection_counts[category] = len(chosen)

    tasks: list[dict[str, Any]] = []
    private_map: dict[str, dict[str, Any]] = {}
    run_sha: dict[str, str] = {}
    for method, run_path in args.runs:
        run, _raw, run_hash = read(run_path)
        if run.get("datasetId") != dataset.get("datasetId") or run.get("datasetSha256") != dataset_hash:
            raise ValueError(f"{method} run is not bound to the exact frozen HOLDOUT dataset")
        if run.get("manifestSha256") != manifest_hash:
            raise ValueError(f"{method} run manifest SHA differs")
        rows = {row["questionId"]: row for row in run.get("queries", [])}
        if set(rows) != {question["questionId"] for question in dataset["questions"]}:
            raise ValueError(f"{method} run does not cover the full HOLDOUT question set")
        run_sha[method] = run_hash
        for question in selected:
            qid = question["questionId"]
            row = rows[qid]
            item_key = hashlib.sha256(f"h2-answer-support-v1|{qid}|{method}".encode()).hexdigest()[:16]
            evidence: list[dict[str, Any]] = []
            if row.get("status") == "ok":
                for index, result in enumerate(row.get("results", [])[: args.top_k], start=1):
                    document_id = result["documentId"]
                    chunk = get_chunk(document_id, chunks_by_source)
                    evidence.append({
                        "evidenceId": f"E{index}",
                        "documentId": document_id,
                        "source": chunk.corpus,
                        "title": chunk.title,
                        "snippet": chunk.content[: args.snippet_chars],
                        "snippetSha256": hashlib.sha256(chunk.content[: args.snippet_chars].encode("utf-8")).hexdigest(),
                        "sourceUri": chunk.source_uri,
                    })
            tasks.append({
                "itemKey": item_key,
                "query": question["query"],
                "language": question.get("language", "en"),
                "evidenceSet": evidence,
                "retrievalStatus": row.get("status"),
                "abstained": bool(row.get("abstained", False)),
            })
            private_map[item_key] = {"questionId": qid, "method": method, "taskCategory": question["taskCategory"], "answerability": question["answerability"]}

    packet = {
        "schemaVersion": "huiyi-h2-answer-support-generation-packet/v1",
        "packetVersion": "h2-answer-support-v1",
        "datasetId": dataset["datasetId"],
        "datasetSha256": dataset_hash,
        "corpusVersion": corpus.version,
        "manifestSha256": manifest_hash,
        "selection": {"rule": "sha256(h2-answer-support-v1|questionId), first N per taskCategory", "perCategory": args.per_category, "counts": selection_counts, "questionCount": len(selected)},
        "runHashes": run_sha,
        "methodNamesHiddenFromGenerator": True,
        "categoryAndAnswerabilityHiddenFromGenerator": True,
        "generatorTasks": tasks,
    }
    args.out_dir.mkdir(parents=True, exist_ok=True)
    packet_sha = write(args.out_dir / "answer-generation-packet.json", packet)
    write(args.out_dir / "answer-task-private-map.json", {"schemaVersion": "huiyi-h2-answer-support-private-map/v1", "packetSha256": packet_sha, "items": private_map})
    write(args.out_dir / "answer-support-selection.json", {"datasetSha256": dataset_hash, "selectedQuestionIds": [q["questionId"] for q in selected], "countsByCategory": selection_counts, "selectionSeed": "h2-answer-support-v1"})
    print(json.dumps({"status": "ready", "questions": len(selected), "arms": len(args.runs), "answerTasks": len(tasks), "countsByCategory": selection_counts, "packetSha256": packet_sha, "out": str(args.out_dir / "answer-generation-packet.json")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
