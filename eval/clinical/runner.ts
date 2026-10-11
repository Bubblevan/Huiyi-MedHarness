import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dshAgentSessionId } from "../../services/demo-gateway/src/backends/dsh.js";
import type { DemoEvent, RagRetrievalTelemetry } from "../../services/demo-gateway/src/contracts.js";
import { readModelConfiguration, syntheticPatientMemoryId } from "../../services/demo-gateway/src/backends/dsh-runtime.js";
import { MemoryClient } from "../../src/memory/client.js";
import type { MemoryRecallEvidenceRecord, MemoryTraceRecord } from "../../src/memory/contracts.js";
import { RagClient } from "../../src/rag/client.js";
import { AuthenticatedClinicalGateway } from "./authenticated-gateway.js";
import { TASKS } from "./catalog.js";
import { validateSyntheticCase } from "./cohort.js";
import { attestCodexBridgeHealth } from "./bridge-attestation.js";
import { createReviewDraftBundle } from "./fhir-draft.js";
import { makeBlindReviewPacket, type ClinicalBlindReviewPacket, type ClinicalReviewKeyEntry } from "./blind-review.js";
import { createReviewTemplate } from "./scoring.js";
import type { ClinicalMemoryRecallFact, ClinicalReviewRecord, ClinicalRunRecord, EvalArm, PatientQuestionIntent, PatientSimulationMode, SyntheticClinicalCase, SyntheticTurn } from "./contracts.js";
import { SyntheticPatientSimulator } from "./patient-simulator.js";
import { captureHealthEngineSourceFingerprint } from "./source-fingerprint.js";

export interface ClinicalRunnerOptions {
  readonly studyRunId?: string;
  readonly authorizationCases?: readonly SyntheticClinicalCase[];
  readonly completedTaskKeys?: readonly string[];
  readonly arms?: readonly EvalArm[];
  readonly concurrency?: number;
  readonly turnTimeoutMs?: number;
  readonly modelReadyCheck?: boolean;
  readonly healthEngineCheck?: boolean;
  readonly patientSimulationMode?: PatientSimulationMode;
  readonly patientFollowUpLimit?: number;
  readonly onRecord?: (record: ClinicalRunRecord) => void | Promise<void>;
  readonly onDraftBundle?: (draft: { runId: string; caseId: string; turnId: string; arm: EvalArm; bundle: unknown }) => void | Promise<void>;
}

export interface ClinicalRunnerResult {
  readonly studyRunId: string;
  readonly model: string;
  readonly modelBackend: string;
  readonly patientSimulationMode: PatientSimulationMode;
  readonly patientFollowUpLimit: number | null;
  readonly healthEngineRoute?: {
    readonly amaModel: string;
    readonly amaEndpoint: string;
    readonly ragPlannerModel: string;
    readonly ragPlannerEndpoint: string;
    readonly ragEnabled: boolean;
    readonly memoryRecallIsolation: boolean;
    readonly embeddingModel: string | null;
    readonly healthEngineSourceSha256: string;
    readonly bridgeMaxConcurrentTurns: number;
  };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly records: readonly ClinicalRunRecord[];
  readonly reviews: readonly ClinicalReviewRecord[];
  readonly reviewPackets: readonly ClinicalBlindReviewPacket[];
  readonly draftBundles: readonly unknown[];
  readonly unblindKey: Readonly<Record<EvalArm, "A" | "B">>;
  readonly reviewKey: readonly ClinicalReviewKeyEntry[];
}

interface RunTask { readonly case: SyntheticClinicalCase; readonly arm: EvalArm }
type ReviewEvidence = ClinicalBlindReviewPacket["evidenceMetadata"];
interface CaseArmResult {
  readonly records: ClinicalRunRecord[];
  readonly draftBundles: { runId: string; caseId: string; turnId: string; arm: EvalArm; bundle: unknown }[];
  readonly reviewEvidenceByRun: ReadonlyMap<string, ReviewEvidence>;
}

