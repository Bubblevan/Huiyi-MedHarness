import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthenticatedClinicalGateway } from "../../eval/clinical/authenticated-gateway.js";
import type { SyntheticClinicalCase, SyntheticTurn } from "../../eval/clinical/contracts.js";
import { checkHealthEngineRoute, classifyClinicalExchangeOutcome } from "../../eval/clinical/runner.js";
import { captureEvaluationSourceFingerprint } from "../../eval/clinical/source-fingerprint.js";
import { dshAgentSessionId } from "../../services/demo-gateway/src/backends/dsh.js";
import type { DemoEvent } from "../../services/demo-gateway/src/contracts.js";
import { readModelConfiguration, syntheticPatientMemoryId } from "../../services/demo-gateway/src/backends/dsh-runtime.js";
import { MemoryClient } from "../../src/memory/client.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COHORT_PATH = resolve(ROOT, "artifacts/clinical-eval/cohort-300-adaptive-v2.jsonl");
const BRIDGE_URL = (process.env.HUIYI_CODEX_BRIDGE_URL?.trim() || "http://127.0.0.1:8333/v1").replace(/\/$/, "");
const BRIDGE_KEY = process.env.HUIYI_CODEX_BRIDGE_API_KEY?.trim() || "local-only";
const HEALTH_ENGINE_URL = process.env.HUIYI_HEALTH_ENGINE_URL?.trim() || "http://127.0.0.1:8325";
const MAX_TOKENS = 384;
const TURN_TIMEOUT_MS = 240_000;
const SETUP_STOP_TURN = "T06";

type Arm = "single-agent" | "integrated";
type Phase = "memory" | "collaboration";

interface Attempt {
  phase: Phase;
  alias: string;
  caseId: string;
  turnId: string;
  arm: Arm;
  status: "completed" | "failed" | "cancelled";
  failureCode?: string;
  wallTimeMs: number;
  observedTokens?: number;
  toolCalls: string[];
  retrievalItems: number;
  collaboration: Array<{ completedChildRuns: number; failedChildRuns: number; degraded: boolean }>;
  memoryTrace: Array<{ operation: string; status: string; itemCount?: number; latencyMs?: number }>;
  recalledFactIds: string[];
  eligibleHistoricalFactIds: string[];
  exactEchoFactIds: string[];
  answerText?: string;
}

function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function jsonl<T>(text: string): T[] { return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T); }
function norm(value: string): string { return value.normalize("NFKC").replace(/\s+/g, " ").trim(); }
function matchesTurn(turn: SyntheticTurn, suffix: string): boolean { return turn.turnId.endsWith(suffix); }

function eligibleHistoricalFactIds(item: SyntheticClinicalCase, turn: SyntheticTurn): string[] {
  const targetIndex = item.turns.findIndex((candidate) => candidate.turnId === turn.turnId);
  if (targetIndex < 0) throw new Error(`target turn ${turn.turnId} is not in case ${item.caseId}`);
  const priorMessages = item.turns.slice(0, targetIndex).map((candidate) => candidate.patientMessage);
  const disclosed = new Set(item.facts
    .filter((fact) => fact.value !== item.patient.privateIsolationCanary && fact.value.length > 0 && priorMessages.some((message) => message.includes(fact.value)))
    .map((fact) => fact.factId));
  const priorEncounterIds = new Set(item.facts.filter((fact) => fact.encounterId !== turn.encounterId).map((fact) => fact.factId));
  return turn.requiredHistoricalFactIds.filter((factId) => disclosed.has(factId) && priorEncounterIds.has(factId));
}

function targetFactEchoes(item: SyntheticClinicalCase, turn: SyntheticTurn, answer: string): string[] {
  const byId = new Map(item.facts.map((fact) => [fact.factId, fact] as const));
  const eligible = eligibleHistoricalFactIds(item, turn);
  const normalizedAnswer = norm(answer);
  return eligible.filter((factId) => {
    const value = byId.get(factId)?.value;
    return Boolean(value && normalizedAnswer.includes(norm(value)));
  });
}

function eventsText(events: readonly DemoEvent[]): string {
  return events.filter((event): event is Extract<DemoEvent, { event: "assistant.delta" }> => event.event === "assistant.delta")
    .map((event) => event.data.text).join("");
}

function aliasMap(items: readonly SyntheticClinicalCase[], prefix: string): Map<string, string> {
  return new Map(items.map((item, index) => [item.caseId, `${prefix}${String(index + 1).padStart(2, "0")}`]));
}

async function forgetCaseMemory(gateway: AuthenticatedClinicalGateway, item: SyntheticClinicalCase): Promise<void> {
  const identity = gateway.identityFor(item);
  await new MemoryClient({ baseUrl: HEALTH_ENGINE_URL }).forget({
    userId: syntheticPatientMemoryId(identity.patientId, identity.tenantId),
    confirmation: "forget all patient memory",
  });
}

