# Huiyi health-engine

This local Python data plane adapts the pinned AMA snapshot. DSH remains the only Agent, Session, and AgentLoop runtime. Memory data is written below `data/` by default and is ignored by Git.

## Run with the existing local Python environment

The Health-Copilot venv is reused for vLLM. The existing Python 3.12 environment in the AMA checkout provides FAISS and the health-engine dependencies without modifying Health-Copilot:

```bash
ENGINE_PYTHON=/root/gpufree-data/AMA/.venv/bin/python
export PYTHONPATH="$PWD/services/health-engine/src"
export HUIYI_HEALTH_ENGINE_HOST=127.0.0.1
export HUIYI_HEALTH_ENGINE_PORT=8322
export HUIYI_LOCAL_LLM_BASE_URL=http://127.0.0.1:8001/v1/chat/completions
export HUIYI_LOCAL_LLM_MODEL=Qwen/Qwen3-8B
export HUIYI_LOCAL_EMBEDDING_PATH=/root/gpufree-share/models/Qwen3-Embedding-0.6B
export HUIYI_MEMORY_DATA_DIR="$PWD/services/health-engine/data"
"$ENGINE_PYTHON" -m uvicorn huiyi_health_engine.app:app --host 127.0.0.1 --port 8322 --no-access-log
```

The inference URL must be a loopback OpenAI-compatible endpoint. AMA receives only a non-secret local placeholder authorization value. The local embedding model runs on CPU and its 1,024-dimensional output is padded to the pinned AMA 3,072-dimensional index width.

The runtime requires FastAPI, Uvicorn, Pydantic v2, Requests, NumPy, `faiss-cpu`, `tiktoken`, and `sentence-transformers`. Do not run `uv sync` against the Health-Copilot venv because it also contains vLLM.

## Product endpoints

- `GET /health`
- `POST /v1/memory/recall`
- `POST /v1/memory/commit-turn`
- `POST /v1/memory/session-end`
- `GET /v1/memory/stats/{user_id}`
- `POST /v1/memory/forget`

AMA internal model/embedding calls and SQLite/FAISS access stay behind the Python adapter. The internal embedding endpoint is not part of the product API. The pinned DSH release has no generic user-intent session-end event, so only a trusted host may call `session-end`.

`commit-turn` writes a completed root DSH user/assistant pair through AMA's upstream `forwardUser()` and `forwardRobot()` lifecycle. The pinned `forwardRobot()` currently raises `NameError` after writing its assistant row because of an undefined return variable; the adapter tolerates that exact post-write case only when it observes that row.
