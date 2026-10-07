# AMA upstream map

## Pin and inspected sources

- Repository: `Sherlockwz/AMA`
- Commit: `a770f9aaef527ae589bf13015260cd24eda2d58c`
- License: Apache-2.0, retained in `third_party/AMA/LICENSE`.
- Huiyi consumes an exact source export under `third_party/AMA/python/AdaptiveMemory/`; no edits are made in that snapshot.

Inspected upstream files at the pinned commit:

- `docs/architecture.md` — Harness integration overview: pre-prompt recall, end-of-agent capture, selected explicit tools, and localhost Python sidecar.
- `SKILL.md` and `skills/ama-memory/SKILL.md` — automatic recall preference, manual recall only when needed, lifecycle-owned capture, explicit session-end synthesis, explicit-intent forget, and no fabrication on failure.
- `backend/base.ts` — upstream backend contract.
- `backend/sidecar.ts` — localhost HTTP transport and timeout/error mapping.
- `capture.ts` — the `agent_end` hook captures user input then assistant output.
- `python/server.py` — upstream Python API and per-user `AMA` instance ownership.
- `python/AdaptiveMemory/Core/AMA.py` — `forwardRetrieve`, `forwardUser`, `forwardRobot`, `judgeAndGenerate`, and `clearAllMemory` lifecycle.
- Supporting inspected source: `python/AdaptiveMemory/Model/model.py`, `Settings/config.py`, `StoreFunc/Faiss/embedding.py`, `StoreFunc/Faiss/faissFunc.py`, and `StoreFunc/SQLite/sqliteFunc.py`.

## Ownership map

| AMA concept | Huiyi implementation |
| --- | --- |
| Retriever / Judge | `health-engine/.../memory/ama_backend.py`; called by `forwardRetrieve` |
| Refresher | Same AMA backend call path; no DSH agent or workflow |
| Constructor | `forwardUser` then `forwardRobot` after completed root turn |
| Raw / Fact / Episode persistence | Pinned AMA Python source and its SQLite/FAISS data directory |
| Upstream `before_prompt_build` | DSH `system-prompt/assemble` waterfall, after `agent/inbox/claimed` provides the root query |
| Upstream `agent_end` capture | DSH `session/event` on `turn/end`; completed turns only |
| Explicit tools | Selected `ctx.tools` contracts in `src/memory/tools.ts` |
| Upstream sidecar | Huiyi `services/health-engine` product API; only `ama_backend.py` imports AMA internals |
| OpenClaw agent, session, loop, plugin manager, and hook semantics | Intentionally not copied; DSH owns these boundaries |

## Health-Copilot reference audit

The existing archive was inspected at `Health-Copilot/AGENTS.md` and `src/health_ai_copilot/runtime/{trace.py,budget.py,components.py}`. Huiyi reuses the ideas of typed metadata-only traces, explicit bounded calls, and clear provider/component identity. It does not port Health-Copilot's AgentLoop, Session, orchestration, or runtime abstraction. The Health-Copilot runtime remains a reference archive, not Huiyi's execution substrate.

The local deployment guardrails in `Health-Copilot/AGENTS.md` also note that sandboxed processes may be unable to query NVML or reach host loopback even when host GPU/model services exist. Huiyi does not stop/reconfigure port 8000 and only starts an additional vLLM route after a fresh host-side GPU/resource check.

## Local model and embedding adaptation

The pinned upstream model client uses HTTP requests and configurable `AMA_LLM_BASE_URL`; it does not require the OpenAI SDK. Huiyi configures that URL to the local Qwen OpenAI-compatible chat-completions endpoint and supplies only a non-secret local placeholder authorization value. The endpoint and model ID are deployment settings, not constants inside AMA domain code.

The pinned FAISS code expects 3,072-dimensional vectors. The local Qwen3-Embedding-0.6B encoder produces 1,024 dimensions. The health-engine's internal local embedding endpoint pads each vector with zeros to 3,072; the same transform is applied to query and document vectors, so cosine similarity is preserved. The upstream snapshot and its prompts remain unchanged. Huiyi reports `retrievalRounds` by counting upstream high-level `AMA.retrieve()` calls because `forwardRetrieve()` does not expose its own counter; `tokenEstimate` is a documented UTF-8 approximation, not a Qwen tokenizer count.