export async function runClinicalBenchmark(cases: readonly SyntheticClinicalCase[], options: ClinicalRunnerOptions = {}): Promise<ClinicalRunnerResult> {
  if (!cases.length) throw new RangeError("at least one synthetic case is required");
  for (const item of cases) validateSyntheticCase(item);
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length) throw new TypeError("cohort case IDs must be unique");
  if (isProduction()) throw new Error("clinical synthetic evaluation cannot run in a production environment");
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new RangeError("concurrency must be between 1 and 8");
  const arms = options.arms ?? ["single-agent", "integrated"];
  if (!arms.length || new Set(arms).size !== arms.length || arms.some((arm) => !["single-agent", "integrated"].includes(arm))) throw new TypeError("invalid run arms");
  const patientSimulationMode = options.patientSimulationMode ?? "scripted";
  if (patientSimulationMode !== "scripted" && patientSimulationMode !== "adaptive") throw new TypeError("invalid patient simulation mode");
  if (patientSimulationMode === "adaptive" && cases.some((item) => item.turns.some((turn) => !turn.patientPlan))) {
    throw new TypeError("adaptive patient simulation requires a patientPlan for every turn in the cohort");
  }
  if (options.patientFollowUpLimit !== undefined && (!Number.isSafeInteger(options.patientFollowUpLimit) || options.patientFollowUpLimit < 0 || options.patientFollowUpLimit > 5)) {
    throw new RangeError("patient follow-up limit must be between 0 and 5");
  }
  if (options.patientFollowUpLimit !== undefined && patientSimulationMode !== "adaptive") throw new TypeError("patient follow-up limit only applies to adaptive patient simulation");
  if (patientSimulationMode === "adaptive" && options.patientFollowUpLimit !== undefined && cases.some((item) => item.turns.some((turn) => options.patientFollowUpLimit! > turn.patientPlan!.maxFollowUpMessages))) {
    throw new RangeError("patient follow-up limit cannot exceed a turn's frozen cohort plan");
  }
  const modelBackend = process.env.HUIYI_DEMO_MODEL_BACKEND?.trim() || "vllm";
  if (modelBackend !== "codex-app-server") throw new Error("This clinical evaluation profile is pinned to Codex GPT-6-Luna; local Qwen generation is disabled.");
  const model = readModelConfiguration();
  if (model.modelId !== "gpt-6-luna") throw new Error("This clinical evaluation profile requires the Codex bridge model gpt-6-luna.");
  const bridgeMaxConcurrentTurns = options.modelReadyCheck !== false ? await checkModelRoute(model) : undefined;
  const healthEngineRoute = arms.includes("integrated") && options.healthEngineCheck !== false
    ? await checkHealthEngineRoute(model, bridgeMaxConcurrentTurns)
    : undefined;
  if (arms.includes("integrated") && process.env.HUIYI_DEMO_SYNTHETIC_AMA_MEMORY?.trim() !== "1") {
    throw new Error("Integrated arm requires HUIYI_DEMO_SYNTHETIC_AMA_MEMORY=1; this enables only pseudonymous synthetic-patient memory.");
  }
  const startedAt = new Date().toISOString();
  const studyRunId = options.studyRunId ?? `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const originalAppEnv = process.env.HUIYI_APP_ENV;
  process.env.HUIYI_APP_ENV = "clinical-evaluation";
  const armServices = new Map<EvalArm, AuthenticatedClinicalGateway>();
  try {
    const authorizationCases = options.authorizationCases ?? cases;
    for (const arm of arms) {
      const gateway = new AuthenticatedClinicalGateway({ studyRunId, arm, cases: authorizationCases, concurrency });
      armServices.set(arm, gateway);
      await gateway.start();
    }

    const completedTaskKeys = new Set(options.completedTaskKeys ?? []);
    const tasks = cases.flatMap((item) => arms
      .filter((arm) => !completedTaskKeys.has(clinicalTaskKey(item.caseId, arm)))
      .map((arm) => ({ case: item, arm })));
    const recordsByTask = await mapLimit(tasks, concurrency, async (task) => {
      const service = armServices.get(task.arm)!;
      return runCaseArm({
        studyRunId, task, service, modelName: model.modelId,
        patientSimulationMode,
        patientFollowUpLimit: options.patientFollowUpLimit,
        turnTimeoutMs: options.turnTimeoutMs ?? 300_000,
        onRecord: options.onRecord,
        onDraftBundle: options.onDraftBundle,
      });
    });
    const records = recordsByTask.flatMap((row) => row.records);
    const drafts = recordsByTask.flatMap((row) => row.draftBundles);
    const reviewEvidenceByRun = new Map(recordsByTask.flatMap((row) => [...row.reviewEvidenceByRun.entries()]));
    const exportedRunIds = new Set(drafts.map((row) => row.runId));
    const unblindKey = makeUnblindKey(studyRunId);
    const reviews: ClinicalReviewRecord[] = [];
    const reviewPackets: ClinicalBlindReviewPacket[] = [];
    const reviewKey: ClinicalReviewKeyEntry[] = [];
    const recordsByKey = new Map(records.map((record) => [`${record.caseId}\0${record.turnId}\0${record.arm}`, record]));
    for (const item of cases) {
      const conversations = new Map(arms.map((arm) => [arm, [] as { role: "patient" | "assistant"; text: string }[]]));
      for (const turn of item.turns) {
        const turnRuns = new Map<EvalArm, ClinicalRunRecord>();
        for (const arm of arms) {
          const run = recordsByKey.get(`${item.caseId}\0${turn.turnId}\0${arm}`);
          if (!run) continue;
          turnRuns.set(arm, run);
          const review = createReviewTemplate({
            run, case: item, turn, blindedArm: unblindKey[arm], draftExported: exportedRunIds.has(run.runId),
          });
          reviews.push(review);
          const packetId = `RPK-${createHash("sha256").update(`${studyRunId}\0${item.caseId}\0${turn.turnId}\0${arm}`).digest("hex").slice(0, 24)}`;
          reviewPackets.push(makeBlindReviewPacket({
            packetId, blindedArm: unblindKey[arm], case: item, turn, review,
            patientMessage: run.patientMessage,
            conversationSoFar: [...conversations.get(arm)!, ...runTranscript(run, turn.patientMessage)],
            assistantText: run.assistantText, evidenceMetadata: reviewEvidenceByRun.get(run.runId) ?? [],
          }));
          reviewKey.push({ packetId, runId: run.runId, caseId: run.caseId, turnId: run.turnId, actualArm: run.arm, blindedArm: unblindKey[arm] });
        }
        for (const arm of arms) {
          const conversation = conversations.get(arm)!;
          const run = turnRuns.get(arm);
          conversation.push(...(run ? runTranscript(run, turn.patientMessage) : [{ role: "patient" as const, text: turn.patientMessage }]));
        }
      }
    }
    return {
      studyRunId, model: model.modelId, modelBackend: process.env.HUIYI_DEMO_MODEL_BACKEND?.trim() || "vllm", patientSimulationMode,
      patientFollowUpLimit: options.patientFollowUpLimit ?? null,
      ...(healthEngineRoute ? { healthEngineRoute } : {}),
      startedAt, finishedAt: new Date().toISOString(), records, reviews, reviewPackets, draftBundles: drafts,
      unblindKey, reviewKey,
    };
  } finally {
    await Promise.all([...armServices.values()].map((gateway) => gateway.dispose().catch(() => undefined)));
    if (originalAppEnv === undefined) delete process.env.HUIYI_APP_ENV;
    else process.env.HUIYI_APP_ENV = originalAppEnv;
  }
}

async function runCaseArm(input: {
  studyRunId: string;
  task: RunTask;
  service: AuthenticatedClinicalGateway;
  modelName: string;
  patientSimulationMode: PatientSimulationMode;
  patientFollowUpLimit?: number;
  turnTimeoutMs: number;
  onRecord?: (record: ClinicalRunRecord) => void | Promise<void>;
  onDraftBundle?: (draft: { runId: string; caseId: string; turnId: string; arm: EvalArm; bundle: unknown }) => void | Promise<void>;
}): Promise<CaseArmResult> {
  const { task, service } = input;
  const identity = service.identityFor(task.case);
  const records: ClinicalRunRecord[] = [];
  const draftBundles: { runId: string; caseId: string; turnId: string; arm: EvalArm; bundle: unknown }[] = [];
  const reviewEvidenceByRun = new Map<string, ReviewEvidence>();
  const patientSimulator = input.patientSimulationMode === "adaptive" ? new SyntheticPatientSimulator(task.case, { maxFollowUpMessages: input.patientFollowUpLimit }) : undefined;
  const cumulativeDisclosedFactIds = new Set<string>();
  const encounterDisclosedFactIds = new Set<string>();
  const priorEncounterDisclosedFactIds = new Set<string>();
  let sessionId = "";
  let sessionTurn = 0;
  let encounter = "";
  const closeCurrentSession = async (): Promise<void> => {
    if (!sessionId) return;
    const closing = sessionId;
    sessionId = "";
    await service.closeEncounterSession(task.case, closing);
  };
  try {
    if (task.arm === "integrated") {
      await new MemoryClient().forget({
        userId: syntheticPatientMemoryId(identity.patientId, identity.tenantId),
        confirmation: "forget all patient memory",
      });
    }
    for (const turn of task.case.turns) {
      if (turn.encounterId !== encounter) {
        encounterDisclosedFactIds.forEach((id) => priorEncounterDisclosedFactIds.add(id));
        await closeCurrentSession();
        encounter = turn.encounterId;
        encounterDisclosedFactIds.clear();
        sessionId = await service.createEncounterSession(task.case, turn.encounterId);
        sessionTurn = 0;
      }
      const runId = `${task.case.caseId}-${task.arm}-${turn.turnId}-${randomUUID().slice(0, 8)}`;
      const startedAt = new Date().toISOString();
      const startedMs = performance.now();
      const answer: string[] = [];
      const patientMessages: string[] = [];
      const transcript: { role: "patient" | "assistant"; text: string }[] = [];
      const disclosedFactIds = new Set<string>();
      const triggeredIntents = new Set<PatientQuestionIntent>();
      let assistantExchanges = 0;
      let patientFollowUps = 0;
      const evidence: ClinicalRunRecord["evidence"][number][] = [];
      const ragRetrievals: RagRetrievalTelemetry[] = [];
      const evidenceForReview: ReviewEvidence[number][] = [];
      const toolCalls: { tool: string; status: "started" | "completed" | "failed"; durationMs?: number }[] = [];
      let collaboration: ClinicalRunRecord["collaboration"];
      let status: ClinicalRunRecord["status"] = "failed";
      let failureCode: string | undefined;
      let failureDiagnostic: ClinicalRunRecord["failureDiagnostic"];
      let dshDurationMs: number | undefined;
      const providerRunIds: string[] = [];
      let turnMemoryStart = sessionTurn + 1;
      let turnMemoryEnd = sessionTurn;
      try {
        const signal = AbortSignal.timeout(input.turnTimeoutMs);
        const logicalTurnStart = sessionTurn + 1;
        const message = patientSimulator ? patientSimulator.startTurn(turn) : undefined;
        if (message) {
          patientMessages.push(message.message);
          transcript.push({ role: "patient", text: message.message });
          message.disclosedFactIds.forEach((id) => {
            disclosedFactIds.add(id); encounterDisclosedFactIds.add(id); cumulativeDisclosedFactIds.add(id);
          });
        } else {
          patientMessages.push(turn.patientMessage);
          transcript.push({ role: "patient", text: turn.patientMessage });
          for (const id of explicitlyMentionedFactIds(task.case, turn.patientMessage)) {
            disclosedFactIds.add(id);
            encounterDisclosedFactIds.add(id);
            cumulativeDisclosedFactIds.add(id);
          }
        }
        let nextPatientMessage = message?.message ?? turn.patientMessage;
        for (;;) {
          sessionTurn++;
          turnMemoryEnd = sessionTurn;
          const exchangeAnswer: string[] = [];
          assistantExchanges++;
          const execution = await service.runTurn({
            sessionId, patientId: identity.patientId, encounterId: turn.encounterId,
            message: nextPatientMessage, signal,
          });
          providerRunIds.push(execution.runId);
          for (const event of execution.events) {
            if (event.event === "assistant.delta") exchangeAnswer.push(event.data.text);
            else if (event.event === "evidence.item") {
              evidence.push({ evidenceId: event.data.evidenceId, source: event.data.source, title: event.data.title, rank: event.data.rank });
              evidenceForReview.push({ evidenceId: event.data.evidenceId, source: event.data.source, title: event.data.title, rank: event.data.rank, snippet: event.data.snippet.slice(0, 500) });
            }
            else if (event.event === "tool.started") toolCalls.push({ tool: event.data.tool, status: "started" });
            else if (event.event === "tool.completed") {
              const pending = [...toolCalls].reverse().find((call) => call.tool === event.data.tool && call.status === "started");
              if (pending) { pending.status = event.data.status; pending.durationMs = event.data.durationMs; }
              else toolCalls.push({ tool: event.data.tool, status: event.data.status, durationMs: event.data.durationMs });
            } else if (event.event === "collaboration.completed") {
              const childRuns = event.data.completedChildRuns + event.data.failedChildRuns;
              collaboration = collaboration
                ? { complexity: event.data.complexity, childRuns: collaboration.childRuns + childRuns, failedChildRuns: collaboration.failedChildRuns + event.data.failedChildRuns, degraded: collaboration.degraded || event.data.degraded }
                : { complexity: event.data.complexity, childRuns, failedChildRuns: event.data.failedChildRuns, degraded: event.data.degraded };
            } else if (event.event === "run.completed") { status = "completed"; dshDurationMs = (dshDurationMs ?? 0) + event.data.durationMs; }
            else if (event.event === "run.cancelled") status = "cancelled";
            else if (event.event === "run.failed") {
              status = "failed";
              failureCode = event.data.code;
              failureDiagnostic = event.data.diagnostic;
            }
          }
          ragRetrievals.push(...extractRagRetrievalTelemetry(execution.events));
          if (execution.incomplete && status !== "completed" && status !== "cancelled") {
            status = "failed";
            failureCode = execution.incomplete === "timeout" ? "TURN_TIMEOUT"
              : execution.incomplete === "aborted" ? "TURN_ABORTED" : "GATEWAY_STREAM_INCOMPLETE";
            if (execution.incomplete === "timeout") failureDiagnostic = { category: "timeout" };
          }
          const exchangeText = exchangeAnswer.join("");
          answer.push(exchangeText);
          if (exchangeText) transcript.push({ role: "assistant", text: exchangeText });
          if (status !== "completed" || !patientSimulator) break;
          const reply = patientSimulator.respondToAssistant(exchangeText);
          if (!reply) break;
          patientMessages.push(reply.message);
          transcript.push({ role: "patient", text: reply.message });
          reply.disclosedFactIds.forEach((id) => {
            disclosedFactIds.add(id); encounterDisclosedFactIds.add(id); cumulativeDisclosedFactIds.add(id);
          });
          reply.matchedIntents.forEach((intent) => triggeredIntents.add(intent));
          patientFollowUps++;
          nextPatientMessage = reply.message;
        }
        // Keep AMA trace attribution aligned with all DSH messages in this benchmark turn.
        turnMemoryStart = logicalTurnStart;
        turnMemoryEnd = sessionTurn;
      } catch (error) {
        status = "failed";
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        failureCode = timedOut ? "TURN_TIMEOUT" : "AUTHENTICATED_GATEWAY_EXCEPTION";
        failureDiagnostic = { category: timedOut ? "timeout" : "unknown" };
      }
      const usageRows = providerRunIds.map((providerRunId) => service.usage.get(providerRunId)).filter((usage) => usage !== undefined);
      const reportedTokenUsage = usageRows.length ? aggregateTokenUsage(usageRows) : undefined;
      const collaborationRequested = toolCalls.some((call) => call.tool === "consult_clinical_team");
      const dshSessionId = dshAgentSessionId(sessionId, identity.patientId, turn.encounterId);
      const tokenUsage: ClinicalRunRecord["tokenUsage"] = reportedTokenUsage
        ? {
          ...reportedTokenUsage,
          ...(collaboration
            ? {
              subagentSessionsExpected: collaboration.childRuns,
              subagentAttributionComplete: reportedTokenUsage.subagentSessionsObserved === collaboration.childRuns,
            }
            : collaborationRequested
              ? { subagentAttributionComplete: false }
              : { subagentSessionsExpected: 0, subagentAttributionComplete: reportedTokenUsage.subagentSessionsObserved === 0 }),
        }
        : {
          scope: "unavailable",
          ...(collaborationRequested ? { subagentAttributionComplete: false } : {}),
        };
      const record: ClinicalRunRecord = {
        schemaVersion: "huiyi-clinical-eval/v1", recordType: "turn-run", runId,
        caseId: task.case.caseId, turnId: turn.turnId, clinicalReviewStatus: task.case.clinicalReviewStatus, arm: task.arm,
        model: input.modelName, patientMessage: patientMessages.join("\n"),
        patientSimulation: {
          mode: input.patientSimulationMode, assistantExchanges, patientFollowUps,
          maxPatientFollowUps: patientSimulator ? (input.patientFollowUpLimit ?? turn.patientPlan!.maxFollowUpMessages) : 0,
          disclosedFactIds: [...disclosedFactIds], cumulativeDisclosedFactIds: [...cumulativeDisclosedFactIds],
          encounterDisclosedFactIds: [...encounterDisclosedFactIds],
          amaRecallEligibleFactIds: turn.requiredHistoricalFactIds.filter((id) => priorEncounterDisclosedFactIds.has(id)),
          triggeredIntents: [...triggeredIntents], transcript,
        },
        assistantText: answer.filter(Boolean).join("\n\n"), status,
        ...(failureCode ? { failureCode } : {}), ...(failureDiagnostic ? { failureDiagnostic } : {}), wallTimeMs: Math.max(0, performance.now() - startedMs),
        ...(dshDurationMs === undefined ? {} : { dshDurationMs }), startedAt,
        evidence, ...(ragRetrievals.length ? { ragRetrievals } : {}), toolCalls, ...(collaboration ? { collaboration } : {}),
        tokenUsage,
        ...(task.arm === "integrated" ? {
          memoryUsage: {
            ...summarizeMemoryUsage(service.memoryTrace.filter((entry) =>
              entry.sessionId === dshSessionId && entry.turn !== undefined && entry.turn >= turnMemoryStart && entry.turn <= turnMemoryEnd)),
            recalledFacts: summarizeRecallFacts(
              service.takeMemoryRecallEvidence(dshSessionId, turnMemoryStart, turnMemoryEnd),
              task.case.facts,
              answer.filter(Boolean).join("\n\n"),
            ),
          },
        } : {}),
      };
      records.push(record);
      reviewEvidenceByRun.set(runId, evidenceForReview);
      await input.onRecord?.(record);
      if (turn.expectedTaskIds.includes(TASKS.draft) && status === "completed" && record.assistantText.trim()) {
        const draft = { runId, caseId: task.case.caseId, turnId: turn.turnId, arm: task.arm, bundle: createReviewDraftBundle({ case: task.case, turn, run: record }) };
        draftBundles.push(draft);
        await input.onDraftBundle?.(draft);
      }
    }
  } finally {
    let closeError: unknown;
    try { await closeCurrentSession(); } catch (error) { closeError = error; }
    let forgetError: unknown;
    if (task.arm === "integrated") {
      try {
        await new MemoryClient().forget({ userId: syntheticPatientMemoryId(identity.patientId, identity.tenantId), confirmation: "forget all patient memory" });
      } catch (error) { forgetError = error; }
    }
    if (closeError || forgetError) throw new Error(`synthetic run cleanup failed for ${task.case.caseId}: ${[closeError, forgetError].filter(Boolean).map((error) => error instanceof Error ? error.name : "unknown error").join(", ")}`);
  }
  return { records, draftBundles, reviewEvidenceByRun };
}

function explicitlyMentionedFactIds(item: SyntheticClinicalCase, message: string): string[] {
  return item.facts
    .filter((fact) => fact.value !== item.patient.privateIsolationCanary && fact.value.trim().length > 0 && message.includes(fact.value))
    .map((fact) => fact.factId);
}

export function clinicalTaskKey(caseId: string, arm: EvalArm): string { return `${caseId}\0${arm}`; }

export function extractRagRetrievalTelemetry(events: readonly DemoEvent[]): RagRetrievalTelemetry[] {
  return events.flatMap((event) => event.event === "evidence.completed" && event.data.retrieval ? [event.data.retrieval] : []);
}

async function checkModelRoute(model: ReturnType<typeof readModelConfiguration>): Promise<number | undefined> {
  const key = process.env[model.apiKeyEnv] ?? "";
  const response = await fetch(`${model.baseUrl}/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : undefined,
    signal: AbortSignal.timeout(12_000),
  }).catch((error: unknown) => { throw new Error(`Configured model route is unreachable (${error instanceof Error ? error.name : "network error"})`); });
  if (!response.ok) throw new Error(`Configured model route returned HTTP ${response.status} at /models`);
  const payload: unknown = await response.json().catch(() => undefined);
  if (typeof payload !== "object" || payload === null) throw new Error("Configured model route returned invalid /models JSON");
  if ((process.env.HUIYI_DEMO_MODEL_BACKEND?.trim() || "vllm") === "codex-app-server") {
    const models = (payload as { data?: unknown }).data;
    if (!Array.isArray(models) || !models.some((entry) => typeof entry === "object" && entry !== null && (entry as { id?: unknown }).id === model.modelId)) {
      throw new Error(`Codex bridge /models does not advertise the required ${model.modelId} model`);
    }
    return readCodexBridgeMaxConcurrentTurns(model.baseUrl, model.modelId);
  }
  return undefined;
}

