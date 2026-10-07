from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class CorpusError(RuntimeError):
    pass


@dataclass(frozen=True)
class CorpusChunk:
    corpus: str
    source_document_id: str
    chunk_id: str
    title: str
    content: str
    source_uri: str | None = None

    @property
    def stable_id(self) -> str:
        return f"{self.corpus}:{self.source_document_id}:{self.chunk_id}"


@dataclass(frozen=True)
class CorpusIndex:
    corpus: str
    index: Any
    metadata: tuple[dict[str, Any], ...]
    chunks: dict[tuple[str, int], CorpusChunk]


@dataclass(frozen=True)
class PreparedCorpus:
    version: str
    retriever_name: str
    query_encoder_model: str
    query_encoder_revision: str
    article_encoder_model: str
    article_encoder_revision: str
    sources: tuple[dict[str, Any], ...]
    indices: tuple[CorpusIndex, ...]
    chunk_count: int


class CorpusRepository:
    """Loads only assets named by a local manifest; never downloads or builds."""

    def __init__(self, root: Path, manifest_path: Path, verify_hashes: bool = True):
        self.root = root.resolve()
        self.manifest_path = manifest_path.resolve()
        self.verify_hashes = verify_hashes

    def load(self) -> PreparedCorpus:
        if not self.root.is_dir() or not self.manifest_path.is_file():
            raise CorpusError("prepared corpus root or manifest is missing")
        try:
            manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except Exception:
            raise CorpusError("corpus manifest is invalid JSON") from None
        if not isinstance(manifest, dict) or not isinstance(manifest.get("corpusVersion"), str):
            raise CorpusError("corpus manifest is missing corpusVersion")

        retriever = manifest.get("retriever")
        sources = manifest.get("sources")
        index_specs = manifest.get("indices")
        if not isinstance(retriever, dict) or not isinstance(sources, list) or not isinstance(index_specs, list):
            raise CorpusError("corpus manifest is missing retriever, sources, or indices")
        for field in ("name", "queryEncoderModel", "queryEncoderRevision", "articleEncoderModel", "articleEncoderRevision"):
            if not isinstance(retriever.get(field), str) or not retriever[field]:
                raise CorpusError(f"corpus manifest retriever.{field} is missing")
        if not sources or len(sources) != len(index_specs):
            raise CorpusError("corpus source and index lists must be non-empty and aligned")

        source_by_name: dict[str, dict[str, Any]] = {}
        for source in sources:
            if not isinstance(source, dict) or not isinstance(source.get("name"), str):
                raise CorpusError("corpus manifest contains an invalid source")
            if source["name"] in source_by_name:
                raise CorpusError("corpus manifest contains duplicate source names")
            self._verify_files(source.get("chunkFiles"), "chunkFiles")
            if not isinstance(source.get("documentCount"), int) or not isinstance(source.get("chunkCount"), int):
                raise CorpusError("corpus manifest source counts are invalid")
            source_by_name[source["name"]] = source

        loaded_indices: list[CorpusIndex] = []
        total_chunks = 0
        index_hash_entries: list[tuple[str, str]] = []
        seen_indices: set[str] = set()
        for spec in index_specs:
            if not isinstance(spec, dict) or not isinstance(spec.get("corpus"), str):
                raise CorpusError("corpus manifest contains an invalid index entry")
            corpus = spec["corpus"]
            source = source_by_name.get(corpus)
            if source is None or corpus in seen_indices:
                raise CorpusError("corpus index does not map one-to-one to its source")
            seen_indices.add(corpus)
            index_hash_entries.extend(self._verify_files(spec.get("files"), "index files"))
            index_path = self._asset_path(spec.get("indexPath"))
            metadata_path = self._asset_path(spec.get("metadataPath"))
            try:
                import faiss

                index = faiss.read_index(str(index_path))
                metadata = tuple(
                    json.loads(line)
                    for line in metadata_path.read_text(encoding="utf-8").splitlines()
                    if line.strip()
                )
            except Exception as exc:
                raise CorpusError(f"failed to load prepared {corpus} FAISS index ({type(exc).__name__})") from None
            if getattr(index, "metric_type", None) != faiss.METRIC_INNER_PRODUCT:
                raise CorpusError(f"prepared {corpus} index is not MedCPT inner-product search")
            if index.ntotal != len(metadata) or index.ntotal != source["chunkCount"]:
                raise CorpusError(f"prepared {corpus} index, metadata, and manifest counts differ")
            expected_vectors = spec.get("vectorCount")
            if not isinstance(expected_vectors, int) or expected_vectors != index.ntotal:
                raise CorpusError(f"prepared {corpus} index vector count differs from manifest")

            chunks = self._load_chunks(source)
            if len(chunks) != index.ntotal:
                raise CorpusError(f"prepared {corpus} chunk count differs from its FAISS index")
            if len({source_id for source_id, _ in chunks}) != source["documentCount"]:
                raise CorpusError(f"prepared {corpus} document count differs from manifest")
            for row in metadata:
                if not isinstance(row, dict) or not isinstance(row.get("source"), str) or not isinstance(row.get("index"), int):
                    raise CorpusError(f"prepared {corpus} metadata contains an invalid chunk reference")
                if (row["source"], row["index"]) not in chunks:
                    raise CorpusError(f"prepared {corpus} metadata references a missing chunk")
            loaded_indices.append(CorpusIndex(corpus, index, metadata, chunks))
            total_chunks += len(chunks)

        if seen_indices != set(source_by_name):
            raise CorpusError("some prepared corpora do not have a matching index")
        expected_index_hash = manifest.get("indexHash")
        actual_index_hash = _aggregate_hash(index_hash_entries)
        if not isinstance(expected_index_hash, str) or actual_index_hash != expected_index_hash:
            raise CorpusError("prepared index aggregate hash differs from manifest")
        return PreparedCorpus(
            version=manifest["corpusVersion"],
            retriever_name=retriever["name"],
            query_encoder_model=retriever["queryEncoderModel"],
            query_encoder_revision=retriever["queryEncoderRevision"],
            article_encoder_model=retriever["articleEncoderModel"],
            article_encoder_revision=retriever["articleEncoderRevision"],
            sources=tuple(sources),
            indices=tuple(loaded_indices),
            chunk_count=total_chunks,
        )

    def _load_chunks(self, source: dict[str, Any]) -> dict[tuple[str, int], CorpusChunk]:
        chunks: dict[tuple[str, int], CorpusChunk] = {}
        for item in source.get("chunkFiles", []):
            path = self._asset_path(item.get("path"))
            stem = path.name.removesuffix(".jsonl")
            for chunk_number, line in enumerate(path.read_text(encoding="utf-8").splitlines()):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    raise CorpusError(f"prepared chunk file {path.name} contains invalid JSON") from None
                title = row.get("title") if isinstance(row, dict) else None
                content = row.get("content") if isinstance(row, dict) else None
                if not isinstance(title, str) or not isinstance(content, str):
                    raise CorpusError(f"prepared chunk file {path.name} is missing title/content")
                source_uri = row.get("sourceUri") or row.get("source_uri")
                chunks[(stem, chunk_number)] = CorpusChunk(
                    corpus=source["name"],
                    source_document_id=stem,
                    chunk_id=str(chunk_number),
                    title=title,
                    content=content,
                    source_uri=source_uri if isinstance(source_uri, str) else None,
                )
        if len(chunks) != source["chunkCount"]:
            raise CorpusError(f"prepared {source['name']} chunk count differs from manifest")
        return chunks

    def _verify_files(self, files: object, label: str) -> list[tuple[str, str]]:
        if not isinstance(files, list) or not files:
            raise CorpusError(f"corpus manifest {label} is empty")
        verified: list[tuple[str, str]] = []
        for item in files:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not isinstance(item.get("sha256"), str):
                raise CorpusError(f"corpus manifest {label} entry is invalid")
            path = self._asset_path(item["path"])
            if not path.is_file():
                raise CorpusError(f"prepared corpus asset is missing: {item['path']}")
            if self.verify_hashes and _sha256(path) != item["sha256"]:
                raise CorpusError(f"prepared corpus asset hash mismatch: {item['path']}")
            verified.append((item["path"], item["sha256"]))
        return verified

    def _asset_path(self, relative: object) -> Path:
        if not isinstance(relative, str) or not relative:
            raise CorpusError("corpus manifest contains an invalid asset path")
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root):
            raise CorpusError("corpus manifest asset escapes the configured corpus root")
        return path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _aggregate_hash(entries: list[tuple[str, str]]) -> str:
    canonical = "\n".join(f"{path}\t{digest}" for path, digest in sorted(entries)) + "\n"
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
