# Huiyi health-engine

This local Python data plane adapts the pinned AMA snapshot. DSH remains the only Agent, Session, and AgentLoop runtime. Runtime memory data is written below `data/` by default and is ignored by Git.

## Run with the local uv Python environment

The Health-Copilot training environment remains available for local vLLM, but it does not contain `faiss-cpu`. The existing Python 3.12 environment on this machine already has the health-engine runtime dependencies, including FAISS, so it can run the service without changing or syncing the shared Health-Copilot environment:

```bash
ENGINE_PYTHON=/root/gpufree-data/AMA/.venv/bin/python
export PYTHONPATH="$PWD/services/health-engine/src"
export HUIYI_HEALTH_ENGINE_HOST=127.0.0.1
export HUIYI_HEALTH_ENGINE_PORT=8322
export HUIYI_LOCAL_LLM_BASE_URL=http://127.0.0.1:8000/v1/chat/completions
export HUIYI_LOCAL_LLM_MODEL=Qwen/Qwen3-8B
export HUIYI_LOCAL_EMBEDDING_PATH=/root/gpufree-share/models/Qwen3-Embedding-0.6B
export HUIYI_MEMORY_DATA_DIR="$PWD/services/health-engine/data"
"$ENGINE_PYTHON" -m uvicorn huiyi_health_engine.app:app --host 127.0.0.1 --port 8322 --no-access-log
```

The inference URL must be a loopback OpenAI-compatible chat-completions endpoint. Do not put API credentials in these variables. AMA is configured with a local-only placeholder key; the internal embedding route also binds through the loopback-only health-engine. Qwen3-Embedding runs on CPU and is padded from its configured output width to AMA's pinned 3,072 index dimensions.

## Windows local RAG workstation

The Windows workstation keeps model weights under `E:\Health-Copilot-Models\models` and keeps only derived corpus/index data under the Git-ignored `services/health-engine/data/local-rag`. The MedCPT Query and Article Encoder directories are already placed at:

- `E:\Health-Copilot-Models\models\MedCPT-Query-Encoder`
- `E:\Health-Copilot-Models\models\MedCPT-Article-Encoder`

After the offline FAISS manifest exists, run Health Engine from the isolated project venv in a PowerShell window at the repository root:

```powershell
$env:PYTHONPATH = "$PWD\services\health-engine\src"
$env:HUIYI_HEALTH_ENGINE_HOST = '127.0.0.1'
$env:HUIYI_HEALTH_ENGINE_PORT = '8322'
$env:HUIYI_MEMORY_DATA_DIR = "$PWD\services\health-engine\data\memory"
$env:HUIYI_LOCAL_LLM_BASE_URL = 'http://127.0.0.1:8000/v1/chat/completions'
$env:HUIYI_LOCAL_LLM_MODEL = 'Qwen/Qwen3-8B'
$env:HUIYI_LOCAL_EMBEDDING_PATH = 'E:\Health-Copilot-Models\models\Qwen3-Embedding-0.6B'
$env:HUIYI_RAG_ENABLED = '1'
$env:HUIYI_RAG_CORPUS_ROOT = "$PWD\services\health-engine\data\local-rag\corpus"
$env:HUIYI_RAG_MANIFEST_PATH = "$PWD\services\health-engine\data\local-rag\corpus-manifest.json"
$env:HUIYI_RAG_QUERY_ENCODER_PATH = 'E:\Health-Copilot-Models\models\MedCPT-Query-Encoder'
$env:HUIYI_RAG_RETRIEVER_DEVICE = 'cuda'
$env:HUIYI_RAG_DEFAULT_MODE = 'single'
$env:HUIYI_RAG_PLANNER_BASE_URL = $env:HUIYI_LOCAL_LLM_BASE_URL
$env:HUIYI_RAG_PLANNER_MODEL = $env:HUIYI_LOCAL_LLM_MODEL
$env:HUIYI_RAG_PLANNER_API_KEY = 'local-only'
services\health-engine\.venv\Scripts\python.exe -m uvicorn huiyi_health_engine.app:app --host 127.0.0.1 --port 8322 --no-access-log
```

The laptop's loopback Qwen endpoint can be the native `llama-server.exe` route documented in the [local demo runbook](../../docs/demo/local-runbook.md); vLLM/WSL is not required. The Article Encoder is used for offline index generation, while Health Engine loads the matching Query Encoder at runtime. Keep original source data, memory, and indexes outside Git. Do not enable the research parity endpoints in a clinical environment.

The idempotency ledger defaults to `health-engine.sqlite3` under `HUIYI_MEMORY_DATA_DIR`. Set `HUIYI_MEMORY_LEDGER_PATH` to place that metadata database separately when the configured data directory is a frozen read-only AMA benchmark store. Its default product behavior is unchanged.

The service runtime must provide FastAPI, Uvicorn, Pydantic v2, Requests, NumPy, `faiss-cpu`, `tiktoken`, and `sentence-transformers`. A sandboxed `uv pip install faiss-cpu` into the Health-Copilot environment was blocked by outbound network policy, so that environment was left unchanged. Do not use `uv sync` on the Health-Copilot environment because it also contains vLLM.

## Product endpoints

- `GET /health`
- `POST /v1/memory/recall`
- `POST /v1/memory/commit-turn`
- `POST /v1/memory/session-end`
- `GET /v1/memory/stats/{user_id}`
- `POST /v1/memory/forget`

AMA internal model/embedding calls and SQLite/FAISS access stay behind the Python adapter. The internal embedding endpoint is not part of the product API schema. The explicit `session-end` endpoint is for a trusted host; DSH has no generic user-intent session-end event in the pinned release.

`commit-turn` persists the completed user/assistant pair through AMA's upstream `forwardUser()` and `forwardRobot()` lifecycle after DSH settles the root turn. In the pinned AMA source, `forwardRobot()` defines and returns its result normally. Any exception from either lifecycle call, including `NameError`, is reported as an upstream failure; a possible partial write does not convert the failure into success.
