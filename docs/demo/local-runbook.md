# Local Demo Workstation runbook

## Prerequisites

- Windows or another Node host with Node `^22.19.0 || >=24.0.0` and pnpm `11.7.0` via Corepack.
- CPU only. No model weights, API credentials, Python environment, GPU, DSH service, or external clinical data are required.

## Install and start

From the repository root, `pnpm install` installs the root package and both demo workspace packages. Optional non-secret defaults are listed in `.env.example`; fixture mode and ports also have code defaults, so no environment file is required.

```powershell
pnpm install
pnpm demo:dev
```

Open <http://localhost:5173>. The web process binds to loopback and proxies `/api/*` to the Gateway. Gateway health is <http://localhost:8320/api/health>. The UI header should show `Local · fixture`.

To use a different local Gateway port, set `HUIYI_DEMO_GATEWAY_PORT` in the shell before starting both processes. The Gateway binds to `127.0.0.1` only.

## Demonstration cases

1. **高血压复诊:** short fixture turn with synthetic memory metadata and one demo evidence record.
2. **复杂病例:** deterministic, UI-only cardiology and endocrinology steps marked `simulated execution`; it does not run MDAgents.
3. **故障与恢复:** emits a partial fixture answer and a safe `FIXTURE_FAILURE` event to exercise the error panel and retry UI.

Send the suggested question or type a new synthetic-only prompt. Stop during a complex run to verify the stream halts. Select a citation link such as `[1]` to open the evidence source drawer. Memory and evidence appear in different panels. All screen data is fabricated.

Setting `HUIYI_DEMO_BACKEND=dsh` only exercises the explicit unavailable adapter boundary in this branch; it does not enable DSH integration. No real model request is made in either mode.

## Verification commands

```powershell
pnpm build
pnpm typecheck
pnpm test
pnpm demo:build
pnpm demo:test
pnpm --filter @huiyi/demo-web typecheck
pnpm --filter @huiyi/demo-web browser:smoke
```

Playwright may need the Chromium browser installed once with `pnpm --filter @huiyi/demo-web exec playwright install chromium`. Browser acceptance writes only synthetic screenshots under `artifacts/demo-edge-local/screenshots/`.

After `pnpm demo:build`, `pnpm demo:trace` refreshes the safe deterministic complex-case JSONL fixture trace under `artifacts/demo-edge-local/`.

## Output and cleanup

Build output is ignored under `lib/`, `apps/demo-web/dist/`, and `services/demo-gateway/dist/`; Playwright output is local. Tracked acceptance artifacts under `artifacts/demo-edge-local/` contain only safe synthetic event examples and verification summaries. Never copy real prompts, clinical records, secrets, local model weights, or patient memory into traces or screenshots.