async function readCodexBridgeMaxConcurrentTurns(baseUrl: string, modelId: string): Promise<number> {
  let healthUrl: URL;
  try { healthUrl = new URL("/healthz", baseUrl); }
  catch { throw new Error("Codex bridge health URL is invalid"); }
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) })
    .catch((error: unknown) => { throw new Error(`Codex bridge health attestation is unreachable (${error instanceof Error ? error.name : "network error"})`); });
  if (!response.ok) throw new Error(`Codex bridge health attestation returned HTTP ${response.status}`);
  const attestation = attestCodexBridgeHealth(await response.json().catch(() => undefined), modelId);
  if (attestation.status !== "matched" || attestation.maxConcurrentTurns === null) {
    throw new Error("Codex bridge health attestation is missing the expected model or bounded concurrency counters (maxConcurrentTurns must be 1–4); restart the current bridge before evaluation");
  }
  return attestation.maxConcurrentTurns;
}

export async function checkHealthEngineRoute(model: ReturnType<typeof readModelConfiguration>, bridgeMaxConcurrentTurns?: number): Promise<NonNullable<ClinicalRunnerResult["healthEngineRoute"]>> {
  if ((process.env.HUIYI_DEMO_MODEL_BACKEND?.trim() || "vllm") !== "codex-app-server") throw new Error("Clinical integrated evaluation requires HUIYI_DEMO_MODEL_BACKEND=codex-app-server");
  const attestedBridgeMaxConcurrentTurns = bridgeMaxConcurrentTurns ?? await readCodexBridgeMaxConcurrentTurns(model.baseUrl, model.modelId);
  const engineUrl = process.env.HUIYI_HEALTH_ENGINE_URL?.trim() || "http://127.0.0.1:8322";
  const response = await fetch(`${engineUrl}/_internal/evaluation/config`, { signal: AbortSignal.timeout(5000) })
    .catch((error: unknown) => { throw new Error(`Health Engine evaluation route config is unreachable (${error instanceof Error ? error.name : "network error"})`); });
  if (!response.ok) throw new Error(`Health Engine evaluation route config returned HTTP ${response.status}; enable it only on the isolated loopback evaluator`);
  const value: unknown = await response.json().catch(() => undefined);
  if (typeof value !== "object" || value === null) throw new Error("Health Engine evaluation route config returned invalid JSON");
  const route = value as Record<string, unknown>;
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const expectedSourceSha256 = await captureHealthEngineSourceFingerprint(repoRoot);
  if (route.healthEngineSourceSha256 !== expectedSourceSha256) {
    throw new Error("Health Engine runtime source fingerprint is missing or stale; restart the Health Engine before evaluation");
  }
  const expectedEndpoint = `${model.baseUrl}/chat/completions`;
  if (route.amaModel !== model.modelId || route.amaEndpoint !== expectedEndpoint
    || route.ragPlannerModel !== model.modelId || route.ragPlannerEndpoint !== expectedEndpoint
    || route.ragEnabled !== true || route.memoryRecallIsolation !== true || typeof route.embeddingModel !== "string") {
    throw new Error("Integrated GPT-6 evaluation requires AMA and RAG planner to use the pinned Codex bridge/model, isolated AMA recall windows, and local embeddings");
  }
  const memory = new MemoryClient();
  const rag = new RagClient();
  await Promise.all([memory.health(), rag.health()]);
  const probe = await rag.search({ query: "合成复诊的历史信息来源核对", mode: "single", topK: 1 });
  if (probe.retrieval.degraded) throw new Error("Local RAG readiness probe returned a degraded result");
  return {
    amaModel: route.amaModel as string,
    amaEndpoint: route.amaEndpoint as string,
    ragPlannerModel: route.ragPlannerModel as string,
    ragPlannerEndpoint: route.ragPlannerEndpoint as string,
    ragEnabled: true,
    memoryRecallIsolation: true,
    embeddingModel: route.embeddingModel as string,
    healthEngineSourceSha256: expectedSourceSha256,
    bridgeMaxConcurrentTurns: attestedBridgeMaxConcurrentTurns,
  };
}

