# ADR 0004: local synthetic Demo Workstation boundary

- **Status:** Accepted for `DEMO-EDGE-LOCAL-001`
- **Date:** 2026-10-09

## Context

The repository has a DSH-owned Session/AgentLoop plus separate Health Engine memory and retrieval domains. A product-facing local demo needs an observable chat and clinical context UI, but the accepted phase requires CPU-only fixture acceptance and forbids a second runtime or an early cloud deployment.

## Decision

- Add a Vite static React frontend and an independent, loopback-only Node HTTP Gateway in the pnpm workspace.
- Use assistant-ui's current `useLocalRuntime + ChatModelAdapter` to own browser chat state and interaction primitives. The adapter translates only between assistant-ui's message model and the Huiyi v1 SSE contract.
- Make a deterministic synthetic fixture backend the default. Keep event schema validation, transport cancellation, and metadata-only logging in the Gateway.
- Add a DSH adapter interface stub that reports `BACKEND_UNAVAILABLE`; a later integration must invoke an existing DSH Session/AgentLoop and native cancellation seam.
- Keep patient Memory visually and contractually separate from source Evidence. Label specialist steps as simulated.
- Document Edge migration without implementing it.

## Consequences

The complete UI can run without CUDA, local model weights, Health Engine, or external service credentials. Chat history is ephemeral in the browser. Gateway run mapping is in memory. The UI can prove streaming/cancel/error behavior but not real medical reasoning, actual RAG/AMA results, or DSH integration. See [architecture](../demo/architecture.md), [event protocol](../demo/event-protocol.md), [reference research](../demo/reference-study.md), and [Edge plan](../demo/edge-migration.md).

## DSH boundary audit

Before creating the adapter seam, the pinned DSH checkout `5badb15009ae1756c3afe0ae0cef1faafc290ccc` was inspected at `packages/core/agent-loop/README.md`, `packages/core/agent-loop/src/agent.ts`, and `docs/subsystems/session.md`. DSH owns Session, AgentLoop, cooperative `Agent.cancel()`, and durable session/event lifecycle. This task neither imports a new DSH runtime into the Gateway nor modifies the DSH checkout. The future TODO maps cancellation to native cooperative cancellation; it does not kill a process.

## Status update — native local adapter

On 2026-10-10 the previously unavailable Web adapter was implemented as an opt-in in-process composition of the pinned DSH packages. The integration was checked against the installed pinned declarations and implementation for `AgentRegistry.create`, `AgentHandle.dispose`, `Agent.followup`, `Agent.cancel`, `Agent.whenIdle`, `session/event`, and `agent/assistant-stream`. The Gateway uses those native seams and creates no custom AgentLoop. It subscribes only to text-delta frames and filters all reasoning frames.

Each browser session/patient fixture pair maps to a native `AgentHandle`; DSH's Session is the only transcript. The map is bounded and exists only to hold handle capabilities. Cancellation reaches the DSH Agent, and Gateway shutdown disposes handles and the Cordis fiber. Huiyi's existing RAG and collaboration tools are mounted through `applyWithIdentity()`. Patient details and memory are synthetic fixture state passed as a typed MemorySnapshot; no real AMA identity is configured or mutated. The default backend remains fixture, and DSH selection is local opt-in only.

CPU acceptance creates/disposes a real DSH AgentHandle without model inference. Full end-to-end acceptance additionally requires the local Qwen vLLM service and is recorded separately from the fixture tests.

## Considered

- **Hono:** a valid light server option, but Node's HTTP primitives cover four local endpoints and SSE without adding a production framework dependency here.
- **assistant-ui hosted/AI SDK/LangGraph runtimes:** rejected because they would add a backend runtime path not owned by Huiyi/DSH. The local custom adapter is directly supported by current assistant-ui docs.
- **FHIR/Medplum/OpenMRS integrations:** rejected because synthetic workbench UX is the only accepted goal in this phase.
