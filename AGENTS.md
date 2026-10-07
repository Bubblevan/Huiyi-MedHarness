# Repository guardrails

This repository implements F0 of the Huiyi medical-evidence tool on top of the pinned DeepSeek Harness (DSH) runtime.

## Required invariants

1. Read the pinned DSH documentation and source before changing an integration boundary; record inspected sources in the ADR.
2. DSH owns Agent, Session, AgentLoop, tool dispatch, result admission, cancellation, and session events. Reuse these APIs.
3. Do not vendor or modify the DSH checkout. This repository is an out-of-tree DSH bundle.
4. Keep F0 fixture-only and deterministic. Do not add production RAG, MA-RAG, memory, multi-agent orchestration, a clinical assistant, HTTP service, or Python sidecar.
5. Add dependencies only when a concrete F0 capability or verification command requires them.
6. Add directories only for a required F0 artifact. Avoid speculative frameworks and abstractions.
7. Each capability must have an observable acceptance criterion and an offline reproduction path.
8. Keep research reproductions separate from product integration. Do not imply that F0 is clinical advice or a production evidence system.
9. Do not claim a command, integration, or runtime path works without recording its actual verification evidence.
10. Run the required offline tests, typecheck, bundle build, and DSH profile/config verification; report exact outcomes and blockers.

## F0 boundary

The only supported execution path is:

`User turn -> DSH Agent/Session -> native DSH tool call -> structured medical-evidence result -> same DSH turn continues -> final assistant response -> observable session/tool events`.

Stop after F0 acceptance. Do not begin F1 without a separate request.
