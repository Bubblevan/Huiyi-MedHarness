# ADR 0001: DSH owns the runtime boundary

- Status: accepted for F0
- Date: 2026-10-07
- Pinned upstream: `deepseek-ai/deepseek-harness` at `5badb15009ae1756c3afe0ae0cef1faafc290ccc` (`0.2.1-alpha.1`)

## Decision

Implement Huiyi F0 as an out-of-tree DSH bundle. DSH owns Agent, Session, AgentLoop, native tool dispatch, result admission, cancellation, and the session-event stream. Huiyi contributes the `search_medical_evidence` contract, deterministic synthetic fixture provider, and domain tests. The bundle registers through `ctx.tools.register(defineTool(...))` and uses the DSH-provided `exec.signal`. There is one runtime; this package does not implement a second agent loop or session abstraction.

The bundle is a standalone package with a `dsh.bundle.patch` manifest and a stable Cordis patch row. It is installed into a DSH profile; the upstream source is a pinned integration dependency and documentation source, not a submodule or vendored tree. F0 is deliberately fixture-only. It has no Python sidecar, knowledge-base ingestion, production retrieval, memory, multi-agent logic, HTTP server, or clinical assistant.

## Data and event boundary

The canonical tool result is JSON shaped as `{ query, hits }`; each hit contains an evidence ID, rank, title, snippet, fixture URI, source type, and deterministic score. `output.schema` declares this value. `output.render()` presents the same JSON to the model. Fixture sources use `fixture://<evidenceId>` and are fabricated solely for pipeline verification.

The observer subscribes to `ctx.on('session/event')` and emits metadata for tool call/result, assistant settlement, and turn end. It includes session/sequence/turn/step, tool name/call ID, error status, interruption status, or reason kind. It never copies user text, assistant content, tool arguments, result content, or snippets into the observer output. The normal DSH session still owns its conversation and tool-result history.

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

## Consequences

- Type and runtime integration target DSH `0.2.1-alpha.1` and Cordis `4.0.5-alpha.1`.
- Offline tests validate domain matching, input constraints, output shape, cancellation, and metadata-only event projection without needing an LLM.
- The pinned DSH CLI's published guide shows `dsh plugin --profile <name> add <package>`. In this environment the generated profile is a pnpm workspace root and pnpm 11.7.0 rejects that bare add; forwarding `--workspace-root` through `dsh plugin` succeeds and DSH records the bundle in the profile manifest.
- A Git-hosted install needs the package `prepare` build and pnpm's per-package `allowBuilds` approval, as described in the pinned publish guide.
- A real DSH turn remains a separate smoke check and requires a configured provider. Failing to have a provider does not block package tests or config composition.
- Hospital data, Python retrieval code, and any future RAG integration belong to a later, separately scoped decision.