async function executeTurn(input: {
  readonly phase: Phase;
  readonly alias: string;
  readonly item: SyntheticClinicalCase;
  readonly turn: SyntheticTurn;
  readonly arm: Arm;
  readonly gateway: AuthenticatedClinicalGateway;
  readonly sessionId: string;
  readonly dshSessionId: string;
  readonly dshTurn: number;
  readonly includeAnswer: boolean;
}): Promise<Attempt> {
  const { phase, alias, item, turn, arm, gateway } = input;
  const started = performance.now();
  let status: Attempt["status"] = "failed";
  let failureCode: string | undefined;
  let events: readonly DemoEvent[] = [];
  let answerText = "";
  try {
    const execution = await gateway.runTurn({
      sessionId: input.sessionId,
      patientId: gateway.identityFor(item).patientId,
      encounterId: turn.encounterId,
      message: turn.patientMessage,
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    events = execution.events;
    answerText = eventsText(events);
    const outcome = classifyClinicalExchangeOutcome(events, execution.incomplete);
    status = outcome.status;
    failureCode = outcome.failureCode;
  } catch (error) {
    failureCode = error instanceof Error ? error.name : "UNKNOWN_ERROR";
  }
  const runId = events.find((event) => event.event === "run.started")?.runId;
  const usage = runId ? gateway.usage.get(runId) : undefined;
  const recallRows = gateway.takeMemoryRecallEvidence(input.dshSessionId, input.dshTurn, input.dshTurn);
  const recalledFactIds = [...new Set(recallRows.flatMap((row) => row.items.flatMap((entry) => entry.factIds)))].sort();
  const trace = gateway.memoryTrace.filter((record) => record.sessionId === input.dshSessionId && record.turn === input.dshTurn)
    .map((record) => ({
      operation: record.operation,
      status: record.status,
      ...(record.itemCount === undefined ? {} : { itemCount: record.itemCount }),
      ...(record.latencyMs === undefined ? {} : { latencyMs: record.latencyMs }),
    }));
  const collab = events.filter((event): event is Extract<DemoEvent, { event: "collaboration.completed" }> => event.event === "collaboration.completed")
    .map((event) => ({ completedChildRuns: event.data.completedChildRuns, failedChildRuns: event.data.failedChildRuns, degraded: event.data.degraded }));
  const toolCalls = events.flatMap((event) => event.event === "tool.completed" ? [event.data.tool] : []);
  const eligibleIds = phase === "memory" && (matchesTurn(turn, "T05") || matchesTurn(turn, "T06"))
    ? eligibleHistoricalFactIds(item, turn) : [];
  const exactEchoFactIds = eligibleIds.length && status === "completed" ? targetFactEchoes(item, turn, answerText) : [];
  return {
    phase, alias, caseId: item.caseId, turnId: turn.turnId, arm, status,
    ...(failureCode ? { failureCode } : {}),
    wallTimeMs: Math.max(0, performance.now() - started),
    ...(usage?.totalTokens === undefined ? {} : { observedTokens: usage.totalTokens }),
    toolCalls,
    retrievalItems: events.filter((event) => event.event === "evidence.item").length,
    collaboration: collab,
    memoryTrace: trace,
    recalledFactIds,
    eligibleHistoricalFactIds: eligibleIds,
    exactEchoFactIds,
    ...(input.includeAnswer ? { answerText } : {}),
  };
}

async function runMemoryArm(input: {
  phaseRunId: string;
  arm: Arm;
  cases: readonly SyntheticClinicalCase[];
  aliases: ReadonlyMap<string, string>;
  attemptsPath: string;
  targetsPath: string;
}): Promise<Attempt[]> {
  const gateway = new AuthenticatedClinicalGateway({
    studyRunId: input.phaseRunId,
    arm: input.arm,
    cases: input.cases,
    concurrency: 1,
    ...(input.arm === "integrated" ? { integratedCapabilities: { memory: true, rag: false, collaboration: false } } : {}),
  });
  const attempts: Attempt[] = [];
  await gateway.start();
  try {
    for (const item of input.cases) {
      if (input.arm === "integrated") await forgetCaseMemory(gateway, item);
      let sessionId = "";
      let encounterId = "";
      let dshId = "";
      let dshTurn = 0;
      try {
        for (const turn of item.turns) {
          if (encounterId !== turn.encounterId) {
            if (sessionId) await gateway.closeEncounterSession(item, sessionId);
            encounterId = turn.encounterId;
            sessionId = await gateway.createEncounterSession(item, encounterId);
            dshId = dshAgentSessionId(sessionId, gateway.identityFor(item).patientId, encounterId);
            dshTurn = 0;
          }
          dshTurn += 1;
          const target = matchesTurn(turn, "T05") || matchesTurn(turn, "T06");
          const row = await executeTurn({
            phase: "memory", alias: input.aliases.get(item.caseId)!, item, turn, arm: input.arm, gateway,
            sessionId, dshSessionId: dshId, dshTurn, includeAnswer: target,
          });
          attempts.push(row);
          await appendFile(input.attemptsPath, `${JSON.stringify({ ...row, answerText: undefined })}\n`, "utf8");
          if (target) await appendFile(input.targetsPath, `${JSON.stringify(row)}\n`, "utf8");
          process.stdout.write(`[memory ${input.arm}] ${row.turnId} ${row.status} ${Math.round(row.wallTimeMs)}ms\n`);
          if (matchesTurn(turn, SETUP_STOP_TURN)) break;
        }
      } finally {
        if (sessionId) await gateway.closeEncounterSession(item, sessionId).catch(() => undefined);
        if (input.arm === "integrated") await forgetCaseMemory(gateway, item);
      }
    }
  } finally {
    await gateway.dispose();
  }
  return attempts;
}

async function runCollaborationArm(input: {
  phaseRunId: string;
  arm: Arm;
  cases: readonly SyntheticClinicalCase[];
  aliases: ReadonlyMap<string, string>;
  attemptsPath: string;
  targetsPath: string;
}): Promise<Attempt[]> {
  const gateway = new AuthenticatedClinicalGateway({
    studyRunId: input.phaseRunId,
    arm: input.arm,
    cases: input.cases,
    concurrency: 1,
    ...(input.arm === "integrated" ? { integratedCapabilities: { memory: false, rag: false, collaboration: true } } : {}),
  });
  const attempts: Attempt[] = [];
  await gateway.start();
  try {
    for (const item of input.cases) {
      const turn = item.turns.find((candidate) => matchesTurn(candidate, "T06"));
      if (!turn || !turn.expectedComplexityPointIds.length) throw new Error(`no frozen complex target for ${item.caseId}`);
      const sessionId = await gateway.createEncounterSession(item, turn.encounterId);
      const dshId = dshAgentSessionId(sessionId, gateway.identityFor(item).patientId, turn.encounterId);
      const row = await executeTurn({
        phase: "collaboration", alias: input.aliases.get(item.caseId)!, item, turn, arm: input.arm, gateway,
        sessionId, dshSessionId: dshId, dshTurn: 1, includeAnswer: true,
      });
      attempts.push(row);
      await appendFile(input.attemptsPath, `${JSON.stringify({ ...row, answerText: undefined })}\n`, "utf8");
      await appendFile(input.targetsPath, `${JSON.stringify({ ...row, expectedComplexityPointIds: turn.expectedComplexityPointIds, prompt: turn.patientMessage })}\n`, "utf8");
      await gateway.closeEncounterSession(item, sessionId);
      process.stdout.write(`[collaboration ${input.arm}] ${row.turnId} ${row.status} ${Math.round(row.wallTimeMs)}ms; children=${row.collaboration.reduce((n, c) => n + c.completedChildRuns + c.failedChildRuns, 0)}\n`);
    }
  } finally {
    await gateway.dispose();
  }
  return attempts;
}

function aggregateMemory(input: {
  readonly cases: readonly SyntheticClinicalCase[];
  readonly targetsByArm: Readonly<Record<Arm, Attempt[]>>;
  readonly aliasByCase: ReadonlyMap<string, string>;
}) {
  const targetRows = (arm: Arm) => input.targetsByArm[arm];
  const expectedByTask = new Map<string, string[]>();
  for (const item of input.cases) for (const turn of item.turns.filter((candidate) => matchesTurn(candidate, "T05") || matchesTurn(candidate, "T06"))) {
    expectedByTask.set(`${item.caseId}|${turn.turnId}`, eligibleHistoricalFactIds(item, turn));
  }
  const perArm = (arm: Arm) => {
    const rows = targetRows(arm);
    const taskRows = rows.map((row) => ({
      alias: input.aliasByCase.get(row.caseId), turn: row.turnId.slice(-3), status: row.status,
      expectedFactCount: expectedByTask.get(`${row.caseId}|${row.turnId}`)?.length ?? 0,
      recalledTargetFactIds: row.recalledFactIds.filter((id) => (expectedByTask.get(`${row.caseId}|${row.turnId}`) ?? []).includes(id)),
      exactEchoFactIds: row.exactEchoFactIds,
      wallTimeMs: row.wallTimeMs,
      observedTokens: row.observedTokens ?? null,
    }));
    const eligible = rows.flatMap((row) => expectedByTask.get(`${row.caseId}|${row.turnId}`) ?? []);
    const echoed = rows.flatMap((row) => row.status === "completed" ? row.exactEchoFactIds : []);
    const memoryRecallTargets = rows.filter((row) => row.turnId.endsWith("T05"));
    const recallEligible = memoryRecallTargets.flatMap((row) => expectedByTask.get(`${row.caseId}|${row.turnId}`) ?? []);
    const recalled = memoryRecallTargets.flatMap((row) => row.recalledFactIds.filter((id) => (expectedByTask.get(`${row.caseId}|${row.turnId}`) ?? []).includes(id)));
    const complete = rows.filter((row) => row.status === "completed").length;
    const latencies = rows.map((row) => row.wallTimeMs).sort((a, b) => a - b);
    const tokens = rows.reduce((sum, row) => sum + (row.observedTokens ?? 0), 0);
    return {
      targetTurns: { completed: complete, denominator: rows.length },
      targetHistoricalFactEcho: { numerator: echoed.length, denominator: eligible.length, rate: eligible.length ? echoed.length / eligible.length : null },
      encounterStartAmaRecall: { numerator: recalled.length, denominator: recallEligible.length, rate: recallEligible.length ? recalled.length / recallEligible.length : null },
      latencyMs: { p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95), denominator: rows.length },
      observedTokensTotal: tokens,
      perTask: taskRows,
    };
  };
  const single = perArm("single-agent");
  const integrated = perArm("integrated");
  const taskOutcomes = new Map<string, Record<Arm, number>>();
  for (const arm of ["single-agent", "integrated"] as const) for (const row of input.targetsByArm[arm]) {
    const key = `${row.caseId}|${row.turnId}`;
    const values = taskOutcomes.get(key) ?? { "single-agent": 0, integrated: 0 };
    values[arm] = row.status === "completed" ? row.exactEchoFactIds.length : 0;
    taskOutcomes.set(key, values);
  }
  let integratedWins = 0, singleWins = 0, ties = 0;
  for (const row of taskOutcomes.values()) {
    if (row.integrated > row["single-agent"]) integratedWins++;
    else if (row.integrated < row["single-agent"]) singleWins++;
    else ties++;
  }
  return {
    status: "measured-isolated-engineering-result",
    pairedTaskCount: taskOutcomes.size,
    historicalFactOpportunityCount: single.targetHistoricalFactEcho.denominator,
    differencePercentagePoints: single.targetHistoricalFactEcho.rate === null || integrated.targetHistoricalFactEcho.rate === null
      ? null : 100 * (integrated.targetHistoricalFactEcho.rate - single.targetHistoricalFactEcho.rate),
    taskOutcomeCounts: { integratedOnlyWins: integratedWins, singleOnlyWins: singleWins, ties },
    byArm: { "single-agent": single, integrated },
    interpretationLimit: "History use is an exact fact-value substring check, not semantic adjudication. T06 occurs after T05 in the same new Encounter session; these turns include downstream within-Encounter conversational carry-forward.",
  };
}

function quantile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

function deterministicBlindPacket(studyRunId: string, targets: readonly Attempt[], cases: readonly SyntheticClinicalCase[]) {
  const byId = new Map(cases.map((item) => [item.caseId, item] as const));
  const perTask = new Map<string, Attempt[]>();
  for (const row of targets) {
    const pair = perTask.get(row.caseId) ?? [];
    pair.push(row);
    perTask.set(row.caseId, pair);
  }
  const unblind: Record<string, Record<string, Arm>> = {};
  const rows = [...perTask.entries()].map(([caseId, pair]) => {
    const item = byId.get(caseId)!;
    const turn = item.turns.find((candidate) => matchesTurn(candidate, "T06"))!;
    if (pair.length !== 2 || new Set(pair.map((row) => row.arm)).size !== 2) throw new Error(`incomplete blind pair for ${caseId}`);
    const flip = Number.parseInt(sha256(`${studyRunId}\0${caseId}\0T06`).slice(0, 2), 16) % 2 === 1;
    const single = pair.find((row) => row.arm === "single-agent")!;
    const integrated = pair.find((row) => row.arm === "integrated")!;
    const answers = [
      { label: flip ? "Y" : "X", row: single },
      { label: flip ? "X" : "Y", row: integrated },
    ];
    unblind[caseId] = Object.fromEntries(answers.map((answer) => [answer.label, answer.row.arm])) as Record<string, Arm>;
    return {
      taskAlias: `B3-C${String([...perTask.keys()].indexOf(caseId) + 1).padStart(2, "0")}`,
      taskPrompt: turn.patientMessage,
      expectedPointIds: turn.expectedComplexityPointIds,
      availableContextNote: "A fresh session for the current Encounter. It has the synthetic profile and generic prior-Encounter summary only; no AMA memory, no earlier Encounter transcript, and no external RAG evidence. Do not require hidden history facts. For compare-timeline, credit either a comparison of facts visible in the message or explicit recognition that the prior detail is unavailable and must be retrieved before making the comparison.",
      answers: answers.map(({ label, row }) => ({ label, completed: row.status === "completed", text: row.answerText ?? "" })),
    };
  });
  return {
    packet: {
      schemaVersion: "huiyi-b3-blind-complexity-packet/v1",
      scorerInstructions: "You are a blinded synthetic engineering scorer, not a clinician. Score only whether the answer covers each frozen workflow-analysis point using information available in the task/context. A failed/incomplete answer gets all false. Do not infer arm identity, do not reward length or tool use alone, do not require hidden historical facts, and do not give clinical advice. For each boolean, provide a short phrase from the answer or say null when false. Return strict JSON only.",
      pointDefinitions: {
        "identify-risk": "Recognizes the sudden, severe, continuing new symptom stated in the prompt as needing timely clinician assessment/escalation; do not score a diagnosis or specific treatment.",
        "state-uncertainty": "Separates known facts from unknown/missing information and avoids guessing or presenting absent data as confirmed.",
        "compare-timeline": "Compares timeline facts present in the message, or explicitly says the previous details are unavailable and requests prior-record review before asserting a change.",
        "separate-problems": "Clearly separates distinct symptoms/issues instead of blending them into one undifferentiated statement.",
      },
      outputSchema: { cases: [{ taskAlias: "B3-C01", answers: [{ label: "X", points: [{ id: "state-uncertainty", covered: true, evidence: "short exact phrase or null" }] }] }] },
      cases: rows,
    },
    unblind,
  };
}

async function runBlindScorer(packet: unknown): Promise<{ responseStatus: number; output: unknown; rawText: string }> {
  const response = await fetch(`${BRIDGE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${BRIDGE_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-6-luna",
      temperature: 0,
      max_tokens: 2200,
      messages: [
        { role: "system", content: "Score the blinded synthetic engineering packet. You are not a clinician and must not issue clinical advice. Follow its point definitions and output schema exactly." },
        { role: "user", content: JSON.stringify(packet) },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const responseJson: unknown = await response.json().catch(() => undefined);
  const content = typeof responseJson === "object" && responseJson !== null
    ? (responseJson as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
    : undefined;
  const rawText = typeof content === "string" ? content : JSON.stringify(content ?? responseJson ?? null);
  let output: unknown = null;
  if (response.ok) {
    const candidate = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try { output = JSON.parse(candidate) as unknown; } catch { output = null; }
  }
  return { responseStatus: response.status, output, rawText };
}

function summarizeCollaboration(input: {
  readonly cases: readonly SyntheticClinicalCase[];
  readonly targets: readonly Attempt[];
  readonly score: unknown;
  readonly unblind: Record<string, Record<string, Arm>>;
}) {
  const pointsByCase = new Map<string, readonly string[]>();
  for (const item of input.cases) pointsByCase.set(item.caseId, item.turns.find((turn) => matchesTurn(turn, "T06"))!.expectedComplexityPointIds);
  const scoreCases = typeof input.score === "object" && input.score !== null && Array.isArray((input.score as { cases?: unknown }).cases)
    ? (input.score as { cases: Array<{ taskAlias?: string; answers?: Array<{ label?: string; points?: Array<{ id?: string; covered?: boolean; evidence?: string | null }> }> }> }).cases
    : [];
  const aliases = new Map<string, string>(input.cases.map((item, index) => [`B3-C${String(index + 1).padStart(2, "0")}`, item.caseId] as const));
  const scored = new Map<string, Record<Arm, Map<string, { covered: boolean; evidence: string | null }>>>();
  for (const result of scoreCases) {
    const caseId = aliases.get(result.taskAlias ?? "");
    if (!caseId) continue;
    const taskScores: Record<Arm, Map<string, { covered: boolean; evidence: string | null }>> = { "single-agent": new Map(), integrated: new Map() };
    for (const answer of result.answers ?? []) {
      const arm = input.unblind[caseId]?.[answer.label ?? ""];
      if (!arm) continue;
      for (const point of answer.points ?? []) if (typeof point.id === "string" && typeof point.covered === "boolean") {
        taskScores[arm].set(point.id, { covered: point.covered, evidence: typeof point.evidence === "string" ? point.evidence.slice(0, 180) : null });
      }
    }
    scored.set(caseId, taskScores);
  }
  const perArm = (arm: Arm) => {
    let earned = 0, possible = 0;
    const rows = input.cases.map((item, index) => {
      const taskPoints = pointsByCase.get(item.caseId) ?? [];
      const row = scored.get(item.caseId)?.[arm];
      const result = input.targets.find((entry) => entry.caseId === item.caseId && entry.arm === arm);
      const checks = taskPoints.map((id) => ({ id, covered: result?.status === "completed" && (row?.get(id)?.covered ?? false), evidence: row?.get(id)?.evidence ?? null }));
      earned += checks.filter((check) => check.covered).length;
      possible += checks.length;
      return { alias: `B3-C${String(index + 1).padStart(2, "0")}`, status: result?.status ?? "missing", checks };
    });
    const toolRows = input.targets.filter((row) => row.arm === arm);
    const completed = toolRows.filter((row) => row.status === "completed").length;
    const targetLatencies = toolRows.map((row) => row.wallTimeMs).sort((a, b) => a - b);
    const children = toolRows.flatMap((row) => row.collaboration);
    return {
      keyPointCoverage: { numerator: earned, denominator: possible, rate: possible ? earned / possible : null },
      taskCoverage: rows,
      execution: { completed: completed, denominator: toolRows.length, p50Ms: quantile(targetLatencies, 0.5), p95Ms: quantile(targetLatencies, 0.95) },
      collaborationCalls: children.length,
      childRuns: {
        completed: children.reduce((sum, row) => sum + row.completedChildRuns, 0),
        failed: children.reduce((sum, row) => sum + row.failedChildRuns, 0),
        degradedCalls: children.filter((row) => row.degraded).length,
      },
      observedTokensTotal: toolRows.reduce((sum, row) => sum + (row.observedTokens ?? 0), 0),
    };
  };
  const single = perArm("single-agent"), integrated = perArm("integrated");
  let integratedWins = 0, singleWins = 0, ties = 0;
  for (const item of input.cases) {
    const a = single.taskCoverage.find((row) => row.alias === `B3-C${String(input.cases.indexOf(item) + 1).padStart(2, "0")}`)!.checks.filter((point) => point.covered).length;
    const b = integrated.taskCoverage.find((row) => row.alias === `B3-C${String(input.cases.indexOf(item) + 1).padStart(2, "0")}`)!.checks.filter((point) => point.covered).length;
    if (b > a) integratedWins++; else if (b < a) singleWins++; else ties++;
  }
  return {
    status: "measured-blinded-model-assisted-engineering-score",
    pairedCaseCount: input.cases.length,
    totalExpectedPoints: [...pointsByCase.values()].reduce((sum, rows) => sum + rows.length, 0),
    pairedTaskOutcomeCounts: { integratedOnlyWins: integratedWins, singleOnlyWins: singleWins, ties },
    differencePercentagePoints: single.keyPointCoverage.rate === null || integrated.keyPointCoverage.rate === null
      ? null : 100 * (integrated.keyPointCoverage.rate - single.keyPointCoverage.rate),
    byArm: { "single-agent": single, integrated },
    scorer: { model: "gpt-6-luna", blindLabels: true, sameModelFamilyAsGenerator: true, clinicianReview: false },
    limitations: ["Six fixed development tasks; small sample.", "The judge is model-assisted and from the generator's model family, not a clinician.", "The target query is run in a fresh Encounter session; prior fact-level history is deliberately unavailable to both arms.", "Coverage is limited to the frozen workflow-point rubric."],
  };
}

async function main(): Promise<void> {
  process.env.HUIYI_APP_ENV = "clinical-evaluation";
  process.env.HUIYI_DEMO_MODEL_BACKEND = "codex-app-server";
  process.env.HUIYI_DEMO_CODEX_MODEL = "gpt-6-luna";
  process.env.HUIYI_CODEX_BRIDGE_URL = BRIDGE_URL;
  process.env.HUIYI_CODEX_BRIDGE_API_KEY = BRIDGE_KEY;
  process.env.HUIYI_HEALTH_ENGINE_URL = HEALTH_ENGINE_URL;
  process.env.HUIYI_DEMO_MAX_TOKENS = String(MAX_TOKENS);
  process.env.HUIYI_DEMO_SYNTHETIC_AMA_MEMORY = "1";
  process.env.HUIYI_MEMORY_COMMIT_BATCH_TURNS = "4";
  delete process.env.HUIYI_MEMORY_TRACE_FILE;

  const cohortBytes = await readFile(COHORT_PATH);
  const cohort = jsonl<SyntheticClinicalCase>(cohortBytes.toString("utf8"));
  const development = cohort.filter((item) => item.split === "development");
  const memoryCases = development.filter((item) => item.turns.some((turn) => matchesTurn(turn, "T05")) && item.turns.some((turn) => matchesTurn(turn, "T06"))).slice(0, 3);
  const collaborationCases = development.filter((item) => item.complexity === "complex" && (item.turns.find((turn) => matchesTurn(turn, "T06"))?.expectedComplexityPointIds.length ?? 0) >= 2).slice(0, 6);
  if (memoryCases.length !== 3 || collaborationCases.length !== 6) throw new Error("Frozen development cohort does not provide the pre-registered B3 sample.");
  const historicalFactOpportunities = memoryCases.flatMap((item) => item.turns.filter((turn) => matchesTurn(turn, "T05") || matchesTurn(turn, "T06")).flatMap((turn) => eligibleHistoricalFactIds(item, turn)));
  if (historicalFactOpportunities.length < 8 || historicalFactOpportunities.length > 16) throw new Error(`B3 memory design must have 8–16 eligible fact opportunities; found ${historicalFactOpportunities.length}.`);

  const startedAt = new Date().toISOString();
  const runId = `resume-b3-${startedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const outputDir = resolve(ROOT, "artifacts/clinical-eval/private", runId);
  await mkdir(outputDir, { recursive: true });
  const attemptsPath = resolve(outputDir, "attempts-metadata.jsonl");
  const memoryTargetsPath = resolve(outputDir, "memory-targets-private.jsonl");
  const collaborationTargetsPath = resolve(outputDir, "collaboration-targets-private.jsonl");
  await Promise.all([writeFile(attemptsPath, "", "utf8"), writeFile(memoryTargetsPath, "", "utf8"), writeFile(collaborationTargetsPath, "", "utf8")]);

  const sourceFingerprint = await captureEvaluationSourceFingerprint(ROOT);
  const scriptPath = fileURLToPath(import.meta.url);
  const scriptSha256 = sha256(await readFile(scriptPath));
  const memoryAliases = aliasMap(memoryCases, "B3-M");
  const collaborationAliases = aliasMap(collaborationCases, "B3-C");
  const protocol = {
    schemaVersion: "huiyi-resume-b3-isolated-protocol/v1",
    studyRunId: runId,
    status: "pre-registered-before-generation",
    createdAt: startedAt,
    baseGitRevision: sourceFingerprint.gitRevision,
    relevantWorkingTreeDirty: sourceFingerprint.relevantWorkingTreeDirty,
    sourceFingerprintSha256: sourceFingerprint.sourceSha256,
    driverScriptSha256: scriptSha256,
    cohortSha256: sha256(cohortBytes),
    split: "development",
    model: "gpt-6-luna via loopback Codex app-server bridge",
    generation: { temperature: 0, maxTokens: MAX_TOKENS, turnTimeoutMs: TURN_TIMEOUT_MS, concurrency: 1 },
    memoryExperiment: {
      selection: "first three development cases in cohort order with T05 and T06",
      cases: memoryCases.map((item, index) => ({ alias: memoryAliases.get(item.caseId), caseId: item.caseId, targetTurns: ["T05", "T06"] })),
      targetPairedTurns: memoryCases.length * 2,
      eligibleHistoricalFactOpportunities: historicalFactOpportunities.length,
      baselineCapabilities: { memory: false, rag: false, collaboration: false },
      treatmentCapabilities: { memory: true, rag: false, collaboration: false },
      amaCommitBatchTurns: 4,
      factUseRule: "Exact normalized synthetic fact-value substring in a successfully completed answer; no semantic paraphrase credit.",
    },
    collaborationExperiment: {
      selection: "first six complex development cases in cohort order with at least two frozen points on T06",
      cases: collaborationCases.map((item, index) => ({ alias: collaborationAliases.get(item.caseId), caseId: item.caseId, targetTurn: "T06", expectedPoints: item.turns.find((turn) => matchesTurn(turn, "T06"))!.expectedComplexityPointIds })),
      pairedCaseCount: collaborationCases.length,
      baselineCapabilities: { memory: false, rag: false, collaboration: false },
      treatmentCapabilities: { memory: false, rag: false, collaboration: true },
      targetContext: "Fresh Encounter session with the same synthetic profile/current prompt per arm; no earlier Encounter transcript, AMA memory, or RAG.",
      scorer: "Separate gpt-6-luna chat-completions context with randomized X/Y labels and fixed key-point rubric; model-assisted, not clinical review.",
    },
    outputs: {
      attemptsMetadata: "attempts-metadata.jsonl",
      memoryTargetsPrivate: "memory-targets-private.jsonl",
      collaborationTargetsPrivate: "collaboration-targets-private.jsonl",
      scorerPacketPrivate: "collaboration-blind-packet-private.json",
      scorerOutputPrivate: "collaboration-blind-score-private.json",
      summary: "summary.json",
    },
  };
  await writeFile(resolve(outputDir, "protocol.json"), `${JSON.stringify(protocol, null, 2)}\n`, "utf8");

  const model = readModelConfiguration();
  if (model.modelId !== "gpt-6-luna" || model.baseUrl !== BRIDGE_URL) throw new Error("B3 preflight requires the configured GPT-6-Luna loopback bridge.");
  const route = await checkHealthEngineRoute(model);
  await new MemoryClient({ baseUrl: HEALTH_ENGINE_URL }).health();
  if (!route.memoryRecallIsolation || route.healthEngineSourceSha256.length !== 64) throw new Error("Health Engine isolation/source attestation failed.");
  await writeFile(resolve(outputDir, "preflight.json"), `${JSON.stringify({ checkedAt: new Date().toISOString(), model: model.modelId, modelBackend: "codex-app-server", healthEngineUrl: HEALTH_ENGINE_URL, route, memoryHealth: "ok" }, null, 2)}\n`, "utf8");

  const memoryRunId = `${runId}-memory`;
  const memorySingle = await runMemoryArm({ phaseRunId: memoryRunId, arm: "single-agent", cases: memoryCases, aliases: memoryAliases, attemptsPath, targetsPath: memoryTargetsPath });
  const memoryIntegrated = await runMemoryArm({ phaseRunId: memoryRunId, arm: "integrated", cases: memoryCases, aliases: memoryAliases, attemptsPath, targetsPath: memoryTargetsPath });
  const memoryTargets = { "single-agent": memorySingle.filter((row) => row.eligibleHistoricalFactIds.length), integrated: memoryIntegrated.filter((row) => row.eligibleHistoricalFactIds.length) };
  const memorySummary = aggregateMemory({ cases: memoryCases, targetsByArm: memoryTargets, aliasByCase: memoryAliases });

  const collaborationRunId = `${runId}-collaboration`;
  const collabSingle = await runCollaborationArm({ phaseRunId: collaborationRunId, arm: "single-agent", cases: collaborationCases, aliases: collaborationAliases, attemptsPath, targetsPath: collaborationTargetsPath });
  const collabIntegrated = await runCollaborationArm({ phaseRunId: collaborationRunId, arm: "integrated", cases: collaborationCases, aliases: collaborationAliases, attemptsPath, targetsPath: collaborationTargetsPath });
  const collabTargets = [...collabSingle, ...collabIntegrated];
  const blind = deterministicBlindPacket(`${runId}-complex-score`, collabTargets, collaborationCases);
  await writeFile(resolve(outputDir, "collaboration-blind-packet-private.json"), `${JSON.stringify(blind.packet, null, 2)}\n`, "utf8");
  const scorerResult = await runBlindScorer(blind.packet);
  await writeFile(resolve(outputDir, "collaboration-blind-score-private.json"), `${JSON.stringify(scorerResult, null, 2)}\n`, "utf8");
  const collaborationSummary = summarizeCollaboration({ cases: collaborationCases, targets: collabTargets, score: scorerResult.output, unblind: blind.unblind });
  const summary = {
    schemaVersion: "huiyi-resume-b3-isolated-result/v1",
    studyRunId: runId,
    status: scorerResult.responseStatus === 200 && scorerResult.output ? "completed" : "scorer-incomplete",
    source: { gitRevision: sourceFingerprint.gitRevision, sourceFingerprintSha256: sourceFingerprint.sourceSha256, driverScriptSha256: scriptSha256, cohortSha256: sha256(cohortBytes) },
    completedAt: new Date().toISOString(),
    model: "gpt-6-luna via loopback Codex app-server bridge",
    memoryExperiment: memorySummary,
    collaborationExperiment: { ...collaborationSummary, scorerHttpStatus: scorerResult.responseStatus },
    preflight: { status: "passed", ragCapabilitiesDisabledInBothArms: true, memoryHealth: "ok", healthEngineSourceAttested: true },
    privateEvidenceFiles: Object.values(protocol.outputs),
    privacy: "Raw synthetic prompts and answers remain under the git-ignored private run directory; this summary stores IDs/counts only except short blind-score evidence anchors.",
  };
  await writeFile(resolve(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ runId, status: summary.status, memory: { facts: memorySummary.historicalFactOpportunityCount, single: memorySummary.byArm["single-agent"].targetHistoricalFactEcho, integrated: memorySummary.byArm.integrated.targetHistoricalFactEcho }, collaboration: collaborationSummary.differencePercentagePoints === null ? "unscored" : { single: collaborationSummary.byArm["single-agent"].keyPointCoverage, integrated: collaborationSummary.byArm.integrated.keyPointCoverage, deltaPp: collaborationSummary.differencePercentagePoints }, privateOutput: outputDir }, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`B3 isolated evaluation failed: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}\n`);
  process.exitCode = 1;
});
