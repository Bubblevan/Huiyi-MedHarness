# ADR 0002: AMA memory boundary

- Status: Accepted for HC-MEM-001
- Date: 2026-10-07
- Supersedes no part of ADR 0001; it adds a memory capability beside the existing F0 evidence fixture.

## Context

Huiyi's accepted baseline is `621caf9aa2aa74db02c49a12015d0e821c2af779`. The runtime boundary is DeepSeek Harness (DSH) `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, runtime `0.2.1-alpha.1`. AMA is pinned at `a770f9aaef527ae589bf13015260cd24eda2d58c`.

Pinned DSH source was inspected at `docs/agent-lifecycle.md`, `docs/architecture.md`, `docs/user/develop/framework/events.md`, `docs/subsystems/system-prompt.md`, and the source under `packages/core/system-prompt/`, `packages/core/agent-loop/`, `packages/core/agent/`, and `packages/core/session/`. Pinned AMA source was inspected at `docs/architecture.md`, `SKILL.md`, `backend/base.ts`, `backend/sidecar.ts`, `capture.ts`, `python/server.py`, and `python/AdaptiveMemory/Core/AMA.py`, plus its model and FAISS adapters. The exact seam and mapping are in [ama-upstream-map.md](../memory/ama-upstream-map.md) and [lifecycle.md](../memory/lifecycle.md).

## Decisions

1. DSH remains the only outer Agent, Session, AgentLoop, tool-dispatch, cancellation, and durable event runtime.
2. AMA owns the Retriever, Judge, Refresher, Constructor, and Raw/Fact/Episode memory lifecycle. These are internal AMA roles, never DSH subagents.
3. The Python `health-engine` owns AMA execution, SQLite/FAISS persistence, commit idempotency, and result normalization. TypeScript owns DSH turn integration, prompt rendering, tools, and metadata-only memory traces.
4. Automatic recall runs once per root user turn. The DSH `agent/inbox/claimed` event supplies the query before `system-prompt/assemble`; the DSH `system-prompt/assemble` waterfall awaits recall and contributes the rendered patient-memory context through assembled `contexts`. Pinned `agent-loop` converts those contexts into messages alongside the claimed input. A session+turn cache reuses the same immutable `MemorySnapshot` on later model steps.
5. Memory writes run only for `turn/end` with reason `completed`, after the final non-empty root response is available. Error, aborted, interrupted, and max-token turns are not committed. The key is derived from DSH session ID and turn; the service records at-most-once outcomes.
6. Future clinical workers receive the same turn-scoped `MemorySnapshot` read-only. Only the settled root DSH turn can commit it. RAG evidence remains a separate future type and is never merged with patient memory.
7. A memory failure is observable in a `MemoryTraceRecord` and does not fail an otherwise completed clinical turn. Trace records contain metadata only. DSH still logs model-visible system prompt content as required by its session-surface contract.
8. AMA model calls use a configured loopback OpenAI-compatible endpoint for the local Qwen route. Embeddings use the local Qwen3-Embedding model. No hosted OpenAI API or SDK is introduced.
9. The pinned upstream Python source is preserved under `third_party/AMA/`; adaptations stay in the health-engine adapter. The source snapshot carries the upstream Apache-2.0 license and exact commit.
10. DSH has no generic terminal `session/end` event in this pinned lifecycle. Episode synthesis is exposed through the health-engine `session-end` endpoint for an explicit host action; `agent/disposed` alone is not treated as user intent to end a conversation.

## Consequences

- The root turn pays the AMA recall cost once; later model steps reuse the cached result.
- DSH remains able to answer if health-engine recall or commit is unavailable.
- The health-engine data directory contains patient memory and must remain local and ignored by Git.
- A deployment must resolve a trusted stable user identity. The development headless profile uses `HUIYI_MEMORY_USER_ID`; a multi-user host supplies the resolver through `applyWithIdentity(ctx, resolver)`.
- Local AMA's pinned 3,072-dimensional FAISS interface is retained. The health-engine may zero-pad local 1,024-dimensional embeddings to 3,072, preserving cosine similarity while leaving upstream source unchanged.
- This ADR does not start RAG integration, MDAgents, safety hardening, or model training.
