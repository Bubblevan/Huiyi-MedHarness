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

## Native DSH + local vLLM mode

This mode uses the in-process DSH `0.2.1-alpha.1` composition and a local Qwen3-8B route. It uses synthetic patient fixtures only. By default, fixture memory is read-only. For an isolated local end-to-end run through AMA, explicitly enable synthetic-only persistent memory; each fixture patient receives a stable pseudonymous memory ID, and production startup rejects this flag.

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

### Windows laptop with the existing Qwen3-8B GGUF

The local Windows setup can use the already-installed `llama-server.exe`; it does not require WSL or a new model download. Start it in a terminal with the existing E: model file:

```powershell
$env:LLAMA_ARG_CHAT_TEMPLATE_KWARGS = '{"enable_thinking":false}'
llama-server.exe `
  -m 'E:\Health-Copilot-Models\models\qwen3-8b\Qwen3-8B-Q4_K_M.gguf' `
  --host 127.0.0.1 --port 8000 `
  --alias 'Qwen/Qwen3-8B' `
  --ctx-size 16384 --n-gpu-layers 99 --jinja
```

In a second terminal, select DSH and point its OpenAI-compatible route at that loopback endpoint:

```powershell
$env:HUIYI_DEMO_BACKEND = 'dsh'
$env:HUIYI_DEMO_MODEL_BACKEND = 'vllm' # local OpenAI-compatible adapter name
$env:HUIYI_DEMO_MODEL = 'Qwen/Qwen3-8B'
$env:HUIYI_DEMO_MODEL_BASE_URL = 'http://127.0.0.1:8000/v1'
$env:HUIYI_DEMO_CONTEXT_WINDOW = '16384'
$env:HUIYI_HEALTH_ENGINE_URL = 'http://127.0.0.1:8322'
$env:HUIYI_DEMO_SYNTHETIC_AMA_MEMORY = '1'
$env:HUIYI_MEMORY_TRACE_FILE = "$PWD\services\health-engine\data\local-run\memory-trace.jsonl"
pnpm demo:dev
```

The `vllm` setting is the Gateway's local OpenAI-compatible provider route name; it does not require that the server process itself be vLLM. Keep the API bound to `127.0.0.1`. Use only synthetic patient fixtures in this local demo.

## Native DSH + DeepSeek API mode

This mode keeps the same in-process DSH runtime and Huiyi tools, while routing model calls to DeepSeek's hosted OpenAI-compatible Chat Completions API. The default model is `deepseek-flash`; the endpoint is fixed to `https://api.deepseek.com`, and the API key is read from `DEEPSEEK_API_KEY` at request time. The endpoint cannot be overridden in this mode, which prevents sending the key to a different host. DeepSeek documents tool calls on this API; live DSH tool-call behavior still needs an API key and should be verified in the target environment.

Set these values in the repository-root `.env` file (ignored by Git). The DeepSeek route uses its own optional model variable, so an existing local `HUIYI_DEMO_MODEL=Qwen/Qwen3-8B` setting will not carry over:

```dotenv
HUIYI_DEMO_BACKEND=dsh
HUIYI_DEMO_MODEL_BACKEND=deepseek-api
DEEPSEEK_API_KEY=your-key-here
# Optional; defaults to deepseek-flash.
# HUIYI_DEMO_DEEPSEEK_MODEL=deepseek-flash
```

Then start the demo with `pnpm demo:dev`. The browser and Gateway continue to bind to loopback. The browser badge identifies the selected DSH route. To return to vLLM, set `HUIYI_DEMO_MODEL_BACKEND=vllm` (or remove it) and start the local vLLM server above.

DeepSeek API mode sends the user's prompt, the synthetic patient context, and any retrieved local evidence snippets to DeepSeek for generation. Use synthetic demonstration content only; do not enter real patient data, identifiers, or confidential records. The evidence search and clinical-collaboration tools remain local to the Huiyi process; their results may be included in the model request.

This is a local synthetic demo, not an internet-facing or hospital deployment. DSH calls the selected model route (local vLLM or DeepSeek API); the fixture error/recovery case is available only in fixture mode.

## Production boundary

Set `HUIYI_APP_ENV=production` in the Gateway service environment. Production defaults to the DSH backend and refuses an explicitly selected fixture backend. The synthetic `/api/demo/patients/:id` route returns 404, and `/api/chat` returns `503 PATIENT_CONTEXT_ADAPTER_REQUIRED` until an authenticated patient-context adapter is implemented and configured. This keeps fixture patients out of the production HTTP path; it does not by itself make the service ready for clinical deployment.

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
