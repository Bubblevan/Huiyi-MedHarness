# Memory lifecycle in DSH

This describes the pinned DSH `5badb15009ae1756c3afe0ae0cef1faafc290ccc` source, not an OpenClaw lifecycle port.

## Automatic recall and prompt contribution

The pinned AgentLoop opens `turn/start`, claims the pending message (emitting `agent/inbox/claimed` with the owning `turn`), and then calls `ctx.systemPrompt.assemble(assembleContextFor(agent, signal))`. `AssembleContext` has the current `agent`; `agent/request` runs later and its contract explicitly cannot mutate messages. Huiyi therefore uses the prompt assembly waterfall rather than changing request configuration.

The `agent/inbox/claimed` observer records the first direct user message for the open root turn. The asynchronous `system-prompt/assemble` listener resolves the trusted user identity and awaits one AMA `forwardRetrieve` for the `(sessionId, turn)` key. It adds the resulting snapshot as a `<patient_memory>` dynamic context through the assembled `contexts` field. Pinned `agent-loop` calls `renderContextSections()`, joins the sections, and passes them through `RuntimeContextProjection.project()`. DSH appends one runtime-context user message after the claimed messages, then reuses it on later model steps unless the context changes or compaction removes it. Empty or failed recall adds no context. Repeated prompt assembly returns the same frozen cached snapshot and does not call AMA again.

The rendered text labels each item as prior user/patient context, not authoritative medical literature or external evidence. It omits AMA database/vector IDs, scores, operators, and storage paths. DSH's own session surface necessarily records model-visible prompt content; the separate memory trace remains metadata-only.

## Capture after settlement

Huiyi observes DSH `session/event` records for `turn/start`, `user/message`, `assistant/message`, and `turn/end`. It retains the root turn's direct user text and the last non-empty assistant text in memory only. It commits the pair after `turn/end` only when `reason.kind === 'completed'`.

`error`, `aborted`, `interrupted`, `max-tokens`, and turns without a final text answer are not committed. The event listener starts the commit without throwing into DSH. The TypeScript client and service record a metadata-only outcome; a commit failure does not change the already produced answer. The service ledger makes a `(sessionId, turn)` retry at-most-once, including an uncertain failure after AMA began writing.

## Cancellation, disposal, and session end

Recall observes the assembly's `AbortSignal`; an aborted recall yields no memory and the turn continues. A disposed Agent drops its in-process turn cache. Pending commits are tracked and flushed during plugin-scope disposal.

The pinned DSH source has no generic user-intent `session/end` event. Disposing an Agent is not sufficient evidence that the user ended a conversation, because an Agent can detach and its Session can later resume. Huiyi exposes an explicit health-engine `POST /v1/memory/session-end` operation for a trusted host. It is not called automatically on every Agent disposal.

## Identity and isolation

The health-engine hashes the trusted `userId` into a safe AMA namespace and never uses a model-supplied identity. For the local headless acceptance profile, the deployment sets `HUIYI_MEMORY_USER_ID`; a multi-user host calls exported `applyWithIdentity(ctx, resolver)` to supply a stable authenticated identity per DSH session. Missing identity disables memory and is traced without affecting the answer.

## AMA persistence mapping

After a successful root `turn/end`, the adapter calls upstream `AMA.forwardUser(userText)` and then `AMA.forwardRobot(assistantText)`. This is the upstream user/assistant capture lifecycle, invoked only after the final answer exists. `forwardUser()` performs an internal retrieve/judge pass as part of AMA's persistence algorithm; its LLM calls are included in commit cost metrics, while the one turn-scoped pre-prompt recall is separately traced as `automatic_recall`. The pinned `forwardRobot()` defines and returns its result normally. Any exception, including `NameError`, is reported as an upstream failure; the adapter does not treat a possible partial write as success. No upstream source is modified.

Health-engine SQLite/FAISS state lives in its configured data directory. Python service logs suppress AMA stdout/stderr under a process-wide adapter lock because upstream currently prints retrieved and captured text. The generic memory trace records counts, latency, status, and algorithm counters only.

## Future clinical workers

A future DSH clinical team may read the same immutable `MemorySnapshot` created for the root turn. Workers do not recall, refresh, construct, or write AMA state. The root turn alone commits after its completed final response. `patientMemory` remains separate from any future RAG `externalEvidence` set.

## LoCoMo read-only evaluation profile

HC-MEM-003 keeps the product lifecycle above unchanged. The LoCoMo profile supplies the pinned QANemori instructions through a DSH system-prompt section, then adds the question and recalled `MemorySnapshot` through the DSH dynamic context projection; the question itself remains the normal DSH user message. The profile sets the DSH `AgentOptions.maxTokens=256` and sets `temperature=0` through `agent/request`. The local adapter maps `maxTokens` to the OpenAI-compatible `max_tokens` field and maps a `length` finish to the DSH `max-tokens` turn reason.

Each benchmark question receives one automatic recall, one DSH model step, no tools, and no AMA write. A fresh DSH session ID is created for every question on each runner invocation, so a restarted runner cannot resume an unrecorded QA transcript. The AMA memory window is cleared around each recall. The 256-token cap applies to A, B, and C and is an evaluation control only; product defaults and the product memory prompt are unchanged. The full evaluation contract and exact run sequence live in `eval/memory/locomo/README.md` and `manifest-hc-mem-003.json`.
