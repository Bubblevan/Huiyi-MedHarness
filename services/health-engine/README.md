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
