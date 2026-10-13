# Huiyi Edge Gateway

This small Go service is the server-side edge layer for the synthetic workstation preview. It owns user authentication, per-account patient scopes, patient-bound browser sessions, request authorization, and metadata-only audit records. It does not run DSH, models, RAG, or patient memory.

## Security boundary

- The service refuses non-loopback listen and upstream addresses. On the Ubuntu host it binds to `127.0.0.1:8321` and reaches the laptop Gateway through the existing SSH reverse forward at `127.0.0.1:8320`.
- Caddy serves the static client publicly, but `/api/*` is loopback-only until a valid HTTPS domain and public authentication policy are configured. The local browser reaches the HTTP listener through its encrypted SSH `-L` tunnel.
- Browser sessions use random opaque tokens, store only token hashes in memory, and set `HttpOnly`, `SameSite=Strict`, and an eight-hour expiry. Restarting the service revokes every session.
- Every session is bound to the authenticated account, patient ID, encounter ID, and expiry. The chat route rechecks the binding before forwarding and removes client-controlled scenario and identity fields.
- Audit records contain account ID, operation, patient/encounter IDs, timestamp, request ID, result, and HTTP status. They never contain passwords, patient messages, model text, evidence snippets, cookies, or IP addresses. The log is append-only in service operation, mode `0600`, and capped at 50 MiB; protected operations fail closed if audit writing fails.
- Demo account records contain PBKDF2-HMAC-SHA256 verifiers, random salts, iteration counts, roles, and explicit patient-ID grants. No plaintext password is stored.

## Stream trace

The Edge Gateway writes operational stream metadata to `/var/lib/huiyi-edge/trace.jsonl` by default. Override this with `HUIYI_EDGE_TRACE_PATH`. The local Demo Gateway and Codex app-server bridge append metadata to `%LOCALAPPDATA%\HuiyiMedHarness\traces\gateway-trace.jsonl` on Windows; override the path with `HUIYI_DEMO_TRACE_PATH`.

Both files are JSONL, rotate to a single `.1` file at 20–25 MiB, and are created with owner-only permissions where the operating system supports them. They contain correlation IDs, timestamps, durations, event counts, stage names, and bounded error classifications. They do not contain patient messages, generated answers, evidence text, credentials, or raw provider errors.

Correlate one request with the Edge `traceId`, local Gateway `edgeTraceId`, and the local `runId`. The Codex bridge also records a `modelRequestId`. Relevant event sequence:

1. Edge: `edge.chat.accepted`, `edge.chat.response_headers`, then 15-second `edge.chat.heartbeat` records with first-byte/SSE counters.
2. Local Gateway: `run.accepted`, `run.heartbeat`, `run.first_event`, `run.first_assistant_delta`, and `run.terminal`.
3. Codex bridge: `model.request.queued/admitted`, `model.thread.started`, `model.turn_start.accepted`, `model.first_delta`, 15-second `model.turn.heartbeat`, and `model.turn.terminal`.

This distinguishes queue delay, app-server/thread setup, no model delta, model output that has not completed its structured turn, DSH/tool activity before a visible answer, and a stream that failed between the local Gateway and Edge. The Codex bridge buffers its structured response until the app-server turn completes, so `model.first_delta` can precede the browser-visible `run.first_assistant_delta`.

Inspect from PowerShell:

```powershell
Get-Content "$env:LOCALAPPDATA\HuiyiMedHarness\traces\gateway-trace.jsonl" -Tail 100 -Wait
```

Inspect on Ubuntu:

```bash
sudo tail -n 100 -f /var/lib/huiyi-edge/trace.jsonl
```

## Account configuration

`HUIYI_EDGE_ACCOUNTS_B64` is the base64 encoding of a UTF-8 JSON array. Each entry has this shape:

```json
{
  "username": "clinician-a",
  "displayName": "医护用户 A",
  "role": "clinician",
  "salt": "raw-base64-salt",
  "passwordVerifier": "raw-base64-pbkdf2-sha256-output",
  "iterations": 120000,
  "patientIds": ["patient-htn"]
}
```

Use a unique salt of at least 16 bytes, PBKDF2-HMAC-SHA256 with 120,000 or more iterations, and a strong password. Keep the resulting configuration in a root-owned mode-`0600` server environment file. The supported patient scopes in this preview are `patient-htn` and `patient-complex`; these are synthetic fixtures, not a hospital patient registry.

## Build

```powershell
$env:GOOS = 'linux'
$env:GOARCH = 'amd64'
go build -trimpath -ldflags='-s -w' -o huiyi-edge-gateway ./cmd/huiyi-edge-gateway
```

The Ubuntu server needs only this binary, Caddy, static client files, a systemd unit, and the account/audit configuration. It does not need Node.js, pnpm, model weights, Milvus, or corpus files.