function summarizeMemoryUsage(records: readonly MemoryTraceRecord[]): NonNullable<ClinicalRunRecord["memoryUsage"]> {
  const operationCounts: Record<string, number> = {};
  for (const record of records) operationCounts[record.operation] = (operationCounts[record.operation] ?? 0) + 1;
  return {
    scope: "health-engine-ama",
    traceRecords: records.length,
    llmCalls: records.reduce((sum, record) => sum + (record.amaLlmCallCount ?? 0), 0),
    promptTokens: records.reduce((sum, record) => sum + (record.amaPromptTokens ?? 0), 0),
    completionTokens: records.reduce((sum, record) => sum + (record.amaCompletionTokens ?? 0), 0),
    usageReports: records.reduce((sum, record) => sum + (record.amaUsageReportCount ?? 0), 0),
    retrievalRounds: records.reduce((sum, record) => sum + (record.retrievalRounds ?? 0), 0),
    failedOperations: records.filter((record) => record.status === "failed").length,
    operationCounts,
  };
}

function summarizeRecallFacts(records: readonly MemoryRecallEvidenceRecord[], facts: SyntheticClinicalCase["facts"], assistantText: string): readonly ClinicalMemoryRecallFact[] {
  const unique = new Map<string, ClinicalMemoryRecallFact>();
  const normalizedAnswer = assistantText.normalize("NFKC");
  const factById = new Map(facts.map((fact) => [fact.factId, fact] as const));
  for (const record of records) for (const item of record.items) for (const factId of item.factIds) {
    const key = [factId, item.kind, item.sourceId ?? "", record.operation, record.turn].join("\0");
    const fact = factById.get(factId);
    const echoedInAssistant = Boolean(fact && fact.value !== "" && normalizedAnswer.includes(fact.value.normalize("NFKC")));
    unique.set(key, { factId, kind: item.kind, ...(item.sourceId ? { sourceId: item.sourceId } : {}), operation: record.operation, turn: record.turn, echoedInAssistant });
  }
  return [...unique.values()].sort((left, right) => left.turn - right.turn || left.factId.localeCompare(right.factId));
}

