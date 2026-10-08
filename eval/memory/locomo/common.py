from __future__ import annotations

import hashlib
import json
import math
import os
import re
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

REPO_ROOT = Path(__file__).resolve().parents[3]
ARTIFACT_ROOT = Path(os.environ.get(
    "HC_MEM_ARTIFACT_DIR",
    os.environ.get(
        "HC_MEM_003_ARTIFACT_DIR",
        os.environ.get("HC_MEM_002_ARTIFACT_DIR", str(REPO_ROOT / "artifacts" / "hc-mem-002")),
    ),
)).expanduser().resolve()
DEFAULT_DATASET = Path(os.environ.get(
    "LOCOMO_DATASET",
    "/root/gpufree-share/data/locomo-mc10/raw/locomo10.json",
)).expanduser().resolve()
AMA_ROOT = REPO_ROOT / "third_party" / "AMA" / "python" / "AdaptiveMemory"
LOCAL_CHAT_URL = os.environ.get("HUIYI_LOCAL_LLM_BASE_URL", "http://127.0.0.1:8000/v1/chat/completions")
CONTRACT_MANIFEST = Path(os.environ.get("HC_MEM_CONTRACT", str(Path(__file__).with_name("manifest.json")))).expanduser().resolve()
_CONTRACT = json.loads(CONTRACT_MANIFEST.read_text(encoding="utf-8"))
CANONICAL_MODEL_ID = _CONTRACT["models"]["qaGenerator"]["id"]
SERVED_MODEL_NAME = _CONTRACT["models"]["qaGenerator"]["servedModelName"]
LOCAL_MODEL = os.environ.get("HUIYI_LOCAL_LLM_MODEL", SERVED_MODEL_NAME)
QA_MAX_TOKENS = int(os.environ.get("LOCOMO_QA_MAX_TOKENS", _CONTRACT["generation"].get("maxTokens", 16384)))
STATE_NAME = os.environ.get("HC_MEM_STATE_NAME", "frozen-state")
if not re.fullmatch(r"frozen-state[a-z0-9-]*", STATE_NAME):
    raise ValueError("HC_MEM_STATE_NAME must be a simple frozen-state name")
STATE_MANIFEST = Path(os.environ.get("HC_MEM_STATE_MANIFEST", str(ARTIFACT_ROOT / f"{STATE_NAME}-manifest.json"))).expanduser().resolve()
STATE_COPIES_MANIFEST = ARTIFACT_ROOT / f"{STATE_NAME}-copies-manifest.json"


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
    if _CONTRACT.get("requiredStoreScope") == "full":
        validate_full_dataset_contract(value)
    return value


