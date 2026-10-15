#!/usr/bin/env python3
"""Build/query a version-pinned, contentless SQLite FTS5 BM25 index for H2."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import sqlite3
import time
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = "huiyi-h2-bm25-fts5/v1"
_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9]+(?:[._/+%-][A-Za-z0-9]+)*|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")


class SparseIndexError(RuntimeError):
    pass


def tokenize(text: str) -> list[str]:
    """Deterministic English word + overlapping CJK bigram tokenizer."""
    output: list[str] = []
    for match in _TOKEN_PATTERN.finditer(text):
        token = match.group(0)
        if token[0].isascii():
            output.append(token.casefold())
        elif len(token) == 1:
            output.append(token)
        else:
            output.extend(token[index : index + 2] for index in range(len(token) - 1))
    return output


def _fts_query(text: str) -> str:
    unique = list(dict.fromkeys(tokenize(text)))
    if not unique:
        return ""
    return " OR ".join('"' + token.replace('"', '""') + '"' for token in unique)


def _jsonl_files(manifest: dict[str, Any], root: Path) -> Iterable[tuple[dict[str, Any], dict[str, Any], Path]]:
    for source in manifest.get("sources", []):
        source_name = source.get("name") if isinstance(source, dict) else None
        if not isinstance(source_name, str) or not source_name:
            raise SparseIndexError("manifest has an invalid source entry")
        chunk_files = source.get("chunkFiles")
        if not isinstance(chunk_files, list):
            raise SparseIndexError(f"manifest source {source_name} has no chunkFiles list")
        for spec in sorted(chunk_files, key=lambda item: str(item.get("path", ""))):
            relative = spec.get("path")
            if not isinstance(relative, str) or not relative:
                raise SparseIndexError(f"manifest source {source_name} has an invalid chunk path")
            path = (root / relative).resolve()
            if not path.is_relative_to(root.resolve()) or not path.is_file():
                raise SparseIndexError(f"manifest chunk path is missing or outside corpus root ({source_name})")
            expected = spec.get("sha256")
            if not isinstance(expected, str) or len(expected) != 64:
                raise SparseIndexError(f"manifest chunk hash is missing ({source_name})")
            yield source, spec, path


def _connect(path: Path) -> sqlite3.Connection:
    try:
        connection = sqlite3.connect(path)
        connection.execute("CREATE VIRTUAL TABLE IF NOT EXISTS sparse_docs USING fts5(title, body, content='', tokenize='unicode61 remove_diacritics 2')")
        return connection
    except sqlite3.OperationalError as exc:
        raise SparseIndexError("Python SQLite was built without FTS5 support") from exc


def build_index(
    corpus_root: Path,
    manifest_path: Path,
    output_path: Path,
    max_output_bytes: int,
    min_free_bytes: int,
    batch_size: int = 1000,
) -> dict[str, Any]:
    corpus_root = corpus_root.resolve()
    manifest_path = manifest_path.resolve()
    output_path = output_path.resolve()
    if not corpus_root.is_dir() or not manifest_path.is_file():
        raise SparseIndexError("corpus root or manifest is missing")
    raw_manifest = manifest_path.read_bytes()
    manifest_hash = hashlib.sha256(raw_manifest).hexdigest()
    manifest = json.loads(raw_manifest.decode("utf-8"))
    corpus_version = manifest.get("corpusVersion") if isinstance(manifest, dict) else None
    if not isinstance(corpus_version, str) or not corpus_version:
        raise SparseIndexError("manifest corpusVersion is missing")
    if output_path.exists():
        raise SparseIndexError("output already exists; choose a new path instead of overwriting an index")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(output_path.parent)
    if usage.free < min_free_bytes:
        raise SparseIndexError("available disk space is below configured minimum")
    input_bytes = 0
    file_specs = list(_jsonl_files(manifest, corpus_root))
    for _, _, path in file_specs:
        input_bytes += path.stat().st_size
    if input_bytes <= 0:
        raise SparseIndexError("manifest contains no chunk bytes")

    started = time.perf_counter()
    connection = _connect(output_path)
    connection.execute("PRAGMA journal_mode=DELETE")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.execute("PRAGMA temp_store=FILE")
    connection.execute("CREATE TABLE sparse_meta (rowid INTEGER PRIMARY KEY, document_id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, source_document_id TEXT NOT NULL, chunk_id TEXT NOT NULL, path TEXT NOT NULL, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL, title TEXT NOT NULL)")
    connection.execute("CREATE TABLE build_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    metadata = {
        "schemaVersion": SCHEMA_VERSION,
        "status": "building",
        "corpusVersion": corpus_version,
        "manifestSha256": manifest_hash,
        "sourceCount": len(manifest.get("sources", [])),
        "expectedChunkCount": sum(int(source.get("chunkCount", 0)) for source in manifest.get("sources", [])),
        "chunkCount": 0,
        "chunkFileCount": len(file_specs),
        "inputChunkBytes": input_bytes,
        "tokenizer": "latin-word-casefold+cjk-character-bigram-v1",
        "bm25": {"engine": "SQLite FTS5 bm25", "titleWeight": 3.0, "bodyWeight": 1.0, "k1": 1.2, "b": 0.75},
    }
    connection.executemany("INSERT INTO build_metadata(key,value) VALUES (?,?)", [(key, json.dumps(value, ensure_ascii=False)) for key, value in metadata.items()])
    connection.commit()

    next_rowid = 1
    indexed_count = 0
    next_progress_count = 50_000
    batch: list[tuple[Any, ...]] = []
    try:
        for source, chunk_spec, path in file_specs:
            digest = hashlib.sha256()
            source_name = source["name"]
            relative_path = path.relative_to(corpus_root).as_posix()
            source_document_id = path.name.removesuffix(".jsonl")
            byte_offset = 0
            with path.open("rb") as stream:
                for line_number, line in enumerate(stream):
                    digest.update(line)
                    line_start = byte_offset
                    byte_offset += len(line)
                    if not line.strip():
                        continue
                    try:
                        row = json.loads(line)
                    except (UnicodeError, json.JSONDecodeError) as exc:
                        raise SparseIndexError(f"invalid JSONL row in source {source_name}") from exc
                    if not isinstance(row, dict) or not isinstance(row.get("title"), str) or not isinstance(row.get("content"), str):
                        raise SparseIndexError(f"chunk row missing title/content in source {source_name}")
                    title_tokens = tokenize(row["title"])
                    body_tokens = tokenize(row["content"])
                    if not title_tokens and not body_tokens:
                        continue
                    rowid = next_rowid
                    next_rowid += 1
                    chunk_id = str(line_number)
                    document_id = f"{source_name}:{source_document_id}:{chunk_id}"
                    batch.append((
                        rowid,
                        " ".join(title_tokens),
                        " ".join(body_tokens),
                        document_id,
                        source_name,
                        source_document_id,
                        chunk_id,
                        relative_path,
                        line_start,
                        len(line),
                        row["title"],
                    ))
                    if len(batch) >= batch_size:
                        _insert_batch(connection, batch)
                        indexed_count += len(batch)
                        batch.clear()
                        _update_progress(connection, indexed_count)
                        if indexed_count >= next_progress_count:
                            print(json.dumps({
                                "status": "building",
                                "indexedChunks": indexed_count,
                                "indexBytes": output_path.stat().st_size,
                                "elapsedSeconds": round(time.perf_counter() - started, 1),
                            }), flush=True)
                            next_progress_count += 50_000
                        if output_path.stat().st_size > max_output_bytes:
                            raise SparseIndexError("sparse index reached configured output size limit")
                        if shutil.disk_usage(output_path.parent).free < min_free_bytes:
                            raise SparseIndexError("available disk space fell below configured minimum")
            if digest.hexdigest() != chunk_spec["sha256"]:
                raise SparseIndexError(f"chunk file hash mismatch for source {source_name}")
        if batch:
            _insert_batch(connection, batch)
            indexed_count += len(batch)
            batch.clear()
        if output_path.stat().st_size > max_output_bytes:
            raise SparseIndexError("sparse index reached configured output size limit")
        if indexed_count != metadata["expectedChunkCount"]:
            raise SparseIndexError("indexed chunk count differs from manifest")
        metadata.update({
            "status": "ready",
            "chunkCount": indexed_count,
            "indexBytes": output_path.stat().st_size,
            "buildSeconds": round(time.perf_counter() - started, 3),
        })
        connection.executemany("UPDATE build_metadata SET value=? WHERE key=?", [(json.dumps(value, ensure_ascii=False), key) for key, value in metadata.items()])
        connection.commit()
        return metadata
    except Exception as exc:
        connection.rollback()
        connection.execute("UPDATE build_metadata SET value=? WHERE key='status'", (json.dumps("failed"),))
        connection.execute("INSERT OR REPLACE INTO build_metadata(key,value) VALUES ('failureClass',?)", (json.dumps(type(exc).__name__),))
        connection.commit()
        raise
    finally:
        connection.close()


def _insert_batch(connection: sqlite3.Connection, batch: list[tuple[Any, ...]]) -> None:
    fts_rows = [(row[0], row[1], row[2]) for row in batch]
    meta_rows = [(row[0], *row[3:]) for row in batch]
    with connection:
        connection.executemany("INSERT INTO sparse_docs(rowid,title,body) VALUES (?,?,?)", fts_rows)
        connection.executemany("INSERT INTO sparse_meta(rowid,document_id,source,source_document_id,chunk_id,path,byte_offset,byte_length,title) VALUES (?,?,?,?,?,?,?,?,?)", meta_rows)


def _update_progress(connection: sqlite3.Connection, count: int) -> None:
    with connection:
        connection.execute("UPDATE build_metadata SET value=? WHERE key='chunkCount'", (json.dumps(count),))


class Fts5Bm25Index:
    def __init__(self, index_path: Path, corpus_version: str, manifest_sha256: str | None = None):
        self.index_path = index_path.resolve()
        if not self.index_path.is_file():
            raise SparseIndexError("BM25 index is missing")
        uri = self.index_path.as_uri() + "?mode=ro"
        self.connection = sqlite3.connect(uri, uri=True)
        metadata = {key: json.loads(value) for key, value in self.connection.execute("SELECT key,value FROM build_metadata")}
        if metadata.get("schemaVersion") != SCHEMA_VERSION or metadata.get("status") != "ready":
            self.connection.close()
            raise SparseIndexError("BM25 index is not complete or has an unsupported schema")
        if metadata.get("corpusVersion") != corpus_version:
            self.connection.close()
            raise SparseIndexError("BM25 index corpusVersion mismatch")
        if manifest_sha256 is not None and metadata.get("manifestSha256") != manifest_sha256:
            self.connection.close()
            raise SparseIndexError("BM25 index manifest hash mismatch")
        self.metadata = metadata

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        if limit < 1:
            return []
        expression = _fts_query(query)
        if not expression:
            return []
        rows = self.connection.execute(
            "SELECT m.document_id,m.source,m.source_document_id,m.chunk_id,m.path,m.byte_offset,m.byte_length,m.title,bm25(sparse_docs,3.0,1.0) AS rank_score "
            "FROM sparse_docs JOIN sparse_meta AS m ON m.rowid=sparse_docs.rowid "
            "WHERE sparse_docs MATCH ? ORDER BY rank_score ASC,m.document_id ASC LIMIT ?",
            (expression, limit),
        ).fetchall()
        output = []
        for rank, row in enumerate(rows, start=1):
            output.append({
                "documentId": row[0],
                "source": row[1],
                "sourceDocumentId": row[2],
                "chunkId": row[3],
                "path": row[4],
                "byteOffset": row[5],
                "byteLength": row[6],
                "title": row[7],
                "score": float(-row[8]),
                "rank": rank,
            })
        return output

    def close(self) -> None:
        self.connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus-root", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--max-output-gib", type=float, default=8.0)
    parser.add_argument("--min-free-gib", type=float, default=30.0)
    parser.add_argument("--batch-size", type=int, default=1000)
    args = parser.parse_args()
    if args.max_output_gib <= 0 or args.min_free_gib < 0 or args.batch_size < 1:
        parser.error("size limits must be positive and batch-size at least 1")
    try:
        result = build_index(
            args.corpus_root,
            args.manifest,
            args.out,
            max_output_bytes=int(args.max_output_gib * (1024**3)),
            min_free_bytes=int(args.min_free_gib * (1024**3)),
            batch_size=args.batch_size,
        )
    except Exception as exc:
        print(json.dumps({"status": "failed", "failureClass": type(exc).__name__}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
