# ADR 0001: DSH owns the runtime boundary

- Status: accepted for F0
- Date: 2026-10-07
- Pinned upstream: `deepseek-ai/deepseek-harness` at `5badb15009ae1756c3afe0ae0cef1faafc290ccc` (`0.2.1-alpha.1`)

## Decision

Implement Huiyi F0 as an out-of-tree DSH bundle. DSH owns Agent, Session, AgentLoop, native tool dispatch, result admission, cancellation, and the session-event stream. Huiyi contributes the `search_medical_evidence` contract, deterministic synthetic fixture provider, and domain tests. The bundle registers through `ctx.tools.register(defineTool(...))` and uses the DSH-provided `exec.signal`. There is one runtime; this package does not implement a second agent loop or session abstraction.

The bundle is a standalone package with a `dsh.bundle.patch` manifest and a stable Cordis patch row. It is installed into a DSH profile; the upstream source is a pinned integration dependency and documentation source, not a submodule or vendored tree. F0 is deliberately fixture-only. It has no Python sidecar, knowledge-base ingestion, production retrieval, memory, multi-agent logic, HTTP server, or clinical assistant.

## Data and event boundary

The canonical tool result is JSON shaped as `{ query, hits }`; each hit contains an evidence ID, rank, title, snippet, fixture URI, source type, and deterministic score. `output.schema` declares this value. `output.render()` presents the same JSON to the model. Fixture sources use `fixture://<evidenceId>` and are fabricated solely for pipeline verification.

The observer subscribes to `ctx.on('session/event')` and emits metadata for turn/user boundaries, the resolved model route, tool call/result, assistant settlement, and turn end. It includes session/sequence/turn/step, provider/model/context window, tool name/call ID, error status, interruption status, reason kind, and the hit count from a canonical evidence result. It never copies user text, assistant content, tool arguments, result content, or snippets into the observer output. The normal DSH session still owns its conversation and tool-result history.

## Pinned sources inspected

All source paths below are relative to the pinned upstream checkout at the SHA above.

- `docs/architecture.md` — external plugin composition and runtime ownership.
- `docs/cookbook/extension-cookbook.md` — plugin extension points and metadata-only session-event observation.
- `docs/cookbook/adding-a-tool.md` — typed tool contract, canonical output schema, render projection, and cancellation signal.
- `docs/user/develop/basic/tool.md` — `ctx.tools.register(defineTool(...))` plugin pattern.
- `docs/user/develop/basic/publish.md` — `dsh.bundle.patch`, Cordis bundle row, profile install, and local linked-package behavior.
- `packages/todo/tool-todo/src/index.ts` — shipped native tool using `defineTool`, parameter declarations, `output.schema`, and `output.render`.
- `packages/client/product-analytics/src/index.ts` — shipped `session/event` observer pattern; Huiyi intentionally records fewer fields.
- `packages/core/tools/src/index.ts` — `ToolRunContext.signal` and the tool registry execution API.
- `packages/core/session/src/types.ts` — event payloads for `tool/call`, `tool/result`, `assistant/message`, and `turn/end`.
- `packages/llm/llm-pi-ai/README.md` — pinned profile contract for custom OpenAI-compatible routes (`api`, `baseURL`, `models[].contextWindow`, `apiKeyEnv`) and the requirement to pass a placeholder key or Authorization header to a keyless OpenAI-compatible endpoint.
- `packages/llm/llm-pi-ai/src/config.ts` — pinned validation for custom routes and model profile fields; an unrecognized provider route requires an API protocol, endpoint, and non-empty model catalog.
- `packages/bundle/base/cordis.patch.yml` — the existing `llm-pi-ai`, `agent-default-model`, and `agent-loop` entry ids; the base keeps the adapter dormant and leaves startup agents empty.
- `packages/core/agent-loop/README.md` — the default AgentLoop lifecycle: model request, tool execution, durable result append, then next model step.
- `packages/core/agent-loop/src/agent.ts` and `packages/core/agent-loop/src/tool-calls.ts` — the pinned Agent implementation and native tool-call dispatch path.
- `docs/user/develop/basic/publish.md` — profile patch layering and the user's profile `cordis.patch.yml` override behavior.

For F0.1 source inspection, the DSH checkout at the exact pinned SHA was kept outside the Huiyi repository and used as a read-only reference. No upstream source was changed or vendored into Huiyi. The inspected paths are also linked to immutable GitHub URLs at the exact SHA:

- <https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/llm-pi-ai/README.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/llm-pi-ai/src/config.ts>
- <https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/bundle/base/cordis.patch.yml>
- <https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/README.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/src/agent.ts>
- <https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/src/tool-calls.ts>
- <https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/user/develop/basic/publish.md>

## F0.1 local model deployment boundary

The local Qwen route is profile-owned. The profile patch targets DSH's existing `llm-pi-ai` row and declares the OpenAI Chat Completions protocol, endpoint, model id, context window, and `apiKeyEnv` reference. `agent-default-model` selects that provider/model for newly created sessions. The Huiyi bundle still owns only the synthetic `search_medical_evidence` tool and metadata-only session observer. `HUIYI_SESSION_TRACE_FILE`, when set by the smoke invocation, appends the observer's already-filtered event records as JSONL; it never stores prompt, assistant, or tool content.

F0.1 acceptance is backed by the live three-case run in `artifacts/f0.1-local-qwen-live-20261007/`: all three turns completed in one persisted DSH Session, the tool-required and empty-hit turns each made one native `search_medical_evidence` call, and the no-tool turn made none. The run metadata and complete same-session trace are saved together. The trace contains turn and user-message boundaries, model route metadata, tool call/result correlation and hit count, assistant settlement, and turn end; it omits all message and evidence content. Offline direct tool execution is not evidence for that criterion.

## Consequences

- Type and runtime integration target DSH `0.2.1-alpha.1` and Cordis `4.0.5-alpha.1`.
- Offline tests validate domain matching, input constraints, output shape, cancellation, and metadata-only event projection without needing an LLM.
- The pinned DSH CLI's published guide shows `dsh plugin --profile <name> add <package>`. In this environment the generated profile is a pnpm workspace root and pnpm 11.7.0 rejects that bare add; forwarding `--workspace-root` through `dsh plugin` succeeds and DSH records the bundle in the profile manifest.
- A Git-hosted install needs the package `prepare` build and pnpm's per-package `allowBuilds` approval, as described in the pinned publish guide.
- A real DSH turn remains a separate smoke check and requires a configured provider. Failing to have a provider does not block package tests or config composition.
- Hospital data, Python retrieval code, and any future RAG integration belong to a later, separately scoped decision.