def validate_full_dataset_contract(dataset: list[dict[str, Any]]) -> dict[str, Any]:
    expected = _CONTRACT["dataset"]
    category_counts: dict[str, int] = {}
    total_questions = 0
    session_count = 0
    dialogue_item_count = 0
    for row in dataset:
        total_questions += len(row.get("qa", []))
        for qa in row.get("qa", []):
            key = str(qa.get("category", 0))
            category_counts[key] = category_counts.get(key, 0) + 1
        conversation = row.get("conversation", {})
        index = 1
        while f"session_{index}" in conversation:
            dialogue = conversation[f"session_{index}"] or []
            if dialogue:
                session_count += 1
                dialogue_item_count += len(dialogue)
            index += 1
    category_names = expected["categoryCountsIncluded"]
    expected_included = {
        "1": int(category_names["1_single_hop"]),
        "2": int(category_names["2_temporal"]),
        "3": int(category_names["3_multi_hop"]),
        "4": int(category_names["4_open_domain"]),
    }
    actual_included = {key: count for key, count in category_counts.items() if key != "5"}
    if len(dataset) != int(expected["conversationCount"]):
        raise ValueError("LoCoMo conversation count differs from the full benchmark contract")
    if total_questions != int(expected["totalQuestionCount"]):
        raise ValueError("LoCoMo total question count differs from the full benchmark contract")
    if category_counts.get("5", 0) != int(expected["excludedQuestionCount"]):
        raise ValueError("LoCoMo category-5 count differs from the full benchmark contract")
    if sum(actual_included.values()) != int(expected["includedQuestionCount"]):
        raise ValueError("LoCoMo included question count differs from the full benchmark contract")
    if actual_included != expected_included:
        raise ValueError("LoCoMo included category counts differ from the full benchmark contract")
    if session_count != int(expected["sessionCount"]) or dialogue_item_count != int(expected["dialogueItemCount"]):
        raise ValueError("LoCoMo session or dialogue-item count differs from the full benchmark contract")
    return {
        "conversation_count": len(dataset),
        "total_question_count": total_questions,
        "included_question_count": total_questions - category_counts.get("5", 0),
        "excluded_category_5_count": category_counts.get("5", 0),
        "category_counts_included": actual_included,
        "session_count": session_count,
        "dialogue_item_count": dialogue_item_count,
    }


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
    path = manifest_path or STATE_MANIFEST
    if not path.is_file():
        raise FileNotFoundError(f"frozen memory state manifest not found: {path}")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    conversation_ids = manifest.get("included_conversations")
    if not isinstance(conversation_ids, list) or not all(isinstance(value, str) for value in conversation_ids):
        raise ValueError("frozen memory state manifest has no valid included_conversations scope")
    materialized = list(dataset)
    question_rows = included_questions(materialized)
    if _CONTRACT.get("requiredStoreScope") == "full":
        expected_conversations = [conversation_id(row, index) for index, row in enumerate(materialized)]
        if conversation_ids != expected_conversations:
            raise ValueError("full LoCoMo store conversations differ from the exact dataset order")
        selected = filter_questions_to_conversations(question_rows, conversation_ids)
        if len(selected) != int(_CONTRACT["dataset"]["includedQuestionCount"]):
            raise ValueError("full LoCoMo store does not select exactly the 1540 scored questions")
        return selected
    return filter_questions_to_conversations(question_rows, conversation_ids)


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


def citation_ref_validity(
    raw_answer: str,
    items: Iterable[dict[str, Any]],
    parse_error: str | None,
) -> dict[str, Any]:
    provided_values = set()
    for item in items:
        if not isinstance(item, dict) and hasattr(item, "model_dump"):
            item = item.model_dump(exclude_none=True)
        if isinstance(item, dict) and isinstance(item.get("sourceId"), str) and item.get("sourceId"):
            provided_values.add(str(item["sourceId"]))
    provided = sorted(provided_values)
    referenced: list[str] = []
    if parse_error is None:
        try:
            payload = json.loads(raw_answer)
        except (TypeError, json.JSONDecodeError):
            payload = None
        evidence = payload.get("evidence") if isinstance(payload, dict) else None
        if isinstance(evidence, list):
            referenced = [value.strip() for value in evidence if isinstance(value, str) and value.strip()]
        elif isinstance(evidence, str) and evidence.strip():
            referenced = [evidence.strip()]
    provided_set = set(provided)
    valid = [value for value in referenced if value in provided_set]
    invalid = [value for value in referenced if value not in provided_set]
    return {
        "provided_ref_count": len(provided),
        "reference_count": len(referenced),
        "valid_reference_count": len(valid),
        "invalid_reference_count": len(invalid),
        "referenced_ids": referenced,
        "invalid_ids": invalid,
        "validity_rate": (len(valid) / len(referenced)) if referenced else None,
        "has_invalid_reference": bool(invalid),
    }


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
        raise ValueError(f"{_CONTRACT.get('task', 'LoCoMo')} requires served model {expected_model}")
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
    verify_local_model_revisions(contract)
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
    expected_root = str(Path(contract["models"]["qaGenerator"]["localPath"]).expanduser().resolve())
    actual_root = matching[0].get("root")
    if actual_root and str(Path(actual_root).expanduser().resolve()) != expected_root:
        raise ValueError("local model endpoint root differs from the frozen Qwen model path")
    version_url = parsed._replace(path="/version", params="", query="", fragment="").geturl()
    _require_loopback_http(version_url, "local model version URL")
    with urlopen(version_url, timeout=5) as response:
        version_payload = json.loads(response.read())
    expected_version = contract["inferenceEngine"]["version"]
    if not isinstance(version_payload, dict) or version_payload.get("version") != expected_version:
        raise ValueError("local vLLM endpoint version differs from the frozen benchmark contract")


