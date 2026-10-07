# Repository guardrails

This repository is an out-of-tree Huiyi product bundle for the pinned DeepSeek Harness (DSH) runtime. It preserves the deterministic F0 synthetic-evidence tool and adds only product capabilities explicitly accepted for the current task.

## Required invariants

1. Read the pinned DSH documentation and source before changing an integration boundary; record inspected sources and exact lifecycle seams in the ADR/docs.
2. DSH owns Agent, Session, AgentLoop, tool dispatch, result admission, cancellation, and durable session events. Reuse these APIs.
3. Do not vendor or modify the DSH checkout. Huiyi remains an out-of-tree DSH bundle.
4. Keep the F0 synthetic evidence fixture deterministic and clearly marked as test data. Patient memory is a separate capability; do not merge it with external medical evidence.
5. Add dependencies and directories only when a concrete product capability or verification command requires them.
6. Each capability must have an observable acceptance criterion and an offline verification path where possible.
7. Keep research reproductions separate from product integration. Do not imply fixture results or memory context are clinical advice or verified medical evidence.
8. Do not claim a command, integration, or runtime path works without recording actual verification evidence.
9. Use explicit file paths when staging; never use `git add .`. Do not print or stage `.env` credentials.
10. Run the requested unit tests, typecheck, bundle build, and local-Qwen DSH acceptance. Report exact outcomes and blockers.

## HC-MEM-001 boundary

1. DSH remains the only outer Agent/Session/AgentLoop runtime.
2. AMA Retriever, Judge, Refresher, and Constructor are internal memory algorithm roles, not DSH subagents.
3. Memory belongs to a trusted patient/user identity and DSH session context, not to an individual agent.
4. Automatic recall runs at most once per root user turn. Reuse one immutable `MemorySnapshot` across all model steps and future clinical workers.
5. Persist memory only after the root DSH turn settles successfully with a final answer. Do not capture errors, cancellations, or partial output.
6. Future clinical workers may read a shared `MemorySnapshot` but may not independently recall, refresh, construct, or write AMA memory.
7. Patient memory is contextual history, never external medical evidence. Keep it separate from future RAG `externalEvidence`.
8. Do not modify pinned upstream AMA code when the health-engine adapter can provide the integration. Preserve its license and record the exact commit.
9. Do not add an OpenAI SDK or hosted OpenAI API dependency. AMA model calls must use a configured local/self-hosted route.
10. Memory failures are fail-open for the clinical turn and visible through metadata-only memory tracing.
11. Destructive forget requires a native DSH approval decision; do not invent a parallel approval system.
12. The HC-MEM-001 task scope does not include MDAgents, RAG/MA-RAG, safety hardening, hospital EMR integration, or post-training. A separately authorized task has its own boundary.
13. Every claim that DSH + local Qwen memory works requires an actual local-Qwen DSH live trace. Unit tests alone are not acceptance.

## Data and stop point

- Keep AMA SQLite/FAISS data, credentials, user/assistant text, and retrieved memory out of Git and generic telemetry.
- Check actual GPU, process, cgroup, disk, and inode state before starting a model service. A sandbox unable to query NVML or host loopback cannot establish that a GPU is idle.
- Stop after the currently authorized product task. HC-RAG-001 is the active RAG scope; stop after its acceptance and do not start HC-RAG-002 without a separate request.

## HC-RAG-001 medical evidence boundary

1. DSH owns Agent, Session, AgentLoop, tool dispatch, result admission, cancellation, durable events, and the final user-facing answer.
2. Python RAG owns external evidence acquisition and may use a bounded internal LLM-assisted query planner; it may not become a second user-turn runtime or produce the final answer.
3. `search_medical_evidence` remains the single coarse DSH capability. Do not expose embedding, FAISS, corpus, or query-planning internals as model-facing tools.
4. Corpus downloads, normalization, embedding, and index builds are explicit offline preparation. A live request must never trigger them.
5. External medical evidence and patient Memory remain separate contracts and fields. A patient memory item is not a citation; a retrieved source passage is not proof of patient history.
6. LLM-generated RAG queries/observations are not source evidence. Only retrieved source snippets with retained provenance can receive citation evidence IDs.
7. Keep prepared corpora, FAISS indices, embeddings, and model weights out of Git. Commit manifests, checksums, configurations, scripts, and small deterministic fixtures.
8. Do not introduce a hosted OpenAI API dependency. Local/self-hosted model routes, model IDs, context windows, and credential placeholders belong to profile/deployment configuration, not Huiyi domain code.
9. Do not begin hybrid retrieval, reranking, citation verification, MDAgents/MA-RAG, or post-training as part of HC-RAG-001.
10. HC-RAG-001 completion requires a real DSH Session + local-Qwen AgentLoop + prepared local-corpus tool call + same-loop final response trace. Direct `ctx.tools.execute()` or service calls alone do not satisfy acceptance.
