from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

import numpy as np

from .corpus import CorpusChunk, PreparedCorpus


@dataclass(frozen=True)
class RetrievalCandidate:
    chunk: CorpusChunk
    score: float
    retrieval_query: str
    retrieval_round: int


class MedCptRetriever:
    """MedCPT CLS query encoding over an explicitly prepared FAISS IndexFlatIP."""

    def __init__(
        self,
        corpus: PreparedCorpus,
        query_encoder_path: str,
        device: str = "cpu",
        query_max_length: int = 512,
        encoder: Callable[[str], np.ndarray] | None = None,
    ):
        self.corpus = corpus
        self.query_max_length = query_max_length
        self._encode_override = encoder
        self._tokenizer: Any = None
        self._model: Any = None
        if encoder is None:
            from transformers import AutoModel, AutoTokenizer
            import torch

            self._torch = torch
            self._tokenizer = AutoTokenizer.from_pretrained(query_encoder_path, local_files_only=True)
            self._model = AutoModel.from_pretrained(query_encoder_path, local_files_only=True)
            self._model.to(device)
            self._model.eval()
            self._device = device

    def search(self, query: str, top_k: int, retrieval_round: int) -> list[RetrievalCandidate]:
        if top_k < 1:
            return []
        vector = self._encode(query).astype(np.float32, copy=False).reshape(1, -1)
        candidates: list[RetrievalCandidate] = []
        for bundle in self.corpus.indices:
            count = min(top_k, int(bundle.index.ntotal))
            if count == 0:
                continue
            scores, indices = bundle.index.search(vector, count)
            for raw_score, raw_position in zip(scores[0].tolist(), indices[0].tolist(), strict=True):
                if raw_position < 0 or raw_position >= len(bundle.metadata):
                    continue
                row = bundle.metadata[raw_position]
                chunk = bundle.chunks[(row["source"], row["index"])]
                candidates.append(RetrievalCandidate(chunk, float(raw_score), query, retrieval_round))
        candidates.sort(key=lambda item: (-item.score, item.chunk.stable_id))
        return candidates[:top_k]

    def _encode(self, query: str) -> np.ndarray:
        if self._encode_override is not None:
            return np.asarray(self._encode_override(query), dtype=np.float32)
        tokens = self._tokenizer(
            [query],
            padding=True,
            truncation=True,
            max_length=self.query_max_length,
            return_tensors="pt",
        )
        tokens = {key: value.to(self._device) for key, value in tokens.items()}
        with self._torch.no_grad():
            result = self._model(**tokens).last_hidden_state[:, 0, :]
        return result[0].detach().float().cpu().numpy()