def verify_local_model_revisions(contract: dict[str, Any] | None = None) -> None:
    contract = contract or _CONTRACT
    model_specs = (
        contract["models"]["qaGenerator"],
        contract["models"]["embedding"],
    )
    for model in model_specs:
        model_path = Path(model["localPath"]).expanduser().resolve()
        metadata_path = model_path / ".hfd" / "repo_metadata.json"
        if not metadata_path.is_file():
            raise FileNotFoundError(f"local model revision metadata is missing: {model_path}")
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        expected_id = model["id"]
        actual_id = metadata.get("id") or metadata.get("modelId")
        expected_revision = model["sourceRevision"]
        if actual_id != expected_id and not str(actual_id).endswith(f"/{expected_id}"):
            raise ValueError(f"local model metadata identity does not match the frozen contract: {expected_id}")
        if metadata.get("sha") != expected_revision:
            raise ValueError(f"local model revision differs from the frozen contract: {expected_id}")
    embedding_path = Path(contract["models"]["embedding"]["localPath"]).expanduser().resolve()
    embedding_config = json.loads((embedding_path / "config.json").read_text(encoding="utf-8"))
    if int(embedding_config.get("hidden_size", -1)) != int(contract["models"]["embedding"]["nativeOutputDimension"]):
        raise ValueError("local embedding model dimension differs from the frozen contract")