function runTranscript(run: ClinicalRunRecord, fallbackPatientMessage: string): readonly { role: "patient" | "assistant"; text: string }[] {
  return run.patientSimulation?.transcript ?? [
    { role: "patient", text: run.patientMessage || fallbackPatientMessage },
    ...(run.assistantText ? [{ role: "assistant" as const, text: run.assistantText }] : []),
  ];
}

function aggregateTokenUsage(rows: readonly ClinicalRunRecord["tokenUsage"][]): ClinicalRunRecord["tokenUsage"] {
  const measured = rows.filter((row) => row.scope === "dsh-agent-tree");
  if (!measured.length) return { scope: "unavailable" };
  const sum = (key: keyof ClinicalRunRecord["tokenUsage"]): number | undefined => {
    const values = measured.map((row) => row[key]).filter((value): value is number => typeof value === "number");
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  return {
    scope: "dsh-agent-tree",
    ...(sum("inputTokens") === undefined ? {} : { inputTokens: sum("inputTokens") }),
    ...(sum("outputTokens") === undefined ? {} : { outputTokens: sum("outputTokens") }),
    ...(sum("totalTokens") === undefined ? {} : { totalTokens: sum("totalTokens") }),
    ...(sum("rootInputTokens") === undefined ? {} : { rootInputTokens: sum("rootInputTokens") }),
    ...(sum("rootOutputTokens") === undefined ? {} : { rootOutputTokens: sum("rootOutputTokens") }),
    ...(sum("rootTotalTokens") === undefined ? {} : { rootTotalTokens: sum("rootTotalTokens") }),
    ...(sum("subagentInputTokens") === undefined ? {} : { subagentInputTokens: sum("subagentInputTokens") }),
    ...(sum("subagentOutputTokens") === undefined ? {} : { subagentOutputTokens: sum("subagentOutputTokens") }),
    ...(sum("subagentTotalTokens") === undefined ? {} : { subagentTotalTokens: sum("subagentTotalTokens") }),
    ...(sum("subagentSessionsObserved") === undefined ? {} : { subagentSessionsObserved: sum("subagentSessionsObserved") }),
  };
}

export function makeUnblindKey(studyRunId: string): Readonly<Record<EvalArm, "A" | "B">> {
  const flip = Number.parseInt(createHash("sha256").update(studyRunId).digest("hex").slice(0, 2), 16) % 2 === 1;
  return {
    "single-agent": flip ? "B" : "A",
    integrated: flip ? "A" : "B",
  };
}

function isProduction(): boolean {
  return process.env.HUIYI_APP_ENV?.trim().toLowerCase() === "production" || process.env.NODE_ENV === "production";
}

async function mapLimit<T, R>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  let firstError: unknown;
  let failed = false;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      if (failed) return;
      const index = next++;
      if (index >= items.length) return;
      try { output[index] = await mapper(items[index]!); }
      catch (error) { if (!failed) firstError = error; failed = true; return; }
    }
  });
  await Promise.allSettled(workers);
  if (failed) throw firstError;
  return output;
}
