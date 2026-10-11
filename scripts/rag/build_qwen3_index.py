#!/usr/bin/env python3
"""Build a local Qwen3-Embedding FAISS index from prepared JSONL chunks."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import faiss
import numpy as np
import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer


TASK_DESCRIPTION = (
    "Given a medical or healthcare information request, retrieve relevant evidence passages "
    "that answer the query. The query and passages may be in Chinese or English."
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chunk-root", type=Path, required=True)
    parser.add_argument("--index-dir", type=Path, required=True)
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--max-length", type=int, default=1024)
    args = parser.parse_args()
    if not args.chunk_root.is_dir() or not args.model_path.is_dir():
        raise SystemExit("chunk root and local Qwen3 embedding model path must exist")
    if args.batch_size < 1 or args.batch_size > 128:
        raise SystemExit("batch size must be between 1 and 128")
    if args.max_length < 8 or args.max_length > 32768:
        raise SystemExit("max length must be between 8 and 32768")

    tokenizer = AutoTokenizer.from_pretrained(
        str(args.model_path), local_files_only=True, padding_side="left"
    )
    model_kwargs: dict[str, object] = {"local_files_only": True}
    if args.device.startswith("cuda"):
        model_kwargs["dtype"] = torch.float16
    model = AutoModel.from_pretrained(str(args.model_path), **model_kwargs).to(args.device).eval()
    args.index_dir.mkdir(parents=True, exist_ok=True)
    chunk_paths = sorted(args.chunk_root.glob("*.jsonl"))
    if not chunk_paths:
        raise SystemExit("no prepared chunk JSONL files found")
    index = faiss.IndexFlatIP(int(model.config.hidden_size))
    metadata_tmp = args.index_dir / "metadatas.jsonl.tmp"
    index_tmp = args.index_dir / "faiss.index.tmp"
    total = 0
    pending_rows: list[tuple[str, int, dict[str, object]]] = []

    def encode_pending(stream) -> None:
        nonlocal total
        if not pending_rows:
            return
        texts = [f"{row['title']}\n{row['content']}" for _, _, row in pending_rows]
        encoded = tokenizer(
            texts,
            padding=True,
            truncation=True,
            max_length=args.max_length,
            return_tensors="pt",
        ).to(args.device)
        with torch.no_grad():
            hidden = model(**encoded).last_hidden_state
            # Left padding makes the final sequence position each row's last token.
            normalized = F.normalize(hidden[:, -1, :].float(), p=2, dim=1)
        vectors = normalized.cpu().numpy().astype(np.float32, copy=False)
        index.add(vectors)
        for stem, row_number, _ in pending_rows:
            stream.write(json.dumps({"index": row_number, "source": stem}, separators=(",", ":")) + "\n")
        total += len(pending_rows)
        pending_rows.clear()
        if total % 4096 < args.batch_size:
            print(f"indexed {total:,} chunks", flush=True)

    with metadata_tmp.open("w", encoding="utf-8", newline="\n") as metadata_stream:
        for chunk_number, chunk_path in enumerate(chunk_paths, start=1):
            row_number = 0
            with chunk_path.open("r", encoding="utf-8") as source_stream:
                for line in source_stream:
                    if not line.strip():
                        continue
                    row = json.loads(line)
                    if not isinstance(row.get("title"), str) or not isinstance(row.get("content"), str):
                        raise SystemExit(f"{chunk_path.name}: row is missing string title/content")
                    pending_rows.append((chunk_path.stem, row_number, row))
                    row_number += 1
                    if len(pending_rows) >= args.batch_size:
                        encode_pending(metadata_stream)
            if chunk_number % 500 == 0 or chunk_number == len(chunk_paths):
                print(f"read {chunk_number:,}/{len(chunk_paths):,} chunk files ({total:,} vectors)", flush=True)
        encode_pending(metadata_stream)
        metadata_stream.flush()
        os.fsync(metadata_stream.fileno())

    if total == 0:
        metadata_tmp.unlink(missing_ok=True)
        raise SystemExit("chunk files contained no non-empty rows")
    faiss.write_index(index, str(index_tmp))
    os.replace(metadata_tmp, args.index_dir / "metadatas.jsonl")
    os.replace(index_tmp, args.index_dir / "faiss.index")
    print(json.dumps({
        "vectors": int(index.ntotal),
        "dimension": int(index.d),
        "indexType": "faiss.IndexFlatIP",
        "vectorNormalization": "l2",
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
