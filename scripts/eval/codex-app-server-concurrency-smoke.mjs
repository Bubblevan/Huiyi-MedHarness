import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.HUIYI_CODEX_BRIDGE_URL?.trim() || "http://127.0.0.1:8335/v1";
const apiKey = process.env.HUIYI_CODEX_BRIDGE_API_KEY?.trim() || "local-only";
const bridge = new URL(baseUrl);
if (bridge.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(bridge.hostname)) {
  throw new Error("concurrency smoke accepts a loopback HTTP bridge only");
}
const healthUrl = new URL("/healthz", bridge.origin);
const bridgePrefix = bridge.pathname.replace(/\/$/, "");
const modelsUrl = new URL(`${bridgePrefix}/models`, bridge.origin);
const chatUrl = new URL(`${bridgePrefix}/chat/completions`, bridge.origin);

const healthResponse = await fetch(healthUrl);
if (!healthResponse.ok) throw new Error(`bridge health returned HTTP ${healthResponse.status}`);
const health = await healthResponse.json();
if (health?.status !== "ok" || health?.model !== "gpt-6-luna" || !Number.isSafeInteger(health?.maxConcurrentTurns)) {
  throw new Error("bridge health does not attest to the bounded GPT-6-Luna route");
}
if (health.maxConcurrentTurns < 2) throw new Error("bridge concurrency limit must be at least 2 for this smoke");

const modelsResponse = await fetch(modelsUrl, { headers: { authorization: `Bearer ${apiKey}` } });
if (!modelsResponse.ok) throw new Error(`bridge model catalog returned HTTP ${modelsResponse.status}`);
const models = await modelsResponse.json();
if (!Array.isArray(models?.data) || !models.data.some((model) => model?.id === "gpt-6-luna")) {
  throw new Error("bridge model catalog does not list gpt-6-luna");
}

const nonce = randomUUID();
const tags = [`probe-A-${nonce}`, `probe-B-${nonce}`];
const requestStart = performance.now();
const requests = tags.map(async (tag) => {
  const startedAt = performance.now();
  let response;
  try {
    response = await fetch(chatUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-6-luna",
        messages: [{ role: "user", content: `Non-clinical transport concurrency probe. Return exactly this unique tag and no other tag: ${tag}` }],
        tools: [],
        max_tokens: 64,
        stream: false,
      }),
    });
  } catch (error) {
    return { status: "failed", latencyMs: round(performance.now() - startedAt), errorType: error instanceof Error ? error.name : "unknown" };
  }
  const latencyMs = round(performance.now() - startedAt);
  if (!response.ok) {
    let code;
    try { code = (await response.json())?.error?.code; } catch { /* keep only HTTP metadata */ }
    return { status: "failed", httpStatus: response.status, ...(typeof code === "string" ? { errorCode: code } : {}), latencyMs };
  }
  let payload;
  try { payload = await response.json(); }
  catch { return { status: "failed", httpStatus: response.status, latencyMs, errorType: "invalid-json" }; }
  const content = payload?.choices?.[0]?.message?.content;
  const usage = payload?.usage;
  const labelMatched = typeof content === "string" && content.includes(tag) && !tags.some((other) => other !== tag && content.includes(other));
  return {
    status: labelMatched ? "completed" : "failed",
    httpStatus: response.status,
    labelMatched,
    latencyMs,
    ...(isTokenCount(usage?.prompt_tokens) ? { promptTokens: usage.prompt_tokens } : {}),
    ...(isTokenCount(usage?.completion_tokens) ? { completionTokens: usage.completion_tokens } : {}),
    ...(isTokenCount(usage?.total_tokens) ? { totalTokens: usage.total_tokens } : {}),
  };
});

const results = await Promise.all(requests);
const wallMs = round(performance.now() - requestStart);
const postHealthResponse = await fetch(healthUrl);
const postHealth = postHealthResponse.ok ? await postHealthResponse.json() : {};
const measured = results.filter((result) => result.status === "completed");
const serialReferenceMs = round(results.reduce((sum, result) => sum + result.latencyMs, 0));
const artifact = {
  schemaVersion: 1,
  artifactType: "codex-app-server-concurrency-smoke",
  measuredAt: new Date().toISOString(),
  status: results.length === 2 && measured.length === 2 && postHealth?.peakConcurrentTurns >= 2 ? "passed" : "failed",
  model: "gpt-6-luna",
  route: "local-codex-app-server-bridge",
  requestCount: results.length,
  maxConcurrentTurns: health.maxConcurrentTurns,
  observedPeakConcurrentTurns: postHealth?.peakConcurrentTurns ?? null,
  activeTurnsAfter: postHealth?.activeTurns ?? null,
  queuedTurnsAfter: postHealth?.queuedTurns ?? null,
  wallMs,
  serialReferenceMs,
  estimatedOverlapFraction: serialReferenceMs > 0 ? round(Math.max(0, 1 - wallMs / serialReferenceMs), 4) : null,
  modelGenerationRequests: 2,
  totalPromptTokens: sumOptional(results, "promptTokens"),
  totalCompletionTokens: sumOptional(results, "completionTokens"),
  totalReportedTokens: sumOptional(results, "totalTokens"),
  results,
  contentRecorded: false,
  patientDataUsed: false,
  externalDownloads: 0,
};

const artifactPath = resolve(root, process.env.HUIYI_CODEX_CONCURRENCY_ARTIFACT?.trim()
  || `artifacts/clinical-eval/bridge-smokes/codex-concurrency-${Date.now()}.json`);
if (!artifactPath.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)) {
  throw new Error("concurrency artifact path must remain inside the repository");
}
await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...artifact, artifactPath: artifactPath.slice(root.length + 1) })}\n`);
if (artifact.status !== "passed") process.exitCode = 1;

function isTokenCount(value) { return Number.isSafeInteger(value) && value >= 0; }
function sumOptional(items, key) {
  const values = items.map((item) => item[key]).filter(isTokenCount);
  return values.length === items.length ? values.reduce((sum, value) => sum + value, 0) : null;
}
function round(value) { return Math.round(value * 100) / 100; }
