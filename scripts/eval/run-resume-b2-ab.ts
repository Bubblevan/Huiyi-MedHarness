import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attestCodexBridgeHealth } from "../../eval/clinical/bridge-attestation.js";
import { AuthenticatedClinicalGateway } from "../../eval/clinical/authenticated-gateway.js";
import { TASKS } from "../../eval/clinical/catalog.js";
import { validateSyntheticCase } from "../../eval/clinical/cohort.js";
import type { SyntheticClinicalCase, SyntheticTurn } from "../../eval/clinical/contracts.js";
import { readModelConfiguration } from "../../services/demo-gateway/src/backends/dsh-runtime.js";
import type { DemoEvent } from "../../services/demo-gateway/src/contracts.js";
import { RagClient } from "../../src/rag/client.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COHORT_PATH = resolve(ROOT, "artifacts/clinical-eval/cohort-300-adaptive-v2.jsonl");
const BRIDGE_URL = process.env.HUIYI_CODEX_BRIDGE_URL?.trim() || "http://127.0.0.1:8333/v1";
const BRIDGE_KEY = process.env.HUIYI_CODEX_BRIDGE_API_KEY?.trim() || "local-only";
const HEALTH_ENGINE_URL = process.env.HUIYI_HEALTH_ENGINE_URL?.trim() || "http://127.0.0.1:8325";
const TASK_COUNT = 10;
const ATTEMPT_TIMEOUT_MS = 4 * 60_000;

interface TaskPair {
  readonly case: SyntheticClinicalCase;
  readonly turn: SyntheticTurn;
}

interface RetrievedPassage {
  readonly evidenceId: string;
  readonly rank: number;
  readonly title: string;
  readonly snippet: string;
  readonly source: string;
}

