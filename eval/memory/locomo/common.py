from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

REPO_ROOT = Path(__file__).resolve().parents[3]
ARTIFACT_ROOT = Path(os.environ.get(
    "HC_MEM_002_ARTIFACT_DIR",
    str(REPO_ROOT / "artifacts" / "hc-mem-002"),
)).expanduser().resolve()
DEFAULT_DATASET = Path(os.environ.get(
    "LOCOMO_DATASET",
    "/root/gpufree-share/data/locomo-mc10/raw/locomo10.json",
)).expanduser().resolve()
AMA_ROOT = REPO_ROOT / "third_party" / "AMA" / "python" / "AdaptiveMemory"
LOCAL_CHAT_URL = os.environ.get("HUIYI_LOCAL_LLM_BASE_URL", "http://127.0.0.1:8000/v1/chat/completions")
CONTRACT_MANIFEST = Path(__file__).with_name("manifest.json")
_CONTRACT = json.loads(CONTRACT_MANIFEST.read_text(encoding="utf-8"))
CANONICAL_MODEL_ID = _CONTRACT["models"]["qaGenerator"]["id"]
SERVED_MODEL_NAME = _CONTRACT["models"]["qaGenerator"]["servedModelName"]
LOCAL_MODEL = os.environ.get("HUIYI_LOCAL_LLM_MODEL", SERVED_MODEL_NAME)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def digest_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_dataset(path: Path = DEFAULT_DATASET) -> list[dict[str, Any]]:
    if not path.is_file():
        raise FileNotFoundError(f"LoCoMo dataset not found: {path}")
    expected_hash = json.loads(CONTRACT_MANIFEST.read_text(encoding="utf-8"))["dataset"]["sha256"]
    actual_hash = sha256_file(path)
    if actual_hash != expected_hash:
        raise ValueError(f"LoCoMo dataset SHA256 does not match the frozen contract: {actual_hash}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list) or not value:
        raise ValueError("LoCoMo dataset must be a non-empty JSON list")
    return value


def conversation_id(row: dict[str, Any], index: int) -> str:
    value = row.get("sample_id")
    return str(value) if value is not None else f"conversation-{index + 1:02d}"


def question_key(conv_id: str, question_index: int) -> str:
    return f"{conv_id}:qa-{question_index + 1:04d}"


def included_questions(dataset: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    included: list[dict[str, Any]] = []
    for conv_index, row in enumerate(dataset):
        conv_id = conversation_id(row, conv_index)
        for qa_index, qa in enumerate(row.get("qa", [])):
            category = int(qa.get("category", 0))
            if category == 5:
                continue
            included.append({
                "conversation_id": conv_id,
                "question_id": question_key(conv_id, qa_index),
                "question_index": qa_index,
                "category": category,
                "question": str(qa.get("question", "")),
                "gold_answer": str(qa.get("answer", "")),
                "evidence": qa.get("evidence", []),
            })
    return included


def filter_questions_to_conversations(
    questions: Iterable[dict[str, Any]], conversation_ids: Iterable[str]
) -> list[dict[str, Any]]:
    allowed = set(conversation_ids)
    return [item for item in questions if item["conversation_id"] in allowed]


def questions_for_state(
    dataset: Iterable[dict[str, Any]],
    manifest_path: Path | None = None,
) -> list[dict[str, Any]]:
    path = manifest_path or (ARTIFACT_ROOT / "frozen-state-manifest.json")
    if not path.is_file():
        raise FileNotFoundError(f"frozen memory state manifest not found: {path}")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    conversation_ids = manifest.get("included_conversations")
    if not isinstance(conversation_ids, list) or not all(isinstance(value, str) for value in conversation_ids):
        raise ValueError("frozen memory state manifest has no valid included_conversations scope")
    return filter_questions_to_conversations(included_questions(dataset), conversation_ids)


def parse_answer(raw: str) -> tuple[str, str | None]:
    """Apply the upstream evaluator's JSON-only QANemori output contract."""
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return "", "InvalidJson"
    if not isinstance(payload, dict) or not isinstance(payload.get("answer"), str):
        return "", "MissingAnswerField"
    return payload["answer"].strip(), None


def canonical_items(items: Iterable[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    digest_items = []
    source_ids: list[str | None] = []
    for item in items:
        if not isinstance(item, dict) and hasattr(item, "model_dump"):
            item = item.model_dump(exclude_none=True)
        kind = item.get("kind")
        content = item.get("content")
        timestamp = item.get("timestamp")
        if not isinstance(kind, str) or not isinstance(content, str):
            continue
        canonical = {"kind": kind, "content": content, "timestamp": timestamp if isinstance(timestamp, str) else None}
        digest_items.append(canonical)
        source_id = item.get("sourceId")
        source_ids.append(source_id if isinstance(source_id, str) and source_id else None)
    compact = json.dumps(digest_items, ensure_ascii=False, separators=(",", ":"))
    hashes = []
    for item, source_id in zip(digest_items, source_ids):
        record = {
            "kind": item["kind"],
            "timestamp": item["timestamp"],
            "content_sha256": digest_text(item["content"]),
        }
        if isinstance(source_id, str) and source_id:
            record["source_id"] = source_id
        hashes.append(record)
    return digest_text(compact), hashes


def snapshot_payload(items: Iterable[dict[str, Any]]) -> str:
    grouped: dict[str, list[dict[str, str]]] = {
        "text_match_results": [],
        "fact_match_results": [],
        "episodes_results": [],
    }
    names = {"raw": "text_match_results", "fact": "fact_match_results", "episode": "episodes_results"}
    for item in items:
        if not isinstance(item, dict) and hasattr(item, "model_dump"):
            item = item.model_dump(exclude_none=True)
        kind = item.get("kind")
        content = item.get("content")
        timestamp = item.get("timestamp")
        if kind not in names or not isinstance(content, str):
            continue
        if isinstance(timestamp, str) and "\ntimestamp:" not in content:
            content = f"{content}\ntimestamp:{timestamp}"
        record = {"content": content}
        source_id = item.get("sourceId")
        if isinstance(source_id, str) and source_id:
            record["dia_id"] = source_id
        grouped[names[kind]].append(record)
    return json.dumps({"retrievals": grouped, "memoryWindow": []}, ensure_ascii=False, indent=2)


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    private_output = path.resolve().is_relative_to(ARTIFACT_ROOT)
    if private_output:
        path.parent.chmod(0o700)
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    with path.open("a", encoding="utf-8") as stream:
        stream.write(line + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    if private_output:
        path.chmod(0o600)


def completed_keys(path: Path) -> set[str]:
    if not path.exists():
        return set()
    keys: set[str] = set()
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSONL at {path.name}:{line_number}") from exc
        key = row.get("question_id")
        if isinstance(key, str):
            keys.add(key)
    return keys


def configure_pinned_ama() -> None:
    contract = json.loads(CONTRACT_MANIFEST.read_text(encoding="utf-8"))
    expected_model = contract["models"]["memoryGenerator"]["servedModelName"]
    if LOCAL_MODEL != expected_model:
        raise ValueError(f"HC-MEM-002 requires served model {expected_model}")
    local_chat_url = os.environ.get("HUIYI_LOCAL_LLM_BASE_URL", LOCAL_CHAT_URL)
    _require_loopback_http(local_chat_url, "HUIYI_LOCAL_LLM_BASE_URL")
    embedding_url = os.environ.get(
        "HUIYI_MEMORY_EMBEDDING_URL",
        os.environ.get("AMA_EMBEDDING_URL", "http://127.0.0.1:8322/_internal/ama/embeddings"),
    )
    _require_loopback_http(embedding_url, "HUIYI_MEMORY_EMBEDDING_URL")
    os.environ["AMA_LLM_API_KEY"] = "local-only"
    os.environ["AMA_LLM_BASE_URL"] = local_chat_url
    os.environ["AMA_EMBEDDING_URL"] = embedding_url
    os.environ["HUIYI_LOCAL_LLM_MODEL"] = LOCAL_MODEL


def verify_local_model_endpoint() -> None:
    """Fail before a run if the loopback server is serving a different model/config."""
    from urllib.request import urlopen

    contract = json.loads(CONTRACT_MANIFEST.read_text(encoding="utf-8"))
    parsed = urlparse(LOCAL_CHAT_URL)
    if parsed.path.endswith("/chat/completions"):
        models_path = parsed.path[: -len("/chat/completions")] + "/models"
    else:
        raise ValueError("HUIYI_LOCAL_LLM_BASE_URL must end in /chat/completions")
    models_url = parsed._replace(path=models_path, params="", query="", fragment="").geturl()
    _require_loopback_http(models_url, "local model list URL")
    with urlopen(models_url, timeout=5) as response:
        payload = json.loads(response.read())
    models = payload.get("data") if isinstance(payload, dict) else None
    expected_name = contract["models"]["qaGenerator"]["servedModelName"]
    expected_context = contract["models"]["qaGenerator"]["contextWindow"]
    matching = [item for item in models or [] if isinstance(item, dict) and item.get("id") == expected_name]
    if len(matching) != 1 or matching[0].get("max_model_len") != expected_context:
        raise ValueError("local model endpoint does not match the frozen served-model name/context contract")


def _require_loopback_http(url: str, name: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError(f"{name} must use a loopback HTTP endpoint")


def require_loopback_http(url: str, name: str) -> None:
    _require_loopback_http(url, name)


def verify_state_copy(data_dir: Path) -> None:
    manifest_path = ARTIFACT_ROOT / "frozen-state-manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"frozen memory state manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    contract = json.loads(CONTRACT_MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("dataset_sha256") != contract["dataset"]["sha256"]:
        raise ValueError("frozen memory state was built from a different dataset contract")
    if manifest.get("ama_commit") != contract["amaCommit"]:
        raise ValueError("frozen memory state was built with a different AMA commit")
    if manifest.get("memory_model") != contract["models"]["memoryGenerator"]["id"]:
        raise ValueError("frozen memory state was built with a different memory generator")
    if manifest.get("memory_api_model") != contract["models"]["memoryGenerator"]["servedModelName"]:
        raise ValueError("frozen memory state was built with a different API model name")
    if manifest.get("embedding_model") != contract["models"]["embedding"]["id"]:
        raise ValueError("frozen memory state was built with a different embedding model")
    if not isinstance(manifest.get("included_conversations"), list) or not isinstance(manifest.get("selected_session_keys"), list):
        raise ValueError("frozen memory state manifest has no explicit session/conversation scope")
    if manifest.get("completed_session_count") != len(manifest["selected_session_keys"]):
        raise ValueError("frozen memory state manifest session count does not match its selected scope")
    data_dir = data_dir.expanduser().resolve()
    expected_files = manifest.get("files", [])
    if not expected_files:
        raise ValueError("frozen memory state manifest contains no files")
    for entry in expected_files:
        path = (data_dir / entry["path"]).resolve()
        if not path.is_relative_to(data_dir):
            raise ValueError("frozen memory state manifest contains a path outside the store")
        if not path.is_file():
            raise FileNotFoundError(f"frozen memory state file is missing: {entry['path']}")
        if path.stat().st_size != entry["bytes"] or sha256_file(path) != entry["sha256"]:
            raise ValueError(f"frozen memory state file differs from the frozen copy: {entry['path']}")


def add_snapshot_metrics(row: dict[str, Any], items: list[dict[str, Any]]) -> None:
    snapshot_hash, item_hashes = canonical_items(items)
    row["retrieval_hash"] = snapshot_hash
    row["retrieved_items"] = item_hashes
    row["retrieved_count"] = len(item_hashes)
    row["retrieved_kinds"] = {
        kind: sum(1 for item in item_hashes if item["kind"] == kind)
        for kind in ("raw", "fact", "episode")
    }
