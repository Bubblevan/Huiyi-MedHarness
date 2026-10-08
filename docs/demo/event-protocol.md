# Huiyi Demo Gateway event protocol v1

The wire format is Server-Sent Events. Each SSE `event:` value matches the JSON envelope `event`; each `data:` line contains one JSON value:

```json
{"version":1,"event":"assistant.delta","runId":"…","sessionId":"…","timestamp":"2026-10-09T00:00:00.000Z","data":{"text":"cumulative chunk"}}
```

The envelope is a TypeScript discriminated union in `services/demo-gateway/src/contracts.ts`. `parseDemoEvent` validates both the envelope and event-specific fields at the API boundary; the server validates events immediately before serialization. `validateChatInput` bounds IDs and message size and checks the scenario enum. Unknown versions, unknown event names, and malformed payloads fail closed.

## Events

| Event | Data | Meaning |
|---|---|---|
| `run.started` | `backend`, `scenario` | Run accepted by selected adapter. |
| `context.patient` | `patientId` | Synthetic patient context identified. |
| `context.memory` | `itemCount` | Memory summary item count only; no memory text in trace. |
| `evidence.started` | `queryLabel` | Fixture retrieval phase began; no user query included. |
| `evidence.item` | `evidenceId`, `rank`, `source`, `title`, `snippet` | Synthetic source record for citation rendering; never written to logs. |
| `evidence.completed` | `count` | Number of synthetic evidence records. |
| `agent.classified` | `complexity`, `simulated` | Fixture flow classification; no reasoning content. |
| `specialist.started` | `specialist`, `simulated` | UI-only specialist step. |
| `specialist.completed` | `specialist`, `durationMs`, `simulated` | UI-only step completion. |
| `tool.started` | `tool` | Fixture tool indicator. |
| `tool.completed` | `tool`, `durationMs`, `status` | Fixture tool completion. |
| `assistant.delta` | `text` | One small text chunk. The adapter appends chunks and yields a cumulative snapshot to assistant-ui. |
| `run.completed` | `durationMs` | Terminal success. |
| `run.cancelled` | `reason` | Cooperative fixture run cancellation. |
| `run.failed` | safe `code` | Terminal error without stack or prompt data. |

Events keep a single run ID and session ID. They carry no DSH internal event schema. Event order is deterministic per fixture scenario. Client disconnect aborts the active controller; `POST /api/runs/:runId/cancel` aborts the same run mapping. After cancellation the backend emits no additional text chunks.

## API

- `GET /api/health` returns status and active backend mode.
- `GET /api/demo/patients/:patientId` returns only one of two synthetic patient fixtures.
- `POST /api/chat` accepts `{sessionId, patientId, message, scenario?}` and returns SSE. Message payload limit is 4,000 characters; JSON body limit is 8 KiB.
- `POST /api/runs/:runId/cancel` requests cooperative cancellation of an active in-memory run and returns `202` with the `run.cancelled` envelope after the run settles. This acknowledgement lets a browser that has already aborted its SSE response still display the terminal cancellation metadata.

All Gateway requests are local loopback in this phase. Invalid JSON/shape returns `400`, oversized bodies `413`, unknown synthetic patient `422`, and missing patient/run `404`. Backend failures are safe `run.failed` SSE events.