def verify_embedding_endpoint() -> dict[str, Any]:
    """Probe the configured local embedder and verify AMA's padded vector width."""
    from urllib.request import Request, urlopen

    contract = json.loads(CONTRACT_MANIFEST.read_text(encoding="utf-8"))
    endpoint = os.environ.get("AMA_EMBEDDING_URL")
    if not endpoint:
        raise ValueError("AMA_EMBEDDING_URL is not configured")
    _require_loopback_http(endpoint, "AMA_EMBEDDING_URL")
    model = contract["models"]["embedding"]["id"]
    payload = json.dumps({"model": model, "input": "HC-MEM-003 local embedding contract probe"}).encode("utf-8")
    request = Request(
        endpoint,
        data=payload,
        headers={"Authorization": "Bearer local-only", "Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        result = json.loads(response.read())
    if result.get("model") != model:
        raise ValueError("local embedding endpoint model does not match the frozen contract")
    data = result.get("data")
    vector = data[0].get("embedding") if isinstance(data, list) and data and isinstance(data[0], dict) else None
    expected_dimension = int(contract["models"]["embedding"]["amaDimension"])
    if (
        not isinstance(vector, list)
        or len(vector) != expected_dimension
        or any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in vector)
    ):
        raise ValueError("local embedding endpoint vector does not match the pinned AMA dimension/finite-value contract")
    return {
        "model": model,
        "revision": contract["models"]["embedding"]["sourceRevision"],
        "native_dimension": int(contract["models"]["embedding"]["nativeOutputDimension"]),
        "ama_dimension": expected_dimension,
    }


def _require_loopback_http(url: str, name: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError(f"{name} must use a loopback HTTP endpoint")


def require_loopback_http(url: str, name: str) -> None:
    _require_loopback_http(url, name)


def verify_state_copy(data_dir: Path) -> None:
    manifest_path = STATE_MANIFEST
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
    required_scope = contract.get("requiredStoreScope")
    if required_scope == "full":
        expected_conversations = contract["dataset"]["conversationCount"]
        if manifest.get("partial") is not False or manifest.get("max_sessions") is not None:
            raise ValueError("full LoCoMo evaluation requires a finalized non-partial memory store")
        if len(manifest.get("included_conversations", [])) != expected_conversations:
            raise ValueError("full LoCoMo memory store does not cover every conversation")
        if manifest.get("conversation_count") != expected_conversations:
            raise ValueError("full LoCoMo store manifest has a mismatched conversation count")
        if manifest.get("session_count") != contract["dataset"]["sessionCount"]:
            raise ValueError("full LoCoMo store manifest has a mismatched session count")
        if manifest.get("dialogue_items") != contract["dataset"]["dialogueItemCount"]:
            raise ValueError("full LoCoMo store manifest has a mismatched dialogue-item count")
        if len(manifest.get("selected_session_keys", [])) != contract["dataset"]["sessionCount"]:
            raise ValueError("full LoCoMo store manifest does not list every selected session")
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
    if required_scope == "full":
        verify_full_arm_state_set(data_dir, manifest)


def state_file_manifest(directory: Path) -> list[dict[str, Any]]:
    if not directory.is_dir():
        raise FileNotFoundError(f"arm memory state directory is missing: {directory}")
    return [
        {
            "path": path.relative_to(directory).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
        }
        for path in sorted(directory.rglob("*"))
        if path.is_file()
    ]


def verify_full_arm_state_set(data_dir: Path, manifest: dict[str, Any]) -> None:
    if not STATE_COPIES_MANIFEST.is_file():
        raise FileNotFoundError(f"full-store arm copy manifest is missing: {STATE_COPIES_MANIFEST}")
    copies = json.loads(STATE_COPIES_MANIFEST.read_text(encoding="utf-8"))
    if copies.get("source_manifest_sha256") != sha256_file(STATE_MANIFEST):
        raise ValueError("arm copy manifest points to a different full-store manifest")
    arm_names = {
        "A_UPSTREAM": "arm-a-upstream",
        "B_SIDECAR": "arm-b-sidecar",
        "C_DSH": "arm-c-dsh",
    }
    recorded_arms = copies.get("arms")
    if not isinstance(recorded_arms, dict) or set(recorded_arms) != set(arm_names):
        raise ValueError("full-store copy manifest does not include exactly A/B/C state copies")
    expected_files = sorted(
        [
            {"path": entry["path"], "bytes": int(entry["bytes"]), "sha256": entry["sha256"]}
            for entry in manifest["files"]
        ],
        key=lambda item: item["path"],
    )
    tree_hashes: set[str] = set()
    valid_dirs: set[Path] = set()
    for arm, directory_name in arm_names.items():
        arm_dir = ARTIFACT_ROOT / directory_name / "state"
        actual_files = state_file_manifest(arm_dir)
        recorded = recorded_arms[arm]
        if recorded.get("relative_state_dir") != f"{directory_name}/state":
            raise ValueError(f"state copy manifest points {arm} at an unexpected directory")
        if recorded.get("files") != expected_files or actual_files != expected_files:
            raise ValueError(f"{arm} frozen state differs from the common full store")
        tree_hash = digest_text(json.dumps(actual_files, sort_keys=True, separators=(",", ":")))
        if recorded.get("tree_sha256") != tree_hash:
            raise ValueError(f"{arm} frozen state tree hash differs from its manifest")
        tree_hashes.add(tree_hash)
        valid_dirs.add(arm_dir.resolve())
    if len(tree_hashes) != 1:
        raise ValueError("A/B/C frozen memory stores are not byte-identical")
    if data_dir.expanduser().resolve() not in valid_dirs:
        raise ValueError("runner state directory is outside the three verified full-store arm copies")


def add_snapshot_metrics(row: dict[str, Any], items: list[dict[str, Any]]) -> None:
    snapshot_hash, item_hashes = canonical_items(items)
    row["retrieval_hash"] = snapshot_hash
    row["retrieved_items"] = item_hashes
    row["retrieved_count"] = len(item_hashes)
    row["retrieved_kinds"] = {
        kind: sum(1 for item in item_hashes if item["kind"] == kind)
        for kind in ("raw", "fact", "episode")
    }
