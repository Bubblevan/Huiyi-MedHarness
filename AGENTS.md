# Repository guardrails

This repository is an out-of-tree Huiyi product bundle for the pinned DeepSeek Harness (DSH) runtime. The accepted baseline is `621caf9aa2aa74db02c49a12015d0e821c2af779`.

## Required invariants

1. Read pinned upstream source before changing an integration boundary; record inspected files, exact commits, and lifecycle seams in the ADR and docs.
2. DSH remains the only outer Agent, Session, AgentLoop, tool-dispatch, cancellation, and durable event runtime.
3. Do not vendor or modify the DSH checkout.
4. Preserve the deterministic F0 synthetic-evidence fixture and keep patient memory separate from any future external medical evidence.
5. Add dependencies and directories only for a concrete accepted capability.
6. Keep research reproductions separate from product integration. Patient memory is prior user context, not clinical advice or verified medical evidence.
7. Record actual verification evidence; do not claim an unrun command or runtime path works.
8. Stage explicit paths only. Never use `git add .`; never print, stage, or commit `.env` credentials.

## HC-MEM-001 boundary

1. DSH owns the outer Agent, Session, AgentLoop, tool dispatch, turn settlement, and user-facing response.
2. AMA Retriever, Judge, Refresher, and Constructor are internal memory algorithm roles, never DSH subagents.
3. Python `health-engine` owns AMA execution and persistence; TypeScript owns DSH lifecycle integration, prompt rendering, selected tools, and metadata-only memory traces.
4. Resolve patient identity from a trusted host boundary. Memory belongs to the patient/user plus case/session context, never to an individual agent.
5. Run automatic recall at most once per root user turn. Reuse the same immutable `MemorySnapshot` across all model steps and any future clinical workers.
6. Commit the final user/assistant pair once, only after the completed root DSH turn settles. Do not persist error, cancelled, interrupted, or partial turns.
7. Future clinical workers may read the shared snapshot but may not independently recall, refresh, construct, or write AMA memory.
8. Patient memory is historical context, never external medical evidence. Keep it separate from any future RAG `externalEvidence`.
9. Do not modify the pinned AMA snapshot when the adapter can provide the integration. Preserve its license and exact upstream commit.
10. Do not add a hosted OpenAI API dependency. AMA model calls must use an explicitly configured local/self-hosted route.
11. Memory recall and commit failures must not make an otherwise valid clinical turn fail; record sanitized metadata and never invent remembered content.
12. Forget is destructive and must use the pinned DSH approval seam; do not invent a parallel approval system.
13. Do not begin MDAgents, RAG integration, safety hardening, EMR integration, or post-training under HC-MEM-001.
14. Every completion claim requires an actual DSH Session + local-Qwen live trace, in addition to unit tests and typecheck/build.

## Privacy and stop point

- Keep AMA SQLite/FAISS data, raw user/assistant text, retrieved memory content, and vectors out of Git and generic telemetry.
- Check GPU, process ownership, cgroup memory, disk capacity, and inode state before starting local model services. Never stop or reconfigure another process to make room.
- Stop after HC-MEM-001 acceptance. Start another product module only under a separate task.
