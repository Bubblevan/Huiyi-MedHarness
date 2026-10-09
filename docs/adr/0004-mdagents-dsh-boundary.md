# ADR 0004: MDAgents method semantics on the DSH runtime

- Status: Accepted for HC-MA-001
- Date: 2026-10-09
- Huiyi base: `c349337e39e97d6ee7e971821af82ee22dde1290`
- MDAgents: `mitmedialab/MDAgents` at `3adbd760ca809b4e7b0c1085d68314b6e7d91e1b`
- DSH: `deepseek-ai/deepseek-harness` at `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, package/runtime `0.2.1-alpha.1`

## Context

Huiyi already treats DeepSeek Harness as the only owner of Agent, Session, AgentLoop, provider/model routing, tool dispatch, cancellation, result admission, and durable lifecycle. The product task is to translate MDAgents' adaptive medical collaboration method into that architecture without importing its Python runtime or changing existing Memory and RAG lifecycles.

Pinned source inspection confirmed that the DSH `ctx.subagents` service has the required one-shot seam. The `spawn` provider supports object-rooted structured output, a depth limit, a tool restriction, and a per-child persona. Spawn starts a fresh child without parent conversation history. Its `SubagentRun` exposes `result` and `dispose()`. Non-completed stop reasons can carry partial output, so Huiyi admits no output unless the stop reason is `completed`, structured data exists, and domain validation passes.

## Decision

HC-MA-001 implements **MDAgents-derived adaptive medical collaboration** through a typed collaboration plan, DSH native child Agents, bounded execution policy, structured findings, and metadata-only trace. It is not an exact MDAgents reproduction.

### Upstream reproduction semantics

The original MDAgents implementation owns:

- adaptive complexity classification;
- basic, intermediate, and advanced branches;
- expert recruitment and role assignment;
- collaborative discussion;
- MDT organization;
- moderator/final decision.

The pinned benchmark shape uses one agent for basic cases, five recruited experts with up to five rounds and five turns for intermediate cases, and three MDTs with three clinicians per team for advanced cases. These are benchmark profile values, not live product defaults. The advanced recruitment prompt also asks for Initial Assessment and Final Review/Decision teams despite the three-team count; this source inconsistency is documented in the upstream map.

### Not preserved as implementation

Huiyi does not preserve:

- the MDAgents `Agent` class;
- its OpenAI Python client or Gemini Python client;
- mutable per-Agent `messages` arrays;
- a Python-owned conversation runtime;
- `prettytable` / `pptree` runtime behavior;
- raw-text parsing as the main product contract.

### Huiyi adaptation

The MDAgents method is translated into:

```text
typed collaboration plan
+ DSH native child Agents
+ bounded execution policy
+ structured results
+ metadata-only trace
```

DSH's `spawn` provider is the default. The adapter passes the exact root Agent, a request AbortSignal, an object-rooted `outputSchema`, `maxDepth: 1`, a specialist persona, and `toolFilter: { allow: [] }`. The child receives only the explicitly built case prompt; it receives no root transcript and no inherited tools. All child results require `stopReason === 'completed'`, a structured value, and successful Huiyi validation. Every published run is disposed in `finally`.

Huiyi product policy bounds specialists, teams, rounds, concurrency, and total child runs. Benchmark policy separately encodes the pinned upstream structure and its 138-run intermediate ceiling covers one classifier, one recruiter, five independent findings, up to 125 bounded peer refinements, five final specialist findings, and one moderator. It is a bounded structural reference, not a claim of exact MDAgents paper reproduction, and is not run live by HC-MA-001. Advanced team membership is represented in Huiyi metadata; all children remain direct children of the root so `maxDepth` stays one.

## Peer communication seam

MDAgents models expert-to-expert discussion. DSH's `sendMessage` is authorized for adjacent Agents in the continuable-child lifecycle; it does not authorize arbitrary sibling-to-sibling messages. Huiyi will not call `ctx.subagents.sendMessage()` to simulate sibling chat. The first product skeleton captures independent structured findings, projects a bounded set of peer summaries, and supplies those summaries explicitly to any bounded refinement child run. A future continuable-child adapter may use DSH's authorized adjacency path when its lifecycle is specifically designed and tested.

## Ownership and activation

There is one Huiyi-owned outer control path. DSH may internally run child Agents through its native subagent service. Huiyi introduces no second custom AgentLoop. At HC-MA-001, the normal product `apply()` path did not install live collaboration; the low-level `installCollaboration(...)` API was exposed for a later validated host integration.

### HC-MA-002 activation amendment (2026-10-09)

After the pinned DSH/local Qwen smoke and fixed four-case dev diagnostic passed, HC-MA-002 wires the typed `consult_clinical_team` capability into `applyWithIdentity()`. It mounts only when the host provides DSH's native `spawn` service, scopes the instruction to runtime root Agents through `agent.ctx`, and hides inherited global tools from children with `toolFilter: { allow: [] }` and `maxDepth: 1`. The root DSH AgentLoop remains the sole owner of the user-facing answer. A four-case dev diagnostic is integration evidence only; it does not establish a general accuracy gain or MDAgents paper parity.

Product-mode moderator output is decision support for the root Agent; it does not replace the root DSH AgentLoop's user-facing answer. A future benchmark adapter may separately interpret a moderator choice as an evaluation answer. The two outcomes are not conflated.

## Consequences

- `HealthCaseState.patientMemory` and `HealthCaseState.externalEvidence` remain separate optional contracts; HC-MA-001 does not rewrite either runtime.
- A failed or incomplete child is recorded as failure metadata. Partial output is never promoted to a medical finding.
- Advanced work requires at least one successful specialist finding in every planned team before team synthesis or moderator review. If any team has no successful finding, all team synthesis and moderator work are skipped; successful findings from other teams remain available, and the snapshot is degraded for root fallback. If every team passes that threshold but a synthesis child fails, the moderator can review the available specialist and team summaries. No consensus is fabricated.
- Intermediate benchmark budgeting covers one classifier, one recruiter, five independent findings, 125 bounded discussion refinements, five final specialist findings, and one moderator (138 total child runs).
- Traces contain identifiers, role labels, counts, timing, stop reasons, and status only. They omit case text, memory content, evidence passages, prompts, findings, and hidden reasoning.
- HC-MA-001 CPU acceptance used deterministic fakes and performed no model inference. HC-MA-002 added a pinned local-Qwen smoke and four-case dev diagnostic before activating the typed capability in the normal bundle path.

## Pinned source map

The source-to-domain mapping and immutable source links are in [the MDAgents upstream map](../collaboration/mdagents-upstream-map.md). The DSH lifecycle types are in `packages/subagent/subagent/src/types.ts`; provider dispatch and capability validation are in `packages/subagent/subagent/src/index.ts`; fresh spawn behavior and supported features are in `packages/subagent/subagent-spawn-in-process/src/index.ts`; and `ToolRestriction` is defined in `packages/core/tools/src/index.ts` at the pinned commit. No upstream checkout is vendored or modified.
