from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from sparse_index import Fts5Bm25Index, build_index, tokenize


class SparseIndexTests(unittest.TestCase):
    def test_tokenizer_is_deterministic_for_english_and_chinese(self) -> None:
        self.assertEqual(tokenize("MedCPT 药物核对"), ["medcpt", "药物", "物核", "核对"])

    def test_build_and_query_small_versioned_contentless_index(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            base = Path(directory)
            corpus_root = base / "corpus"
            corpus_root.mkdir()
            chunk_file = corpus_root / "textbooks" / "chunk" / "test-doc.jsonl"
            chunk_file.parent.mkdir(parents=True)
            rows = [
                {"title": "Medication reconciliation", "content": "Compare the medication list with discharge records."},
                {"title": "Allergy history", "content": "Record source and date of the allergy information."},
            ]
            raw = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows).encode("utf-8")
            chunk_file.write_bytes(raw)
            manifest_path = base / "manifest.json"
            manifest_path.write_text(json.dumps({
                "corpusVersion": "fixture-v1",
                "sources": [{
                    "name": "textbooks",
                    "chunkCount": 2,
                    "chunkFiles": [{"path": "textbooks/chunk/test-doc.jsonl", "sha256": hashlib.sha256(raw).hexdigest()}],
                }],
            }), encoding="utf-8")
            index_path = base / "bm25.sqlite3"
            metadata = build_index(corpus_root, manifest_path, index_path, max_output_bytes=10_000_000, min_free_bytes=0, batch_size=1)
            self.assertEqual(metadata["status"], "ready")
            self.assertEqual(metadata["chunkCount"], 2)
            index = Fts5Bm25Index(index_path, "fixture-v1", hashlib.sha256(manifest_path.read_bytes()).hexdigest())
            results = index.search("medication discharge", 2)
            index.close()
            self.assertEqual(results[0]["documentId"], "textbooks:test-doc:0")
            self.assertEqual(results[0]["sourceDocumentId"], "test-doc")

    def test_manifest_hash_mismatch_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            index_path = Path(directory) / "bm25.sqlite3"
            import sqlite3

            db = sqlite3.connect(index_path)
            db.execute("CREATE VIRTUAL TABLE sparse_docs USING fts5(title, body, content='')")
            db.execute("CREATE TABLE build_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            metadata = {
                "schemaVersion": "huiyi-h2-bm25-fts5/v1",
                "status": "ready",
                "corpusVersion": "fixture-v1",
                "manifestSha256": "a" * 64,
            }
            db.executemany("INSERT INTO build_metadata(key,value) VALUES (?,?)", [(key, json.dumps(value)) for key, value in metadata.items()])
            db.commit()
            db.close()
            with self.assertRaisesRegex(RuntimeError, "manifest hash mismatch"):
                Fts5Bm25Index(index_path, "fixture-v1", "b" * 64)


if __name__ == "__main__":
    unittest.main()
