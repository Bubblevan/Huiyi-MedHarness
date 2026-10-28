import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { randomBytes, pbkdf2Sync } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { captureEvaluationSourceFingerprint, captureHealthEngineSourceFingerprint } from "../../eval/clinical/source-fingerprint.ts";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");
const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const runStamp = new Date().toISOString().replace(/[-:.]/g, "");
const runDir = resolve(root, "artifacts/e2e-gpt6-luna-20261013", `run-${runStamp}-edge-v2`);
const origin = "http://127.0.0.1:5174";
const engine = "http://127.0.0.1:8362";
const bridge = "http://127.0.0.1:8333";
const localTrace = join(runDir, "local-trace.jsonl");
const memoryTrace = join(runDir, "memory-trace.jsonl");
const auditPath = join(runDir, "edge-audit.jsonl");
const edgeTracePath = join(runDir, "edge-trace.jsonl");
const resultPath = join(runDir, "edge-browser-e2e.json");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const username = "e2e-clinician";
const samples = { firstVisible: [], terminal: [], memory: [] };
const children = [];
let gateway, edge, vite, browser, page, sessions = [];
let syntheticPatientMemoryId, gatewayFactory;
let sessionEndsAtCleanup = 0;
let stage = "preflight";
const result = {
  schemaVersion: "huiyi-edge-gpt6-luna-browser-e2e/v1",
  status: "running",
  createdAt: new Date().toISOString(),
  source: { gitRevision: "", workingTreeDirty: false, sourceSha256: "", healthEngineSourceSha256: "" },
  route: { model: "gpt-6-luna", backend: "codex-app-server", bridgeConcurrency: 2, embedding: "Qwen3-Embedding-0.6B" },
  checks: {}, metrics: {}, trace: {}, cleanup: {}, failures: [],
};
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function jsonl(path) {
  return readFile(path, "utf8").then((text) => text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  })).catch(() => []);
}
function spawnQuiet(label, executable, args, cwd, env) {
  const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout.resume();
  child.stderr.resume();
  child.on("error", () => { result.trace[label + "ProcessError"] = true; });
  return child;
}
async function waitJson(url, valid, maxMs = 45000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const body = await response.json().catch(() => ({}));
      if (response.ok && valid(body)) return body;
    } catch {}
    await sleep(500);
  }
  throw new Error("SERVICE_READINESS_TIMEOUT");
}
async function waitSessionCount(count) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (sessions.length >= count) return true;
    await sleep(100);
  }
  return false;
}
async function waitAnswer(previous) {
  await page.waitForFunction((n) => {
    const rows = Array.from(document.querySelectorAll(".assistant-message"));
    if (rows.length <= n) return false;
    const last = rows[rows.length - 1];
    const content = last.querySelector(".assistant-markdown");
    return Boolean(content && !last.querySelector(".stream-cursor") && (content.textContent || "").trim());
  }, previous, { timeout: 300000 });
  return page.locator(".assistant-message").last().locator(".assistant-markdown").innerText();
}
async function waitCommit(count) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const records = await jsonl(memoryTrace);
    if (records.filter((r) => r.operation === "commit" && r.status === "completed").length >= count) return records;
    await sleep(750);
  }
  return jsonl(memoryTrace);
}
async function armVisibleProbe() {
  await page.evaluate(() => {
    window.__huiyiVisibleStartedAt = performance.now();
    window.__huiyiFirstVisibleAt = null;
    const root = document.querySelector(".thread-viewport");
    if (!root) return;
    const initialAssistantRows = document.querySelectorAll(".assistant-message .assistant-markdown").length;
    const visible = () => {
      const rows = document.querySelectorAll(".assistant-message .assistant-markdown");
      if (rows.length <= initialAssistantRows || window.__huiyiFirstVisibleAt !== null) return;
      const renderedText = rows[rows.length - 1].cloneNode(true);
      renderedText.querySelectorAll(".stream-cursor").forEach((cursor) => cursor.remove());
      if ((renderedText.textContent || "").trim()) {
        window.__huiyiFirstVisibleAt = performance.now();
        observer.disconnect();
      }
    };
    const observer = new MutationObserver(() => requestAnimationFrame(visible));
    observer.observe(root, { subtree: true, childList: true, characterData: true });
  });
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (p === 0.5 && sorted.length % 2 === 0) return Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
async function cancelRun(sessionId) {
  return page.evaluate(async (sid) => {
    const started = performance.now();
    const response = await fetch("/api/chat", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: sid, patientId: "patient-htn", encounterId: "demo-encounter-htn", message: "合成取消流程检查，请开始处理后立即停止，不给出诊疗建议。" }),
    });
    const runId = response.headers.get("x-run-id");
    const reader = response.body?.getReader();
    if (!response.ok || !runId || !reader) return { chatStatus: response.status, runIdPresent: Boolean(runId), firstEvent: null, terminalEvent: null, cancelStatus: null };
    const decoder = new TextDecoder();
    let buffer = "", firstEvent = null, terminalEvent = null, cancelStatus = null, cancelMs = null;
    async function nextEvents() {
      const chunk = await reader.read();
      if (chunk.done) return [];
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
      const events = [];
      let at = buffer.indexOf("\n\n");
      while (at >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (data) { try { events.push(JSON.parse(data).event); } catch {} }
        at = buffer.indexOf("\n\n");
      }
      return events;
    }
    while (firstEvent === null) {
      const names = await nextEvents();
      if (!names.length && !response.body) break;
      firstEvent = names[0] ?? null;
      if (firstEvent) terminalEvent = names.find((x) => ["run.cancelled", "run.completed", "run.failed"].includes(x)) ?? null;
    }
    if (firstEvent === "run.started") {
      const cancelStarted = performance.now();
      const cancelled = await fetch("/api/runs/" + encodeURIComponent(runId) + "/cancel", {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}",
      });
      cancelStatus = cancelled.status;
      cancelMs = Math.round(performance.now() - cancelStarted);
      await cancelled.arrayBuffer().catch(() => {});
      const deadline = performance.now() + 30000;
      while (!terminalEvent && performance.now() < deadline) {
        const names = await nextEvents();
        terminalEvent = names.find((x) => ["run.cancelled", "run.completed", "run.failed"].includes(x)) ?? null;
        if (!names.length) break;
      }
    } else await reader.cancel().catch(() => {});
    return { chatStatus: response.status, runIdPresent: true, firstEvent, terminalEvent, cancelStatus, cancelMs, elapsedMs: Math.round(performance.now() - started) };
  }, sessionId);
}

