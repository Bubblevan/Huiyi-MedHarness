# ADR 0005: Bounded concurrency for the local Codex app-server bridge

- Status: experimental; live two-way DSH overlap observed, but one of six child runs failed in the routing smoke
- Date: 2026-10-11
- DSH package/runtime: `0.2.1-alpha.1`, pinned upstream commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc`
- Model route: local `codex app-server` process, model fixed to `gpt-6-luna`

## Context and inspected lifecycle seam

The DSH runtime remains the sole owner of root Agents, Sessions, AgentLoop, tool dispatch, child Agent execution, cancellation, and result admission. The inspected Huiyi composition in `services/demo-gateway/src/backends/dsh-runtime.ts` installs `ToolRuntime` with `maxParallelSubCalls: 1`, `AgentLoop` with `maxParallelToolCalls: 1`, and `SubagentRuntime` with `maxDepth: 1` / `maxActiveSubagents: 8`, then registers the pinned in-process `spawn` provider.

Pinned DSH `@deepseek-ai/dsh-subagent-spawn-in-process` starts each child through `startInProcessRun`; children have their own session and prompt and do not inherit the parent's conversation. The pinned subagent runtime supports multiple direct child activations, and Huiyi's MDAgents-derived orchestrator intentionally starts planned findings concurrently with bounded `mapBounded()` workers and `Promise.all` (`src/collaboration/orchestrator.ts`). The Huiyi adapter passes each child an explicit bounded case prompt, no inherited tools, `maxDepth: 1`, and the DSH cancellation signal; it admits only completed, schema-valid child results and disposes runs.

Before this ADR, `CodexAppServerClient.complete()` applied a single `Promise` queue around all requests. That queue serialized unrelated ephemeral app-server threads, negating the DSH collaboration runtime's supported parallel execution. The 2026-10-11 HCE-0001 paired engineering run observed one collaboration tool call with six child runs and a 118.35-second tool duration; integrated-arm P95 was 130.96 seconds. Those are one-run engineering measurements, not clinical outcomes.

Inspected integration sources:

- `docs/adr/0001-dsh-runtime-boundary.md` and `docs/adr/0004-mdagents-dsh-boundary.md` — DSH ownership and MDAgents adaptation.
- `services/demo-gateway/src/backends/dsh-runtime.ts` — exact pinned runtime composition and child concurrency limit.
- `src/collaboration/dsh-tool.ts` and `src/collaboration/orchestrator.ts` — native DSH tool seam and bounded child batches.
- `services/demo-gateway/node_modules/@deepseek-ai/dsh-subagent-spawn-in-process/lib/index.js` — pinned spawn provider delegates to `startInProcessRun`.
- `services/demo-gateway/node_modules/@deepseek-ai/dsh-subagent/lib/index.js` — pinned active-subagent pool and lifecycle implementation.
- `services/demo-gateway/src/backends/codex-app-server-bridge.ts` — local provider seam, ephemeral thread-per-request, signal-to-`turn/interrupt`, and thread-ID event correlation.

No DSH checkout or pinned DSH source is modified.

## Decision

Replace the one-request-at-a-time bridge queue with a FIFO `BoundedTurnGate`. The default limit is two active Codex app-server turns; `HUIYI_CODEX_BRIDGE_MAX_CONCURRENT_TURNS` may be set from 1 to 4. The DSH subagent limit remains eight, so excess requests wait at the model-provider boundary rather than creating unlimited concurrent model work.

Each completion still creates its own ephemeral Codex thread, correlates events by its unique `threadId`, and receives only the messages DSH supplied for that call. Queued requests are removed when their DSH abort signal fires; an active request still uses the existing `turn/interrupt` path. The bridge health endpoint exposes only the concurrency cap and active/queued/peak counters; it does not expose prompts, patient text, responses, or thread identifiers.

## Acceptance and limits

- Offline gate tests verify the concurrency ceiling, FIFO admission, abort removal, and permit release after failure.
- A live two-request smoke must use unique non-clinical tags, verify that each reply contains only its own tag, record the observed peak active bridge turns and token/latency metadata, and omit all reply text from the artifact.
- The live smoke measures bridge-level overlap for two short completions. It does not prove clinical quality, high-load stability, or latency at eight concurrent child runs.
- The model route still uses Codex account limits. The concurrency cap controls parallelism; it does not lower token use. Keep synthetic clinical evaluation serial unless a separate clinical run explicitly records its configured model concurrency and host resource snapshot.

## 2026-10-11 live DSH collaboration routing observation

The direct two-request bridge smoke passed first (`artifacts/clinical-eval/bridge-smokes/codex-concurrency-1791687750449.json`): two non-clinical uniquely tagged requests both returned HTTP 200 with their own tag only, peak active turns `2/2`, zero queued afterward, 4.96 s wall time vs 9.66 s summed request time, and 34,084 reported tokens. A subsequent explicitly requested synthetic engineering route smoke used authenticated Gateway → DSH → `consult_clinical_team` with the existing product policy and the GPT-6-Luna bridge capped at two active turns. The bridge observer sampled `/healthz` every 200 ms for 592 samples: peak active turns `2/2`, peak queued `0`, failed samples `0`. DSH completed the root turn and collaboration tool call; the collaboration planner started six child runs, of which five completed and one failed, so the collaboration result was degraded. DSH token attribution observed five of six child runs and is incomplete. The bridge emitted one sanitized `invalid_model_response` failure category during this run; existing aggregation did not associate it with one child. AMA made four calls without failed operations, its run-scoped synthetic namespace cleanup was verified, and a single local RAG retrieval returned three StatPearls passages in 426.6 ms. Total smoke duration was 123.13 s; the artifact is `artifacts/clinical-eval/smokes/smoke-20261011030807-d7e1c267.json`.

This is direct evidence that DSH child requests can overlap at the bounded bridge and return to the orchestrator without exceeding the configured concurrency cap. It is not a clean collaboration success, a thread-correlation stress test, a clinical evaluation, or evidence of stable performance. The smoke now reports `degraded` and exits non-zero when any collaboration child fails; the already-written artifact is preserved as recorded and must be read with its explicit `5/6`, `degraded`, and incomplete-attribution fields. No additional model, corpus, or dependency was downloaded. The temporary loopback services were stopped and the one run-scoped synthetic memory directory was removed; after cleanup, RAM availability was 19.83 GiB and C/D/E free space was 8.63/179.76/131.33 GiB.
