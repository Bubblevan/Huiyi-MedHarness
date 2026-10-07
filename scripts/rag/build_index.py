#!/usr/bin/env python3
"""Build MedCPT article vectors and a FAISS inner-product index offline."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import faiss
import numpy as np
import torch
from transformers import AutoModel, AutoTokenizer


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chunk-root", type=Path, required=True)
    parser.add_argument("--index-dir", type=Path, required=True)
    parser.add_argument("--article-encoder-path", type=Path, required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--batch-size", type=int, default=16)
    args = parser.parse_args()
    if not args.chunk_root.is_dir() or not args.article_encoder_path.is_dir():
        raise SystemExit("chunk root and local MedCPT Article Encoder path must exist")
    if args.batch_size < 1 or args.batch_size > 128:
        raise SystemExit("batch size must be between 1 and 128")

    tokenizer = AutoTokenizer.from_pretrained(str(args.article_encoder_path), local_files_only=True)
    model = AutoModel.from_pretrained(str(args.article_encoder_path), local_files_only=True).to(args.device).eval()
    args.index_dir.mkdir(parents=True, exist_ok=True)
    embedding_dir = args.index_dir / "embedding"
    embedding_dir.mkdir(parents=True, exist_ok=True)
    metadata: list[dict[str, object]] = []
    vectors: list[np.ndarray] = []
    row_base = 0

    with torch.no_grad():
        for chunk_path in sorted(args.chunk_root.glob("*.jsonl")):
            rows = [json.loads(line) for line in chunk_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            file_vectors: list[np.ndarray] = []
            for start in range(0, len(rows), args.batch_size):
                batch = rows[start : start + args.batch_size]
                encoded = tokenizer(
                    [row["title"] for row in batch],
                    [row["content"] for row in batch],
                    padding=True,
                    truncation=True,
                    max_length=512,
                    return_tensors="pt",
                )
                encoded = {key: value.to(args.device) for key, value in encoded.items()}
                output = model(**encoded).last_hidden_state[:, 0, :].detach().float().cpu().numpy()
                file_vectors.append(output.astype(np.float32, copy=False))
            matrix = np.concatenate(file_vectors, axis=0)
            np.save(embedding_dir / f"{chunk_path.stem}.npy", matrix)
            vectors.append(matrix)
            for row_number in range(len(rows)):
                metadata.append({"index": row_number, "source": chunk_path.stem})
            row_base += len(rows)

    if not vectors:
        raise SystemExit("no prepared chunk JSONL files found")
    all_vectors = np.concatenate(vectors, axis=0).astype(np.float32, copy=False)
    index = faiss.IndexFlatIP(all_vectors.shape[1])
    index.add(all_vectors)
    faiss.write_index(index, str(args.index_dir / "faiss.index"))
    with (args.index_dir / "metadatas.jsonl").open("w", encoding="utf-8") as stream:
        for item in metadata:
            stream.write(json.dumps(item, separators=(",", ":")) + "\n")
    print(json.dumps({"vectors": int(index.ntotal), "dimension": int(index.d), "indexType": "faiss.IndexFlatIP"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