interface Attempt {
  readonly caseId: string;
  readonly turnId: string;
  readonly topic: string;
  readonly arm: "single-agent" | "integrated";
  readonly capabilities: { readonly memory: false; readonly rag: boolean; readonly collaboration: false };
  readonly status: "completed" | "failed";
  readonly failureCode?: string;
  readonly runId?: string;
  readonly wallTimeMs: number;
  readonly observedTokens?: number;
  readonly plannerInputTokens: number;
  readonly plannerOutputTokens: number;
  readonly toolCalls: readonly { readonly tool: string; readonly status: string }[];
  readonly retrievedEvidence: readonly RetrievedPassage[];
  readonly retrievals: readonly NonNullable<Extract<DemoEvent, { event: "evidence.completed" }>['data']['retrieval']>[];
  readonly citationIds: readonly string[];
  readonly exactSameTurnCitationCount: number;
  readonly answerText: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function percentile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

async function assertReady(): Promise<{ sourceRevision: string; bridgeMaxConcurrentTurns: number; corpusVersion: string }> {
  const model = readModelConfiguration();
  if (model.modelId !== "gpt-6-luna" || model.baseUrl !== BRIDGE_URL.replace(/\/$/, "")) {
    throw new Error("B2 run requires the loopback Codex GPT-6-Luna bridge selected by this script.");
  }
  const bridgeBase = BRIDGE_URL.replace(/\/$/, "");
  const [healthResponse, modelsResponse, routeResponse, ragResponse] = await Promise.all([
    fetch(`${bridgeBase.replace(/\/v1$/, "")}/healthz`, { signal: AbortSignal.timeout(5_000) }),
    fetch(`${bridgeBase}/models`, { headers: { authorization: `Bearer ${BRIDGE_KEY}` }, signal: AbortSignal.timeout(5_000) }),
    fetch(`${HEALTH_ENGINE_URL}/_internal/evaluation/config`, { signal: AbortSignal.timeout(5_000) }),
    fetch(`${HEALTH_ENGINE_URL}/v1/rag/status`, { signal: AbortSignal.timeout(10_000) }),
  ]);
  if (!healthResponse.ok || !modelsResponse.ok || !routeResponse.ok || !ragResponse.ok) {
    throw new Error("B2 preflight failed: one or more loopback GPT-6-Luna/Health Engine readiness routes were unavailable.");
  }
  const bridgeHealth = await healthResponse.json() as unknown;
  const attestation = attestCodexBridgeHealth(bridgeHealth, "gpt-6-luna");
  if (attestation.status !== "matched" || attestation.maxConcurrentTurns !== 1) {
    throw new Error("B2 requires a healthy GPT-6-Luna bridge with maxConcurrentTurns=1.");
  }
  const models = await modelsResponse.json() as { data?: Array<{ id?: string }> };
  if (models.data?.filter((item) => item.id === "gpt-6-luna").length !== 1) {
    throw new Error("B2 GPT-6-Luna model route did not match the local bridge model list.");
  }
  const route = await routeResponse.json() as Record<string, unknown>;
  const ragStatus = await ragResponse.json() as Record<string, unknown>;
  if (route.amaModel !== "gpt-6-luna" || route.ragPlannerModel !== "gpt-6-luna" || route.ragEnabled !== true ||
      route.embeddingModel !== "Qwen3-Embedding-0.6B" || ragStatus.status !== "ready" ||
      typeof ragStatus.corpusVersion !== "string") {
    throw new Error("B2 Health Engine did not attest the expected local five-source RAG and GPT-6-Luna planner route.");
  }
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  return { sourceRevision, bridgeMaxConcurrentTurns: attestation.maxConcurrentTurns, corpusVersion: ragStatus.corpusVersion };
}

async function loadTasks(): Promise<{ bytes: Buffer; tasks: TaskPair[] }> {
  const bytes = await readFile(COHORT_PATH);
  const cases = bytes.toString("utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as SyntheticClinicalCase);
  const development = cases.filter((item) => item.split === "development");
  const tasks = development.flatMap((item) => {
    validateSyntheticCase(item);
    const turn = item.turns.find((candidate) => candidate.expectedTaskIds.includes(TASKS.evidence));
    return turn ? [{ case: item, turn }] : [];
  }).slice(0, TASK_COUNT);
  if (tasks.length !== TASK_COUNT || new Set(tasks.map(({ case: item }) => item.caseId)).size !== TASK_COUNT) {
    throw new Error(`B2 requires the first ${TASK_COUNT} fixed development evidence tasks from the frozen cohort.`);
  }
  return { bytes, tasks };
}

function countCitations(answer: string): string[] {
  return [...answer.matchAll(/\[evidence:([^\]\s]+)\]/g)].map((match) => match[1]!);
}

async function runAttempt(input: {
  readonly task: TaskPair;
  readonly arm: "single-agent" | "integrated";
  readonly gateway: AuthenticatedClinicalGateway;
}): Promise<Attempt> {
  const { task, arm, gateway } = input;
  const started = performance.now();
  let sessionId: string | undefined;
  let runId: string | undefined;
  let status: Attempt["status"] = "failed";
  let failureCode: string | undefined;
  let answerText = "";
  let events: readonly DemoEvent[] = [];
  try {
    sessionId = await gateway.createEncounterSession(task.case, task.turn.encounterId);
    const execution = await gateway.runTurn({
      sessionId,
      patientId: gateway.identityFor(task.case).patientId,
      encounterId: task.turn.encounterId,
      message: task.turn.patientMessage,
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    runId = execution.runId;
    events = execution.events;
    answerText = events.filter((event): event is Extract<DemoEvent, { event: "assistant.delta" }> => event.event === "assistant.delta")
      .map((event) => event.data.text).join("");
    const terminal = events.find((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.event));
    if (terminal?.event === "run.completed" && !execution.incomplete) status = "completed";
    else if (terminal?.event === "run.failed") failureCode = terminal.data.code;
    else failureCode = execution.incomplete === "timeout" ? "TIMEOUT" : execution.incomplete === "aborted" ? "ABORTED" : "NO_COMPLETED_TERMINAL_EVENT";
  } catch (error) {
    failureCode = error instanceof Error ? error.name : "UNKNOWN_ERROR";
  } finally {
    if (sessionId) {
      try { await gateway.closeEncounterSession(task.case, sessionId); }
      catch { status = "failed"; failureCode ??= "SESSION_CLEANUP_FAILED"; }
    }
  }
  const answerCitations = countCitations(answerText);
  const returnedIds = new Set(events.flatMap((event) => event.event === "evidence.item" ? [event.data.evidenceId] : []));
  const usage = runId ? gateway.usage.get(runId) : undefined;
  const retrievals = events.flatMap((event) => event.event === "evidence.completed" && event.data.retrieval ? [event.data.retrieval] : []);
  const plannerInputTokens = retrievals.reduce((sum, retrieval) => sum + (retrieval.plannerInputTokens ?? 0), 0);
  const plannerOutputTokens = retrievals.reduce((sum, retrieval) => sum + (retrieval.plannerOutputTokens ?? 0), 0);
  return {
    caseId: task.case.caseId,
    turnId: task.turn.turnId,
    topic: task.turn.evidenceTopics.join("; "),
    arm,
    capabilities: { memory: false, rag: arm === "integrated", collaboration: false },
    status,
    ...(failureCode ? { failureCode } : {}),
    ...(runId ? { runId } : {}),
    wallTimeMs: performance.now() - started,
    ...(usage?.totalTokens === undefined ? {} : { observedTokens: usage.totalTokens + plannerInputTokens + plannerOutputTokens }),
    plannerInputTokens,
    plannerOutputTokens,
    toolCalls: events.flatMap((event) => event.event === "tool.completed" ? [{ tool: event.data.tool, status: event.data.status }] : []),
    retrievedEvidence: events.flatMap((event) => event.event === "evidence.item" ? [{
      evidenceId: event.data.evidenceId,
      rank: event.data.rank,
      title: event.data.title,
      snippet: event.data.snippet,
      source: event.data.source,
    }] : []),
    retrievals,
    citationIds: answerCitations,
    exactSameTurnCitationCount: answerCitations.filter((id) => returnedIds.has(id)).length,
    answerText,
  };
}

function blindPacket(tasks: readonly TaskPair[], attempts: readonly Attempt[], runId: string) {
  const rows = new Map(attempts.map((attempt) => [`${attempt.caseId}|${attempt.turnId}|${attempt.arm}`, attempt]));
  return {
    schemaVersion: "huiyi-resume-b2-blinded-score-packet/v1",
    studyRunId: runId,
    scorerInstructions: "Score each paired response against the same task rubric and shared retrieved passage pool. Do not infer or report experiment arm; labels X/Y are randomly assigned per task. Do not provide clinical approval or patient-specific treatment advice.",
    rubric: {
      taskSatisfaction: "Does the answer respond to the frozen request, distinguish checked evidence from unverified claims, and accurately state whether the passages support the relevant general workflow topic?",
      necessaryInformationCoverage: "Does it cover the topic's necessary scope, identify relevant limitations or missing details, and avoid claiming that general passages verify a specific synthetic patient's history?",
      unsupportedMedicalAssertion: "Count each checkable medical or clinical-workflow assertion lacking direct or partial support in the shared passage pool. Do not count non-medical process statements.",
      passageSupport: "For each medical/workflow assertion, classify the shared retrieved passage relationship as direct, partial, unsupported, or contradicted. A source title or citation token alone is not support.",
      scale: "Binary task satisfaction; coverage 0-2; assertion-level support labels with a short rationale tied to evidence IDs or exact snippet phrases.",
    },
    cases: tasks.map(({ case: item, turn }) => {
      const single = rows.get(`${item.caseId}|${turn.turnId}|single-agent`);
      const integrated = rows.get(`${item.caseId}|${turn.turnId}|integrated`);
      const flip = Number.parseInt(sha256(`${runId}\0${item.caseId}\0${turn.turnId}`).slice(0, 2), 16) % 2 === 1;
      const pair = [
        { label: flip ? "Y" : "X", answer: single?.answerText ?? "", completed: single?.status === "completed" },
        { label: flip ? "X" : "Y", answer: integrated?.answerText ?? "", completed: integrated?.status === "completed" },
      ].map((entry) => ({ ...entry, answer: entry.answer.replace(/\[evidence:[^\]]+\]/g, "[citation]").replace(/检索来源[：:].*$/gms, "[source list removed for blind scoring]") }));
      const passages = (integrated?.retrievedEvidence ?? []).map(({ evidenceId, title, snippet, source }) => ({ evidenceId, title, snippet, source }));
      return {
        caseId: item.caseId,
        turnId: turn.turnId,
        prompt: turn.patientMessage,
        topic: turn.evidenceTopics,
        fixedRequirements: turn.expectedTaskIds,
        answers: pair,
        sharedPassagePool: passages,
      };
    }),
  };
}

async function main(): Promise<void> {
  process.env.HUIYI_APP_ENV = "clinical-evaluation";
  process.env.HUIYI_DEMO_MODEL_BACKEND = "codex-app-server";
  process.env.HUIYI_DEMO_CODEX_MODEL = "gpt-6-luna";
  process.env.HUIYI_CODEX_BRIDGE_URL = BRIDGE_URL;
  process.env.HUIYI_CODEX_BRIDGE_API_KEY = BRIDGE_KEY;
  process.env.HUIYI_HEALTH_ENGINE_URL = HEALTH_ENGINE_URL;
  process.env.HUIYI_DEMO_MAX_TOKENS = "384";
  process.env.HUIYI_RAG_FORCE_MODE = "iterative";
  const readiness = await assertReady();
  const { bytes: cohortBytes, tasks } = await loadTasks();
  const cohortSha256 = sha256(cohortBytes);
  const startedAt = new Date().toISOString();
  const studyRunId = `resume-b2-${startedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const outputDirectory = resolve(ROOT, "artifacts/clinical-eval/private", studyRunId);
  await mkdir(outputDirectory, { recursive: true });
  const attemptRowsPath = resolve(outputDirectory, "attempt-rows.jsonl");
  await writeFile(attemptRowsPath, "", "utf8");
  const rag = new RagClient();
  const gateways = new Map<"single-agent" | "integrated", AuthenticatedClinicalGateway>();
  for (const arm of ["single-agent", "integrated"] as const) {
    gateways.set(arm, new AuthenticatedClinicalGateway({
      studyRunId,
      arm,
      cases: tasks.map(({ case: item }) => item),
      concurrency: 1,
      ...(arm === "integrated" ? { integratedCapabilities: { memory: false, rag: true, collaboration: false } } : {}),
      evidenceClient: rag,
    }));
  }
  const attempts: Attempt[] = [];
  try {
    for (const gateway of gateways.values()) await gateway.start();
    for (const [index, task] of tasks.entries()) {
      const order = index % 2 === 0 ? ["single-agent", "integrated"] as const : ["integrated", "single-agent"] as const;
      for (const arm of order) {
        const attempt = await runAttempt({ task, arm, gateway: gateways.get(arm)! });
        attempts.push(attempt);
        await appendFile(attemptRowsPath, `${JSON.stringify(attempt)}\n`, "utf8");
        process.stdout.write(`${JSON.stringify({ studyRunId, caseId: attempt.caseId, turnId: attempt.turnId, arm, status: attempt.status, wallTimeMs: Math.round(attempt.wallTimeMs) })}\n`);
      }
    }
  } finally {
    await Promise.all([...gateways.values()].map((gateway) => gateway.dispose().catch(() => undefined)));
  }
  const byArm = Object.fromEntries(( ["single-agent", "integrated"] as const).map((arm) => {
    const rows = attempts.filter((attempt) => attempt.arm === arm);
    const completed = rows.filter((attempt) => attempt.status === "completed");
    const citations = rows.flatMap((attempt) => attempt.citationIds);
    const citationDenominator = citations.length;
    const validCitations = rows.reduce((sum, attempt) => sum + attempt.exactSameTurnCitationCount, 0);
    const tokens = rows.map((attempt) => attempt.observedTokens).filter((value): value is number => value !== undefined);
    const latencies = completed.map((attempt) => attempt.wallTimeMs);
    const tasksWithEvidence = rows.filter((attempt) => attempt.retrievedEvidence.length > 0).length;
    return [arm, {
      completed: completed.length,
      denominator: rows.length,
      completionRate: rows.length ? completed.length / rows.length : null,
      tasksWithAtLeastOneRetrievedPassage: tasksWithEvidence,
      citationIdsValidSameTurn: validCitations,
      citationIdsObserved: citationDenominator,
      sameTurnCitationResolutionRate: citationDenominator ? validCitations / citationDenominator : null,
      latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), denominator: latencies.length },
      observedTokens: { total: tokens.reduce((sum, value) => sum + value, 0), measuredTasks: tokens.length, denominator: rows.length },
      taskStatuses: rows.map(({ caseId, turnId, status, failureCode }) => ({ caseId, turnId, status, ...(failureCode ? { failureCode } : {}) })),
    }];
  }));
  const summary = {
    schemaVersion: "huiyi-resume-b2-ab-run/v1",
    studyRunId,
    startedAt,
    finishedAt: new Date().toISOString(),
    sourceRevision: readiness.sourceRevision,
    cohortSha256,
    split: "development",
    fixedTaskSelection: "First ten cases in cohort order with one evidence task; each is the frozen T07 evidence request. No label or answer-key data was read before generation.",
    pairedTaskCount: tasks.length,
    attemptCount: attempts.length,
    order: "Pair order alternates deterministically by task index to reduce a systematic first/second-arm effect.",
    model: "gpt-6-luna via local Codex app-server bridge",
    generation: { temperature: 0, maxTokens: 384, ragMode: "iterative", attemptTimeoutMs: ATTEMPT_TIMEOUT_MS, bridgeMaxConcurrentTurns: readiness.bridgeMaxConcurrentTurns, maxConcurrentGeneration: 1 },
    capabilities: {
      baseline: { memory: false, rag: false, collaboration: false },
      ragArm: { memory: false, rag: true, collaboration: false },
    },
    corpusVersion: readiness.corpusVersion,
    metricsByArm: byArm,
    attemptAudit: attempts.map(({ caseId, turnId, arm, status, failureCode, runId, wallTimeMs, observedTokens, plannerInputTokens, plannerOutputTokens, toolCalls, retrievedEvidence, retrievals, citationIds, exactSameTurnCitationCount }) => ({
      caseId, turnId, arm, status, ...(failureCode ? { failureCode } : {}), ...(runId ? { runId } : {}), wallTimeMs,
      ...(observedTokens === undefined ? {} : { observedTokens }), plannerInputTokens, plannerOutputTokens, toolCalls,
      retrievedEvidenceIds: retrievedEvidence.map((hit) => hit.evidenceId), retrievals, citationIds, exactSameTurnCitationCount,
    })),
    interpretation: "This artifact measures task execution, retrieval/citation traceability, latency, and observed tokens only. Passage support, information coverage, and task satisfaction require the blinded score file; citation-ID validity alone is not medical evidence support.",
  };
  const raw = {
    schemaVersion: "huiyi-resume-b2-raw-output/v1",
    studyRunId,
    sourceRevision: readiness.sourceRevision,
    tasks: tasks.map(({ case: item, turn }) => ({ caseId: item.caseId, turnId: turn.turnId, prompt: turn.patientMessage, topic: turn.evidenceTopics })),
    attempts,
    blindedScoringPacket: blindPacket(tasks, attempts, studyRunId),
  };
  await writeFile(resolve(outputDirectory, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(resolve(outputDirectory, "raw-and-blinded-review.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    studyRunId,
    sourceRevision: readiness.sourceRevision,
    pairedTasks: tasks.length,
    attempts: attempts.length,
    completedByArm: Object.fromEntries(Object.entries(byArm).map(([arm, value]) => [arm, (value as { completed: number }).completed])),
    outputDirectory: relative(ROOT, outputDirectory),
  })}\n`);
}

main().catch((error) => {
  const code = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`${JSON.stringify({ status: "failed", errorClass: code })}\n`);
  process.exitCode = 1;
});
