# Huiyi Demo Gateway event protocol v1

The wire format is Server-Sent Events. Each SSE `event:` value matches the JSON envelope `event`; each `data:` line contains one JSON value:

```json
{"version":1,"event":"assistant.delta","runId":"…","sessionId":"…","timestamp":"2026-10-10T00:00:00.000Z","data":{"text":"one visible text delta"}}
```

The envelope is a TypeScript discriminated union in `services/demo-gateway/src/contracts.ts`. `parseDemoEvent` validates both the envelope and event-specific fields at the API boundary; the server validates events immediately before serialization. `validateChatInput` bounds IDs and message size and checks the scenario enum. Unknown versions, unknown event names, and malformed payloads fail closed.

## Events

| Event | Data | Meaning |
|---|---|---|
| `run.started` | `backend`, `scenario` | Run accepted by selected adapter. |
| `context.patient` | `patientId` | Synthetic patient context identified. |
| `context.memory` | `itemCount` | Synthetic patient-history fixture count only; the DSH demo does not access a real AMA identity. |
| `evidence.started` | `queryLabel` | Huiyi's local medical-evidence tool began; no user query is included. |
| `evidence.item` | `evidenceId`, `rank`, `source`, `title`, `snippet` | Bounded source passage returned by local RAG; never written to logs. Fixture mode marks its sources as synthetic. |
| `evidence.completed` | `count` | Number of valid evidence records exposed to the drawer. |
| `agent.classified` | `complexity`, `simulated` | Classification from structured Huiyi collaboration output (`simulated: false`) or fixture flow. |
| `specialist.started` | `specialist`, `simulated` | Fixture-only UI simulation. Live DSH specialist detail is summarized by `collaboration.completed`; child text is never emitted. |
| `specialist.completed` | `specialist`, `durationMs`, `simulated` | Fixture-only UI simulation. |
| `tool.started` | `tool` | Actual DSH root tool call or fixture indicator; tool arguments are never exposed. |
| `tool.completed` | `tool`, `durationMs`, `status` | DSH tool result or fixture completion. |
| `collaboration.completed` | `complexity`, bounded `specialistRoles`, `teamCount`, child run counts, `degraded` | Metadata-only summary reduced from the structured collaboration tool result; no findings or reasoning. |
| `assistant.delta` | `text` | One DSH visible-text delta. Reasoning and other block types are filtered. The web adapter appends deltas and yields cumulative snapshots to assistant-ui. |
| `run.completed` | `durationMs` | Terminal success. |
| `run.cancelled` | `reason` | Cooperative DSH `Agent.cancel()` or fixture cancellation. |
| `run.failed` | safe `code` | Terminal error without stack or prompt data. DSH uses stable codes such as `MODEL_FAILURE`, `TURN_INCOMPLETE`, `SESSION_BUSY`, and `SESSION_CAPACITY`. |

Events keep one Gateway run ID and browser session ID. They carry no raw DSH event schema. Fixture order is deterministic; DSH order follows the native Session and assistant-stream lifecycle. Client disconnect aborts the active controller; `POST /api/runs/:runId/cancel` aborts the same run mapping and calls the native Agent cancellation seam. After cancellation the backend emits no additional text chunks.

## API

- `GET /api/health` returns status and active backend mode.
- `GET /api/demo/patients/:patientId` returns only one of two synthetic patient fixtures.
- `POST /api/chat` accepts `{sessionId, patientId, message, scenario?}` and returns SSE. Message payload limit is 4,000 characters; JSON body limit is 8 KiB.
- `POST /api/runs/:runId/cancel` requests cooperative cancellation of an active in-memory run and returns `202` with the `run.cancelled` envelope after the run settles. This acknowledgement lets a browser that has already aborted its SSE response still display the terminal cancellation metadata.

All Gateway requests are local loopback in this phase. Invalid JSON/shape returns `400`, oversized bodies `413`, unknown synthetic patient `422`, and missing patient/run `404`. Backend failures are safe `run.failed` SSE events.