try {
  await mkdir(runDir, { recursive: true });
  const freeRamGiB = Math.round((process.getBuiltinModule("node:os").freemem() / (1024 ** 3)) * 10) / 10;
  result.metrics.freeRamAtStartGiB = freeRamGiB;
  if (freeRamGiB < 16) throw new Error("RESOURCE_GUARD_FREE_RAM_BELOW_16_GIB");
  const git = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const source = await captureEvaluationSourceFingerprint(root);
  const engineSha = await captureHealthEngineSourceFingerprint(root);
  result.source = { gitRevision: git, workingTreeDirty: source.relevantWorkingTreeDirty, sourceSha256: source.sourceSha256, healthEngineSourceSha256: engineSha };
  const b = await fetch(bridge + "/healthz", { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
  const route = await fetch(engine + "/_internal/evaluation/config", { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
  const rag = await fetch(engine + "/v1/rag/status", { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
  if (b.status !== "ok" || b.model !== "gpt-6-luna" || b.maxConcurrentTurns !== 2) throw new Error("BRIDGE_ATTESTATION_MISMATCH");
  if (route.amaModel !== "gpt-6-luna" || route.ragPlannerModel !== "gpt-6-luna" || route.embeddingModel !== "Qwen3-Embedding-0.6B" || route.healthEngineSourceSha256 !== engineSha || rag.status !== "ready") throw new Error("HEALTH_ENGINE_ATTESTATION_MISMATCH");
  result.route.corpusVersion = rag.corpusVersion;
  result.route.corpusChunks = rag.chunkCount;
  result.checks.preflight = "passed";
  if (!await (await import("node:fs/promises")).access(chromePath).then(() => true).catch(() => false)) throw new Error("CHROME_NOT_FOUND");

  const edgeRoot = join(root, "services/edge-gateway");
  const binary = join(runDir, "huiyi-edge-gateway.exe");
  await execFileAsync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", binary, "./cmd/huiyi-edge-gateway"], {
    cwd: edgeRoot, env: { ...process.env, GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local" }, timeout: 120000,
  });
  const password = randomBytes(24).toString("base64url");
  const salt = randomBytes(24);
  const account = {
    username, displayName: "合成测试医护", role: "clinician",
    salt: salt.toString("base64").replace(/=+$/g, ""),
    passwordVerifier: pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("base64").replace(/=+$/g, ""),
    iterations: 120000, patientIds: ["patient-htn"],
  };
  const cleanEnv = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "DEEPSEEK_API_KEY", "HUIYI_LOCAL_QWEN_API_KEY"]) delete cleanEnv[key];
  const edgeEnv = {
    ...cleanEnv, HUIYI_EDGE_ACCOUNTS_JSON: JSON.stringify([account]),
    HUIYI_EDGE_LISTEN_ADDRESS: "127.0.0.1:8323", HUIYI_EDGE_UPSTREAM: "http://127.0.0.1:8322",
    HUIYI_EDGE_ALLOWED_ORIGINS: origin, HUIYI_EDGE_AUDIT_PATH: auditPath, HUIYI_EDGE_TRACE_PATH: edgeTracePath,
  };

  Object.assign(process.env, {
    HUIYI_APP_ENV: "demo", HUIYI_DEMO_BACKEND: "dsh", HUIYI_DEMO_MODEL_BACKEND: "codex-app-server",
    HUIYI_DEMO_CODEX_MODEL: "gpt-6-luna", HUIYI_CODEX_BRIDGE_URL: bridge + "/v1",
    HUIYI_CODEX_BRIDGE_API_KEY: "local-only", HUIYI_HEALTH_ENGINE_URL: engine,
    HUIYI_DEMO_SYNTHETIC_AMA_MEMORY: "1", HUIYI_DEMO_MAX_TOKENS: "384",
    HUIYI_DEMO_TRACE_PATH: localTrace, HUIYI_MEMORY_TRACE_FILE: memoryTrace,
  });
  ({ createDemoServer: gatewayFactory } = await import("../../services/demo-gateway/src/server.ts"));
  ({ syntheticPatientMemoryId } = await import("../../services/demo-gateway/src/backends/dsh-runtime.ts"));
  gateway = gatewayFactory({ port: 8322, host: "127.0.0.1" });
  await new Promise((resolveListen, reject) => { gateway.once("error", reject); gateway.listen(8322, "127.0.0.1", resolveListen); });
  const gw = await waitJson("http://127.0.0.1:8322/api/health", (x) => x.status === "ok" && x.backend === "dsh" && x.modelName === "gpt-6-luna");
  result.checks.gateway = "passed";
  result.route.provider = gw.providerName;

  edge = spawnQuiet("edge", binary, [], edgeRoot, edgeEnv);
  await waitJson("http://127.0.0.1:8323/api/health", (x) => x.status === "ok" && x.backendReady);
  result.checks.edge = "passed";
  const webRoot = join(root, "apps/demo-web");
  const viteEnv = { ...cleanEnv, HUIYI_DEMO_GATEWAY_PORT: "8323", HUIYI_DEMO_WEB_PORT: "5174", VITE_APP_ENV: "edge" };
  vite = spawnQuiet("vite", process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5174", "--strictPort", "--mode", "edge"], webRoot, viteEnv);
  stage = "frontend-start";
  let html = "";
  const frontendDeadline = Date.now() + 45000;
  while (Date.now() < frontendDeadline) {
    try {
      const response = await fetch(origin + "/", { signal: AbortSignal.timeout(2000) });
      if (response.ok) { html = await response.text(); break; }
    } catch {}
    await sleep(250);
  }
  if (!html.includes("慧宜临床辅助工作台")) throw new Error("EDGE_FRONTEND_NOT_READY");
  result.checks.frontend = "passed";

  stage = "browser-launch";
  browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--disable-background-networking"] });
  const context = await browser.newContext();
  page = await context.newPage();
  const visibleEvents = [];
  let pageErrors = 0, consoleErrorCount = 0;
  page.on("pageerror", (error) => { pageErrors += 1; result.trace.lastPageErrorName = error.name; });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrorCount += 1;
    const mark = "[huiyi:trace] browser.assistant.first_visible";
    void Promise.all(message.args().map((arg) => arg.jsonValue().catch(() => undefined))).then((args) => {
      const item = args[1];
      if (args[0] === mark && item && typeof item === "object") {
        visibleEvents.push({ firstDeltaMs: item.firstDeltaMs, firstVisibleMs: item.firstVisibleMs, deltaToVisibleMs: item.deltaToVisibleMs });
      }
    });
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/sessions" && response.request().method() === "POST" && response.status() === 201) {
      void response.json().then((body) => { if (body.sessionId) sessions.push(body.sessionId); }).catch(() => {});
    }
  });
  await page.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  stage = "browser-login";
  await page.getByLabel("工作账号").fill(username);
  await page.getByLabel("密码").fill(password);
  const loginStarted = Date.now();
  await page.getByRole("button", { name: "登录工作台" }).click();
  await page.getByRole("button", { name: "新建接诊" }).waitFor({ timeout: 30000 });
  await page.waitForFunction(() => { const input = document.querySelector(".composer-input"); return input && !input.disabled; }, undefined, { timeout: 30000 });
  result.metrics.loginAndContextMs = Date.now() - loginStarted;
  if (!await waitSessionCount(1)) throw new Error("SESSION_CREATION_FAILED");
  result.checks.loginAndAuthorizedPatient = "passed";

  stage = "patient-scope-check";
  const denied = await page.evaluate(async (sid) => {
    const c = await fetch("/api/patients/patient-complex/context?encounterId=demo-encounter-complex");
    const s = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId: "patient-complex", encounterId: "demo-encounter-complex" }) });
    const h = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, patientId: "patient-complex", encounterId: "demo-encounter-complex", message: "synthetic scope probe" }) });
    return { context: c.status, session: s.status, chat: h.status };
  }, sessions[0]);
  result.metrics.deniedStatuses = denied;
  result.checks.patientScopeIsolation = Object.values(denied).every((value) => value === 404) ? "passed" : "failed";
  const beforeDeniedModelCount = (await jsonl(localTrace)).filter((r) => r.event === "model.request.queued").length;
  result.metrics.modelCallsBeforeAuthorizedTurn = beforeDeniedModelCount;

  const prompt = "完全合成的流程测试信息，不是真实患者事实：我最近一周在家早晨测得的血压大约是145/92，复诊时想和医生一起核对这组记录。请将其作为我自述的信息，不作诊断或治疗建议。请同时检索本地医学参考，简要说明居家血压记录与复诊讨论的相关内容，并在每条医学信息后用可点击证据编号引用本轮来源。";
  stage = "rag-turn";
  const firstStart = Date.now();
  const oldCount = await page.locator(".assistant-message").count();
  await armVisibleProbe();
  await page.locator(".composer-input").fill(prompt);
  await page.locator(".send-button").click();
  const firstAnswer = await waitAnswer(oldCount);
  const firstMs = Date.now() - firstStart;
  const firstVisibleMs = await page.evaluate(() => window.__huiyiFirstVisibleAt === null ? null : Math.round(window.__huiyiFirstVisibleAt - window.__huiyiVisibleStartedAt));
  const citationLabels = await page.locator(".citation-link").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label") || ""));
  const citations = citationLabels.map((x) => x.match(/查看证据\s+(.+)$/)?.[1]).filter(Boolean);
  let evidenceIds = [];
  if (citations.length) {
    await page.locator(".citation-link").first().click();
    await page.getByRole("dialog", { name: "医学证据来源" }).waitFor({ timeout: 10000 });
    evidenceIds = await page.locator(".evidence-drawer article.evidence-card").evaluateAll((nodes) => nodes.map((n) => n.id));
    await page.getByRole("button", { name: "关闭证据抽屉" }).click();
  }
  result.metrics.firstTurn = {
    completed: true, endToEndMs: firstMs, firstVisibleMs, assistantChars: firstAnswer.length,
    citationCount: citations.length, evidenceCardCount: evidenceIds.length,
    citationsValid: citations.length > 0 && citations.every((id) => evidenceIds.includes(id)),
  };
  const commits = await waitCommit(1);
  result.checks.amaCommit = commits.some((r) => r.operation === "commit" && r.status === "completed") ? "passed" : "failed";
  const scopedMemoryId = syntheticPatientMemoryId("patient-htn");
  result.metrics.memoryRecordsAfterCommit = await fetch(engine + "/v1/memory/stats/" + encodeURIComponent(scopedMemoryId)).then((r) => r.json()).then((x) => x.records ?? null).catch(() => null);

  stage = "cancel-and-recovery";
  const cancelled = await cancelRun(sessions[0]);
  result.metrics.cancel = cancelled;
  result.checks.cancelRoute = cancelled.cancelStatus === 202 && cancelled.firstEvent === "run.started" ? "passed" : "failed";
  const previousSessionCount = sessions.length;
  const resumeStart = Date.now();
  await page.getByRole("button", { name: "新建接诊" }).click();
  await page.waitForFunction(() => { const input = document.querySelector(".composer-input"); return input && !input.disabled; }, undefined, { timeout: 30000 });
  if (!await waitSessionCount(previousSessionCount + 1)) throw new Error("RECOVERY_SESSION_CREATION_FAILED");
  result.metrics.sessionAfterCancelMs = Date.now() - resumeStart;
  stage = "cross-session-recall";
  const secondStart = Date.now();
  const countBeforeRecall = await page.locator(".assistant-message").count();
  await armVisibleProbe();
  await page.locator(".composer-input").fill("我上次自述的早晨家庭血压大约是多少？只复述记忆中明确记录的数字和来源；没有记录就说未找到，不要推测。");
  await page.locator(".send-button").click();
  const secondAnswer = await waitAnswer(countBeforeRecall);
  const secondVisibleMs = await page.evaluate(() => window.__huiyiFirstVisibleAt === null ? null : Math.round(window.__huiyiFirstVisibleAt - window.__huiyiVisibleStartedAt));
  const bloodPressureFactRecall = /145\s*[/／]\s*92/.test(secondAnswer);
  result.metrics.secondTurn = { completed: true, endToEndMs: Date.now() - secondStart, firstVisibleMs: secondVisibleMs, assistantChars: secondAnswer.length, bloodPressureFactRecall, denialMarker: /未找到|没有记录|不记得|无法回忆/.test(secondAnswer) };
  const finalMem = await waitCommit(2);
  const recalls = finalMem.filter((r) => r.operation === "automatic_recall" && r.status === "completed");
  result.metrics.newSessionAmaRecallItems = recalls.at(-1)?.itemCount ?? null;
  result.checks.crossSessionAmaRecall = result.metrics.secondTurn.bloodPressureFactRecall && (result.metrics.newSessionAmaRecallItems ?? 0) > 0 ? "passed" : "failed";
  result.checks.postCancelRecovery = result.metrics.secondTurn.completed ? "passed" : "failed";

  await page.getByRole("button", { name: "退出登录" }).click();
  await page.getByRole("heading", { name: "医护人员登录" }).waitFor({ timeout: 15000 });
  result.checks.logoutRevokesSession = await page.evaluate(async () => (await fetch("/api/auth/session")).status === 401) ? "passed" : "failed";
  result.metrics.firstVisible = visibleEvents.slice(-2);
  result.metrics.pageErrors = pageErrors;
  result.metrics.consoleErrorCount = consoleErrorCount;
  const localRows = await jsonl(localTrace);
  const localRuns = localRows.filter((r) => r.event === "run.token_usage");
  const edgeRows = await jsonl(edgeTracePath);
  const terminals = edgeRows.filter((r) => r.event === "edge.chat.terminal");
  const completed = terminals.filter((r) => r.reason === "terminal_completed");
  const completedMs = completed.map((r) => r.elapsedMs).filter(Number.isFinite);
  const visibleMs = [result.metrics.firstTurn.firstVisibleMs, result.metrics.secondTurn.firstVisibleMs].filter(Number.isFinite);
  const assistantDeltas = completed.map((r) => r.firstAssistantDeltaMs).filter((x) => Number.isFinite(x) && x >= 0);
  result.metrics.completedTurns = { count: completed.length, p50Ms: percentile(completedMs, 0.5), p95Ms: percentile(completedMs, 0.95), firstAssistantDeltaP50Ms: percentile(assistantDeltas, 0.5), firstAssistantDeltaP95Ms: percentile(assistantDeltas, 0.95) };
  result.metrics.firstVisibleLatency = { count: visibleMs.length, p50Ms: percentile(visibleMs, 0.5), p95Ms: percentile(visibleMs, 0.95) };
  result.metrics.gatewayTerminals = terminals.map((r) => ({ reason: r.reason, durationMs: r.elapsedMs, firstAssistantDeltaMs: r.firstAssistantDeltaMs, evidenceItemCount: r.eventCounts?.["evidence.item"] ?? 0 }));
  const ragEvidenceItems = terminals.reduce((sum, r) => sum + (r.eventCounts?.["evidence.item"] ?? 0), 0);
  result.metrics.ragEvidence = {
    requested: true,
    toolInvoked: terminals.some((r) => (r.eventCounts?.["evidence.started"] ?? 0) > 0),
    evidenceItems: ragEvidenceItems,
    citationCount: result.metrics.firstTurn.citationCount,
    evidenceCardCount: result.metrics.firstTurn.evidenceCardCount,
    citationsValid: result.metrics.firstTurn.citationsValid,
  };
  result.checks.ragEvidenceCitation = result.metrics.ragEvidence.toolInvoked && result.metrics.firstTurn.citationsValid ? "passed" : "failed";
  result.metrics.tokenUsage = {
    dsh: localRuns.reduce((sum, r) => ({ inputTokens: sum.inputTokens + (r.rootInputTokens ?? 0) + (r.subagentInputTokens ?? 0), outputTokens: sum.outputTokens + (r.rootOutputTokens ?? 0) + (r.subagentOutputTokens ?? 0), totalTokens: sum.totalTokens + (r.rootTotalTokens ?? 0) + (r.subagentTotalTokens ?? 0) }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    ama: (await jsonl(memoryTrace)).reduce((sum, r) => ({ inputTokens: sum.inputTokens + (r.amaPromptTokens ?? 0), outputTokens: sum.outputTokens + (r.amaCompletionTokens ?? 0) }), { inputTokens: 0, outputTokens: 0 }),
  };
  const audits = await jsonl(auditPath);
  result.metrics.unauthorizedModelRequests = audits.some((r) => r.event === "chat" && r.outcome === "denied") && !audits.some((r) => r.event === "chat.start" && r.outcome === "denied") ? 0 : null;
  result.trace.edgeAudit = audits.reduce((counts, item) => {
    const key = String(item.event || "unknown") + ":" + String(item.outcome || "unknown");
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  result.trace.edgeStreamEvents = edgeRows.reduce((counts, item) => {
    counts[item.event] = (counts[item.event] || 0) + 1;
    return counts;
  }, {});
  result.trace.memory = (await jsonl(memoryTrace)).map((r) => ({
    operation: r.operation, status: r.status,
    ...(Number.isInteger(r.itemCount) ? { itemCount: r.itemCount } : {}),
    ...(Number.isFinite(r.latencyMs) ? { latencyMs: Math.round(r.latencyMs) } : {}),
    ...(Number.isInteger(r.amaPromptTokens) ? { amaPromptTokens: r.amaPromptTokens } : {}),
  }));

  await browser.close();
  browser = undefined;
  sessionEndsAtCleanup = sessions.length;
  await new Promise((resolveClose, rejectClose) => gateway.close((err) => err ? rejectClose(err) : resolveClose()));
  gateway = undefined;
  const closeDeadline = Date.now() + 90000;
  while (Date.now() < closeDeadline) {
    const ended = (await jsonl(memoryTrace)).filter((r) => r.operation === "session_end");
    if (ended.length >= sessionEndsAtCleanup) break;
    await sleep(1000);
  }
  const userId = syntheticPatientMemoryId("patient-htn");
  const forget = await fetch(engine + "/v1/memory/forget", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, confirmation: "forget all patient memory" }),
  });
  const memoryStats = await fetch(engine + "/v1/memory/stats/" + encodeURIComponent(userId)).then((r) => r.json()).catch(() => ({}));
  const finalizedMemoryRows = await jsonl(memoryTrace);
  result.metrics.tokenUsage.ama = finalizedMemoryRows.reduce((sum, r) => ({ inputTokens: sum.inputTokens + (r.amaPromptTokens ?? 0), outputTokens: sum.outputTokens + (r.amaCompletionTokens ?? 0) }), { inputTokens: 0, outputTokens: 0 });
  result.metrics.tokenUsage.ama.totalTokens = result.metrics.tokenUsage.ama.inputTokens + result.metrics.tokenUsage.ama.outputTokens;
  result.metrics.tokenUsage.combinedTotalTokens = result.metrics.tokenUsage.dsh.totalTokens + result.metrics.tokenUsage.ama.totalTokens;
  result.trace.memory = finalizedMemoryRows.map((r) => ({
    operation: r.operation, status: r.status,
    ...(Number.isInteger(r.itemCount) ? { itemCount: r.itemCount } : {}),
    ...(Number.isFinite(r.latencyMs) ? { latencyMs: Math.round(r.latencyMs) } : {}),
    ...(Number.isInteger(r.amaPromptTokens) ? { amaPromptTokens: r.amaPromptTokens } : {}),
    ...(Number.isInteger(r.amaCompletionTokens) ? { amaCompletionTokens: r.amaCompletionTokens } : {}),
  }));
  result.cleanup = {
    browserClosed: true, gatewayClosed: true, forgetStatus: forget.status,
    memoryEmpty: Boolean(memoryStats.records && Object.values(memoryStats.records).every((n) => n === 0)),
    isolatedHealthEngineLeftRunning: true, localCodexBridgeLeftRunning: true,
  };
  result.metrics.freeRamAtEndGiB = Math.round((process.getBuiltinModule("node:os").freemem() / (1024 ** 3)) * 10) / 10;
  result.checks.cleanup = result.cleanup.memoryEmpty && forget.status === 200 ? "passed" : "failed";
  result.status = Object.values(result.checks).every((value) => value === "passed") ? "passed" : "partial";
} catch (error) {
  result.status = "failed";
  result.failures.push(error instanceof Error ? { stage, name: error.name, message: error.message, stack: error.stack } : { stage, name: "UnknownError" });
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { if (gateway?.listening) await new Promise((resolveClose) => gateway.close(() => resolveClose())); } catch {}
  for (const child of [edge, vite]) {
    if (child && child.exitCode === null) { try { child.kill(); } catch {} }
  }
  await Promise.all(children.map((child) => new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
    const timeout = setTimeout(resolveExit, 5000);
    child.once("exit", () => { clearTimeout(timeout); resolveExit(); });
  })));
  result.finishedAt = new Date().toISOString();
  await mkdir(runDir, { recursive: true });
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: result.status, resultPath, checks: result.checks, metrics: result.metrics, trace: result.trace, cleanup: result.cleanup, failures: result.failures }) + "\n");
  if (result.status !== "passed") process.exitCode = 2;
}
