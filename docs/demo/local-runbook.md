# Local Demo Workstation runbook

## Fixture mode (default)

Node `^22.19.0 || >=24.0.0` and pnpm `11.7.0` via Corepack are sufficient. Fixture mode is CPU-only and needs no model weights, credentials, Python environment, GPU, DSH server, or external clinical data.

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

## Native DSH + local Qwen mode

This mode uses the in-process DSH `0.2.1-alpha.1` composition and the same local Qwen3-8B BF16 route recorded by HC-PERF-001. It uses synthetic patient fixtures only. The demo does not configure a real AMA patient identity; RAG and clinical collaboration remain Huiyi DSH tools and fail open if the local Health Engine is unavailable.

Start the previously validated local serving environment with its Eager baseline profile:

```bash
/root/gpufree-data/Health-Copilot/training/posttrain/.venv/bin/vllm serve /root/gpufree-share/data/Qwen3-8B \
  --host 127.0.0.1 --port 8000 --served-model-name Qwen/Qwen3-8B \
  --dtype bfloat16 --max-model-len 40960 --gpu-memory-utilization 0.80 \
  --max-num-seqs 8 --max-num-batched-tokens 2048 \
  --enable-prefix-caching --enable-chunked-prefill --seed 0 \
  --generation-config vllm \
  --default-chat-template-kwargs '{"enable_thinking":false}' \
  --enable-auto-tool-choice --tool-call-parser hermes --enforce-eager
```

After the model reports ready, launch the web and Gateway with DSH selected:

```bash
HUIYI_DEMO_BACKEND=dsh pnpm demo:dev
```

The browser and Gateway still bind to loopback. The adapter streams only DSH visible-text chunks; reasoning, prompts, tool arguments, and child outputs are filtered. Browser Sessions map to native DSH AgentHandles and are process-local. A process restart clears those Sessions. `HUIYI_DEMO_MODEL_BASE_URL` may change the endpoint only to another loopback HTTP URL; the model name, context window and per-request output cap are configurable with `HUIYI_DEMO_MODEL`, `HUIYI_DEMO_CONTEXT_WINDOW` and `HUIYI_DEMO_MAX_TOKENS`.

This is a local synthetic demo, not an internet-facing or hospital deployment. The DSH request can call the actual local model; the fixture error/recovery case is available only in fixture mode.

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

The Gateway acceptance tests include a CPU-only native DSH composition test and fake-runtime adapter tests. The optional live path should be exercised only after checking that the L40 is free and an operator has intentionally started the local vLLM service.

Playwright may need the Chromium browser installed once with `pnpm --filter @huiyi/demo-web exec playwright install chromium`. Browser acceptance writes only synthetic screenshots under `artifacts/demo-edge-local/screenshots/`.

After `pnpm demo:build`, `pnpm demo:trace` refreshes the safe deterministic complex-case JSONL fixture trace under `artifacts/demo-edge-local/`.

## Output and cleanup

Build output is ignored under `lib/`, `apps/demo-web/dist/`, and `services/demo-gateway/dist/`; Playwright output is local. Tracked acceptance artifacts under `artifacts/demo-edge-local/` contain only safe synthetic event examples and verification summaries. Never copy real prompts, clinical records, secrets, local model weights, or patient memory into traces or screenshots.
