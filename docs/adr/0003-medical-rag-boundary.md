# ADR 0003: Medical evidence acquisition boundary

- Status: Accepted for HC-RAG-001
- Date: 2026-10-07
- Huiyi base: `621caf9aa2aa74db02c49a12015d0e821c2af779`; current checkout also contains uncommitted HC-MEM-001 work, which this ADR preserves and composes with.
- DSH: `deepseek-ai/deepseek-harness` at `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, runtime `0.2.1-alpha.1`.
- MedRAG: `Teddy-XiongGZ/MedRAG` at `7599a728a28789fd601728c08d313b1148051f41`.
- Health-Copilot engineering reference: current checkout at `f735285b2cda4e1bf5fd5a91f961a1510cdc0c77`; its M5 retrieval checkpoint is documented as `main@a69801bde6826daaf02aa933c2cdf2a05697d42a`.
- Completed local smoke reference: `/root/gpufree-data/repro/imedrag-small-20261007/trace/session-metadata.json` (external to this repository; metadata-only).

## Context

Huiyi has a real DSH AgentLoop and local-Qwen route, a native `search_medical_evidence` tool, and an uncommitted HC-MEM-001 health-engine scaffold. The completed i-MedRAG smoke used a deliberately small MedText sample and established that the pinned upstream path can perform local-Qwen-assisted follow-up retrieval. It did not run a MedQA split or establish a benchmark accuracy result. Dataset repository revisions were not recorded by that wrapper; local source/index artifacts must be identified by file hashes rather than an invented dataset pin.

The health-engine is already the shared Python data plane. RAG is a sibling of its Memory module, not another service or process. Its host app and dependencies must be extended without replacing the Memory router or its local-only configuration.

## Decisions

1. **DSH remains the only outer AgentLoop.** DSH owns user turns, sessions, tool dispatch, result admission, cancellation, durable events, continuation, and the final user-facing response. Huiyi registers `search_medical_evidence` through native `ctx.tools`; it does not introduce a second session, model dispatcher, agent loop, or user-turn runtime.
2. **Python RAG acquires evidence, not answers.** The shared `services/health-engine` owns query planning, bounded iterative retrieval, aggregation, provenance, and optional retrieval-side distillation. It returns a canonical `EvidenceSet` and has no `finalAnswer`, diagnosis, or user-response field.
3. **One coarse DSH capability remains.** `search_medical_evidence` accepts a medical query and a small product-level choice such as mode/topK. It does not expose embedding, FAISS, corpus, planner-round, or retriever-internal operations as DSH tools.
4. **i-MedRAG follow-up becomes a bounded search policy.** Huiyi adapts follow-up query generation and evidence accumulation, not the complete `i_medrag_answer()` answer loop. Planner responses are structured and validated. A planner failure may degrade to single retrieval only if the behavior is explicit and covered by tests.
5. **Source evidence and generated observations are distinct.** Retrieved snippets retain corpus, source/document/chunk identity, score semantics, retrieval query, and round. Request-local evidence IDs refer only to retrieved source records. LLM-generated query plans or observations are never labeled as citations or source evidence.
6. **Corpus and index preparation is offline and versioned.** The running service loads only assets named by an explicit manifest, fails clearly on missing/mismatched assets, and never downloads corpora or builds indices in response to a user request. Large corpus, model, embedding, and FAISS files stay outside Git.
7. **External evidence and patient Memory remain separate.** The existing health-engine Memory router and `MemorySnapshot` remain intact. `patientMemory` is user-provided history; `externalEvidence` is retrieved medical literature. Neither is converted into the other.
8. **Future MDAgents workers share evidence by default.** A future team receives one immutable `EvidenceSet` per case. Specialist workers do not launch nested i-MedRAG loops.
9. **Future disagreement-triggered retrieval stays centralized.** Reuse an existing unresolved concept and ask the same RAG service for one bounded evidence refinement; do not create a nested MA-RAG or candidate swarm.
10. **Post-trained models use the same contract.** The evidence request and response do not depend on Qwen or a Clinical-R1 checkpoint. A later generator checkpoint consumes the same DSH tool and `EvidenceSet` contract.

## Pinned DSH integration seams inspected

The source was read at the pinned commit through the immutable upstream files below (the checkout remains outside Huiyi and unmodified):

- `packages/llm/llm-pi-ai/README.md` and `src/config.ts`: custom self-hosted routes declare protocol, base URL, model catalog, context window, and `apiKeyEnv`; the OpenAI-compatible pi-ai route needs a non-empty key or Authorization header even if a local server is keyless.
- `packages/core/agent-loop/README.md`: the built-in loop performs model request → tool execution → durable result → next model step. It explicitly recommends the standard AgentLoop for the normal “call model, run tools, repeat” lifecycle.
- `packages/core/agent-loop/src/agent.ts`: a completed model message with tool-call blocks is appended to the Session; the loop calls native tool execution and continues when the calls do not conclude the turn. A response without tool calls completes the turn.
- `packages/core/agent-loop/src/tool-calls.ts`: DSH records `tool/call`, prepares and dispatches through `ctx.tools`' ToolRuntime scheduler, finalizes the result, and appends `tool/result`; the same active AbortSignal is included in the tool execution context.
- `packages/core/tools/src/index.ts`: `ToolRunContext` carries the execution signal; the existing plugin contract is `ctx.tools.register(defineTool(...))` with a canonical schema and model-visible renderer.
- `packages/core/session/src/types.ts`, `docs/agent-lifecycle.md`, `docs/architecture.md`, `docs/user/develop/framework/events.md`, and `docs/subsystems/system-prompt.md`: Session events and turn lifecycle remain DSH-owned; RAG does not write user/assistant messages or create sessions.

The previous F0 boundary audit is in [ADR 0001](0001-dsh-runtime-boundary.md); HC-MEM-001's prompt/lifecycle seams are in [ADR 0002](0002-ama-memory-boundary.md) and [the memory lifecycle map](../memory/lifecycle.md). The i-MedRAG reproduction and ownership map is in [imedrag-upstream-map.md](../rag/imedrag-upstream-map.md).

Pinned source links:

- <https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/llm-pi-ai/README.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/llm-pi-ai/src/config.ts>
- <https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/README.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/src/agent.ts>
- <https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/src/tool-calls.ts>
- <https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/tools/src/index.ts>
- <https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/session/src/types.ts>

## Consequences

- `EvidenceSet` remains an evidence contract, not an agent transcript. It preserves the F0 `query` and `hits` concepts while adding mode, retrieval metrics, corpus version, and source provenance.
- The health-engine is the only Python process boundary. Its existing Memory routes continue to use their own schemas and service; RAG routes are separately namespaced under `/v1/rag`.
- A real local corpus/index smoke and a real DSH local-Qwen turn are required for HC-RAG-001 completion. Synthetic fixture tests and direct service/tool calls alone do not satisfy acceptance.
- Product integration metrics must not be compared as if they were the completed research reproduction's benchmark result.
- HC-RAG-001 does not start hybrid retrieval, reranking, citation verification, MDAgents, or post-training.
