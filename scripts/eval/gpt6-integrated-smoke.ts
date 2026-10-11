import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthenticatedClinicalGateway } from "../../eval/clinical/authenticated-gateway.js";
import { generateCohort, validateSyntheticCase } from "../../eval/clinical/cohort.js";
import { TASKS } from "../../eval/clinical/catalog.js";
import { captureHealthEngineSourceFingerprint } from "../../eval/clinical/source-fingerprint.js";
import { summarizeCollaborationTrace } from "../../eval/clinical/collaboration-trace-summary.js";
import { attestCodexBridgeHealth } from "../../eval/clinical/bridge-attestation.js";
import { uniqueRagRetrievalTelemetry } from "../../eval/clinical/rag-telemetry.js";
import type { DemoEvent, RagRetrievalTelemetry } from "../../services/demo-gateway/src/contracts.js";
import { readModelConfiguration, syntheticPatientMemoryId } from "../../services/demo-gateway/src/backends/dsh-runtime.js";
import { MemoryClient } from "../../src/memory/client.js";
import { RagClient } from "../../src/rag/client.js";
import type { EvidenceSet, MedicalEvidenceClientPort } from "../../src/rag/contracts.js";
import { MetadataCollaborationTrace } from "../../src/collaboration/trace.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function main(): Promise<void> {
  process.env.HUIYI_APP_ENV = "clinical-evaluation";
  process.env.HUIYI_DEMO_MODEL_BACKEND = "codex-app-server";
  process.env.HUIYI_DEMO_CODEX_MODEL = "gpt-6-luna";
  process.env.HUIYI_CODEX_BRIDGE_URL ??= "http://127.0.0.1:8333/v1";
  process.env.HUIYI_CODEX_BRIDGE_API_KEY ??= "local-only";
  process.env.HUIYI_HEALTH_ENGINE_URL ??= "http://127.0.0.1:8325";
  process.env.HUIYI_DEMO_SYNTHETIC_AMA_MEMORY = "1";
  process.env.HUIYI_DEMO_MAX_TOKENS ??= "384";

  const model = readModelConfiguration();
  if (model.modelId !== "gpt-6-luna" || !model.baseUrl.startsWith("http://127.0.0.1:")) {
    throw new Error("Smoke profile requires the local Codex GPT-6-Luna bridge.");
  }
  const bridgeHealthResponse = await fetch(new URL("/healthz", model.baseUrl), { signal: AbortSignal.timeout(5000) })
    .catch((error: unknown) => { throw new Error(`Codex bridge health attestation is unreachable (${error instanceof Error ? error.name : "network error"})`); });
  if (!bridgeHealthResponse.ok) throw new Error(`Codex bridge health attestation returned HTTP ${bridgeHealthResponse.status}.`);
  const bridgeAttestation = attestCodexBridgeHealth(await bridgeHealthResponse.json().catch(() => undefined), model.modelId);
  if (bridgeAttestation.status !== "matched" || bridgeAttestation.maxConcurrentTurns === null) {
    throw new Error("Codex bridge health attestation is missing the expected model or bounded concurrency counters (maxConcurrentTurns must be 1–4). Restart the current bridge before smoke evaluation.");
  }
  const engineUrl = process.env.HUIYI_HEALTH_ENGINE_URL;
  const [memoryHealth, ragHealth, ragProbe, routeResponse] = await Promise.all([
    new MemoryClient().health(),
    new RagClient().health(),
    new RagClient().search({ query: "合成复诊的既往资料来源核对", mode: "single", topK: 1 }),
    fetch(`${engineUrl}/_internal/evaluation/config`, { signal: AbortSignal.timeout(5000) }),
  ]);
  if (ragProbe.retrieval.degraded) throw new Error("Local five-source RAG readiness probe was degraded.");
  if (!routeResponse.ok) throw new Error(`Health Engine route attestation returned HTTP ${routeResponse.status}.`);
  const route = await routeResponse.json() as Record<string, unknown>;
  const healthEngineSourceSha256 = await captureHealthEngineSourceFingerprint(root);
  if (route.healthEngineSourceSha256 !== healthEngineSourceSha256) {
    throw new Error("Health Engine runtime source fingerprint is missing or stale; restart the Health Engine before smoke evaluation.");
  }
  const expectedEndpoint = `${model.baseUrl}/chat/completions`;
  if (route.amaModel !== "gpt-6-luna" || route.amaEndpoint !== expectedEndpoint ||
      route.ragPlannerModel !== "gpt-6-luna" || route.ragPlannerEndpoint !== expectedEndpoint ||
      route.ragEnabled !== true || route.memoryRecallIsolation !== true || route.embeddingModel !== "Qwen3-Embedding-0.6B") {
    throw new Error("Health Engine AMA/RAG route is not pinned to GPT-6-Luna with isolated memory recall and local Qwen3 embeddings.");
  }

  const cohort = generateCohort({ count: 300, seed: 20261010 });
  const item = cohort.find((candidate) => candidate.complexity === "complex" &&
    candidate.turns[5]?.expectedRiskSignalIds.length > 0 &&
    candidate.turns[6]?.expectedTaskIds.includes(TASKS.evidence));
  if (!item) throw new Error("No synthetic complex case has consecutive risk and evidence turns for the smoke run.");
  validateSyntheticCase(item);
  const focus = process.env.HUIYI_GPT6_SMOKE_FOCUS?.trim().toLowerCase();
  if (focus && focus !== "evidence" && focus !== "safety" && focus !== "integrated") {
    throw new TypeError("HUIYI_GPT6_SMOKE_FOCUS must be evidence, safety, or integrated when set");
  }
  const requireCollaborationRouting = process.env.HUIYI_GPT6_SMOKE_REQUIRE_COLLABORATION === "1";
  const requireAdvancedCollaboration = process.env.HUIYI_GPT6_SMOKE_REQUIRE_ADVANCED_COLLABORATION === "1";
  if (requireCollaborationRouting && focus !== "safety" && focus !== "integrated") {
    throw new TypeError("HUIYI_GPT6_SMOKE_REQUIRE_COLLABORATION=1 requires HUIYI_GPT6_SMOKE_FOCUS=safety or integrated");
  }
  if (requireAdvancedCollaboration && (!requireCollaborationRouting || (focus !== "safety" && focus !== "integrated"))) {
    throw new TypeError("HUIYI_GPT6_SMOKE_REQUIRE_ADVANCED_COLLABORATION=1 requires collaboration routing and safety or integrated focus");
  }
  const requestedRagMode = process.env.HUIYI_GPT6_SMOKE_RAG_MODE?.trim().toLowerCase();
  if (requestedRagMode && requestedRagMode !== "single" && requestedRagMode !== "iterative") {
    throw new TypeError("HUIYI_GPT6_SMOKE_RAG_MODE must be single or iterative when set");
  }
  if (requestedRagMode === "iterative" && focus !== "evidence" && focus !== "integrated") {
    throw new TypeError("Iterative RAG smoke must set HUIYI_GPT6_SMOKE_FOCUS=evidence or integrated to bound model calls.");
  }
  const turns = focus === "evidence"
    ? [item.turns[6]!]
    : focus === "safety" ? [item.turns[5]!] : [item.turns[5]!, item.turns[6]!];
  if (focus === "integrated") process.env.HUIYI_MEMORY_COMMIT_BATCH_TURNS ??= "2";
  const forcedCollaborationTurnId = requireCollaborationRouting ? turns[0]!.turnId : undefined;
  const ragExecutions: Record<string, unknown>[] = [];
  const ragClient = new RagClient();
  const evidenceClient: MedicalEvidenceClientPort = {
    health: (options) => ragClient.health(options),
    async search(request, options): Promise<EvidenceSet> {
      const result = await ragClient.search(request, options);
      ragExecutions.push({
        requestedMode: request.mode ?? "deployment-default",
        effectiveMode: result.mode,
        queryLength: result.query.length,
        querySha256: createHash("sha256").update(result.query).digest("hex"),
        plannerModel: result.retrieval.plannerModel,
        plannerPromptVersion: result.retrieval.plannerPromptVersion,
        rounds: result.retrieval.rounds,
        generatedQueries: result.retrieval.generatedQueries,
        retrievalCalls: result.retrieval.retrievalCalls,
        plannerCalls: result.retrieval.plannerCalls,
        candidateCount: result.retrieval.candidateCount,
        uniqueDocuments: result.retrieval.uniqueDocuments,
        returnedEvidenceCount: result.retrieval.returnedEvidenceCount,
        retrievalLatencyMs: result.retrieval.retrievalLatencyMs,
        plannerLatencyMs: result.retrieval.plannerLatencyMs,
        totalLatencyMs: result.retrieval.latencyMs,
        plannerInputTokens: result.retrieval.plannerInputTokens,
        plannerOutputTokens: result.retrieval.plannerOutputTokens,
        estimatedContextTokens: result.retrieval.estimatedContextTokens,
        degraded: result.retrieval.degraded,
        degradedErrorClass: result.retrieval.degradedErrorClass,
        corpusVersion: result.corpusVersion,
        returnedCorpora: [...new Set(result.hits.map((hit) => hit.corpus))],
      });
      return result;
    },
  };
  const studyRunId = `smoke-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const collaborationTrace = new MetadataCollaborationTrace();
  const gateway = new AuthenticatedClinicalGateway({ studyRunId, arm: "integrated", cases: [item], concurrency: 1, evidenceClient, collaborationTrace });
  const identity = gateway.identityFor(item);
  let sessionId = "";
  const started = performance.now();
  const bridgeObserver = new BridgeConcurrencyObserver(new URL("/healthz", model.baseUrl).href, model.modelId);
  if (!(await bridgeObserver.start())) {
    throw new Error("Codex bridge health does not expose retry counters; restart the local bridge from the current source before strict smoke evaluation.");
  }
  const turnRuns: { readonly turnId: string; readonly runId: string; readonly events: readonly DemoEvent[] }[] = [];
  const failures: string[] = [];
  let amaCleanupVerified = false;
  try {
    await gateway.start();
    sessionId = await gateway.createEncounterSession(item, turns[0]!.encounterId);
    for (const turn of turns) {
      const execution = await gateway.runTurn({
        sessionId,
        patientId: identity.patientId,
        encounterId: turn.encounterId,
        message: turn.turnId === forcedCollaborationTurnId
          ? "这是一次完全合成的多学科 Agent 路由工程检查，不是临床效果评测。虚构病例仅用于工作流测试：多个共病问题并存，出现新的高风险变化，药物清单与肾功能/症状记录存在需要协调的冲突，涉及数个不同专科视角。请恰好调用一次 consult_clinical_team，让工具根据病例自行分类并按产品策略完成所需的有界专科协作；不要绕过其复杂度分类或臆造临床结论。调用后只需简短说明路由检查完成，不要输出诊疗建议。"
          : requestedRagMode === "iterative" && turn.expectedTaskIds.includes(TASKS.evidence)
          ? "请检索公开医学资料，针对成人高血压复诊中的居家血压测量与用药依从性，调用 search_medical_evidence 并在工具参数中明确设置 mode=\"iterative\"、topK=3，执行有界多轮检索。只总结实际返回来源支持的内容，并说明这不是针对任何个体患者的诊疗建议。"
          : turn.patientMessage,
        signal: AbortSignal.timeout(600_000),
      });
      turnRuns.push({ turnId: turn.turnId, runId: execution.runId, events: execution.events });
      const terminal = execution.events.find((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.event));
      if (!terminal || terminal.event !== "run.completed") {
        failures.push(terminal?.event === "run.failed" ? terminal.data.code : `${turn.turnId}:NO_COMPLETED_TERMINAL_EVENT`);
        break;
      }
      if ((turn.turnId === forcedCollaborationTurnId || (!requireCollaborationRouting && turn.expectedTaskIds.includes(TASKS.safety))) &&
          !execution.events.some((event) => event.event === "collaboration.completed")) {
        failures.push(`${turn.turnId}:CLINICAL_COLLABORATION_NOT_OBSERVED`);
      }
      if (turn.expectedTaskIds.includes(TASKS.evidence)) {
        if (!execution.events.some((event) => event.event === "tool.completed" && event.data.tool === "search_medical_evidence" && event.data.status === "completed")) {
          failures.push(`${turn.turnId}:LOCAL_RAG_TOOL_NOT_COMPLETED`);
        }
        if (!execution.events.some((event) => event.event === "evidence.completed")) failures.push(`${turn.turnId}:EVIDENCE_COMPLETION_EVENT_MISSING`);
        if (!execution.events.some((event) => event.event === "evidence.completed" && event.data.retrieval)) {
          failures.push(`${turn.turnId}:RAG_TELEMETRY_MISSING_FROM_GATEWAY_EVENT`);
        }
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.name : "UNKNOWN_ERROR");
  } finally {
    try { if (sessionId) await gateway.closeEncounterSession(item, sessionId); }
    catch { failures.push("ENCOUNTER_SESSION_CLEANUP_FAILED"); }
    try {
      await new MemoryClient().forget({
        userId: syntheticPatientMemoryId(identity.patientId, identity.tenantId),
        confirmation: "forget all patient memory",
      });
      const remaining = await new MemoryClient().stats(syntheticPatientMemoryId(identity.patientId, identity.tenantId));
      amaCleanupVerified = Object.values(remaining.records).every((count) => count === 0);
      if (!amaCleanupVerified) failures.push("SYNTHETIC_MEMORY_CLEANUP_NOT_EMPTY");
    } catch { failures.push("SYNTHETIC_MEMORY_CLEANUP_FAILED"); }
    try { await gateway.dispose(); }
    catch { failures.push("GATEWAY_CLEANUP_FAILED"); }
    await bridgeObserver.stop();
  }

  const bridgeConcurrency = bridgeObserver.snapshot();
  if (bridgeConcurrency.samples === 0 || bridgeConcurrency.failedSamples > 0 || bridgeConcurrency.attestationMismatch ||
      bridgeConcurrency.minConfiguredConcurrentTurns !== bridgeAttestation.maxConcurrentTurns ||
      bridgeConcurrency.maxConfiguredConcurrentTurns !== bridgeAttestation.maxConcurrentTurns) {
    failures.push("BRIDGE_CONCURRENCY_ATTESTATION_CHANGED_OR_UNOBSERVED");
  }
  if (requireCollaborationRouting && bridgeConcurrency.maxObservedActiveTurns < 2) {
    failures.push("DSH_CHILD_MODEL_CALLS_NOT_OVERLAPPED_AT_BRIDGE");
  }
  if (requireCollaborationRouting && (bridgeConcurrency.samples === 0 || bridgeConcurrency.failedSamples > 0)) {
    failures.push("BRIDGE_CONCURRENCY_OBSERVER_INCOMPLETE");
  }
  const events = turnRuns.flatMap((turn) => turn.events);
  const toolCalls = events.filter((event): event is Extract<DemoEvent, { event: "tool.completed" }> => event.event === "tool.completed")
    .map((event) => ({ tool: event.data.tool, status: event.data.status }));
  const collaboration = events.flatMap((event) => event.event === "collaboration.completed" ? [{
    complexity: event.data.complexity,
    completedChildRuns: event.data.completedChildRuns,
    failedChildRuns: event.data.failedChildRuns,
    degraded: event.data.degraded,
  }] : []);
  const tokenUsage = turnRuns.map((turn) => {
    const usage = gateway.usage.get(turn.runId);
    return usage
      ? { turnId: turn.turnId, ...usage }
      : { turnId: turn.turnId, scope: "unavailable" as const, subagentTotalTokens: 0, subagentSessionsObserved: 0 };
  });
  const subagentTokensReported = tokenUsage.reduce((sum, usage) => sum + (usage.subagentTotalTokens ?? 0), 0);
  const subagentSessionsObserved = tokenUsage.reduce((sum, usage) => sum + (usage.subagentSessionsObserved ?? 0), 0);
  const collaborationTraceSummary = summarizeCollaborationTrace(collaborationTrace.records);
  const collaborationChildRuns = collaborationTraceSummary.childRunCount;
  const gatewayRagTelemetryReferences: RagRetrievalTelemetry[] = events.flatMap((event) => {
    if (event.event === "evidence.completed" && event.data.retrieval) return [event.data.retrieval];
    if (event.event === "collaboration.completed" && event.data.externalEvidence?.retrieval) return [event.data.externalEvidence.retrieval];
    return [];
  });
  // A collaboration event can repeat the exact retrieval summary already emitted by
  // evidence.completed. Keep the raw reference count, but compare distinct metric
  // summaries with the instrumented retrieval calls.
  const gatewayRagTelemetry = uniqueRagRetrievalTelemetry(gatewayRagTelemetryReferences);
  if (gatewayRagTelemetry.length !== ragExecutions.length) failures.push("GATEWAY_RAG_TELEMETRY_COUNT_MISMATCH");
  if (requestedRagMode && !ragExecutions.some((entry) => entry.effectiveMode === requestedRagMode && entry.degraded === false)) {
    failures.push("REQUESTED_RAG_MODE_NOT_OBSERVED_IN_DSH_TOOL_EXECUTION");
  }
  if (requestedRagMode === "iterative" && !ragExecutions.some((entry) =>
    entry.effectiveMode === "iterative" && entry.plannerModel === "gpt-6-luna" &&
    typeof entry.plannerCalls === "number" && entry.plannerCalls > 0 && entry.degraded === false)) {
    failures.push("ITERATIVE_RAG_NOT_OBSERVED_IN_DSH_TOOL_EXECUTION");
  }
  if (requireAdvancedCollaboration && !collaboration.some((run) =>
    run.complexity === "advanced" && run.completedChildRuns >= 6 && run.failedChildRuns === 0 && !run.degraded)) {
    failures.push("ADVANCED_COLLABORATION_DID_NOT_COMPLETE_SIX_OR_MORE_CHILD_RUNS");
  }
  const collaborationDegraded = collaboration.some((run) => run.degraded || run.failedChildRuns > 0);
  const status = failures.length ? "failed" : collaborationDegraded ? "degraded" : "passed";
  const amaMemoryTrace = gateway.memoryTrace;
  const amaSessionEndTrace = amaMemoryTrace.filter((record) => record.operation === "session_end");
  const amaCommitTrace = amaMemoryTrace.filter((record) => record.operation === "commit");
  const amaRecallTrace = amaMemoryTrace.filter((record) => record.operation === "automatic_recall" || record.operation === "manual_recall");
  const result = {
    schemaVersion: "huiyi-gpt6-integrated-smoke/v6",
    status,
    createdAt: new Date().toISOString(),
    studyRunId,
    model: model.modelId,
    modelBackend: "codex-app-server",
    collaborationRoutingMode: requireCollaborationRouting ? "explicitly-requested-engineering-smoke" : "model-selected",
    ...(requireAdvancedCollaboration ? { collaborationAcceptance: "advanced-with-at-least-six-completed-children-no-failures" } : {}),
    cohortGenerator: item.generatorVersion,
    caseId: item.caseId,
    turnIds: turns.map((turn) => turn.turnId),
    synthetic: item.synthetic,
    authenticatedGateway: true,
    route: {
      bridge: "codex-app-server", bridgeModel: model.modelId,
      bridgeMaxConcurrentTurns: bridgeAttestation.maxConcurrentTurns,
      ama: route.amaModel, ragPlanner: route.ragPlannerModel, embedding: route.embeddingModel,
      memoryRecallIsolation: route.memoryRecallIsolation, healthEngineSourceSha256,
    },
    amaMemoryPolicy: {
      automaticRecall: "first-turn-per-Encounter; explicit recall tool remains available",
      persistedContent: "patient-originated messages only",
      commitBatchTurns: focus === "integrated" ? 2 : Number(process.env.HUIYI_MEMORY_COMMIT_BATCH_TURNS ?? "1"),
    },
    health: { memory: memoryHealth.status, rag: ragHealth.status, ragProbeDegraded: ragProbe.retrieval.degraded },
    durationMs: Math.round(performance.now() - started),
    bridgeConcurrency,
    terminalEvents: events.filter((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.event)).map((event) => event.event),
    failureDiagnostics: turnRuns.flatMap((turn) => turn.events.flatMap((event) => event.event === "run.failed" ? [{
      turnId: turn.turnId,
      code: event.data.code,
      ...(event.data.diagnostic ? { diagnostic: event.data.diagnostic } : {}),
    }] : [])),
    evidenceItems: events.filter((event) => event.event === "evidence.item").length,
    ragExecutions,
    gatewayRagTelemetry,
    gatewayRagTelemetryReferences: gatewayRagTelemetryReferences.length,
    requestedRagMode: requestedRagMode ?? "model-or-deployment-selected",
    toolCalls,
    collaboration,
    collaborationTrace: collaborationTraceSummary,
    ...(collaborationDegraded ? { warnings: ["COLLABORATION_DEGRADED"] } : {}),
    collaborationEvents: collaboration.length,
    tokenAttribution: {
      scope: "DSH root and child-session usage events; AMA usage is listed separately",
      subagentTokensReported,
      subagentSessionsObserved,
      collaborationChildRuns,
      subagentAttributionComplete: collaborationChildRuns === subagentSessionsObserved,
    },
    amaCleanupVerified,
    ama: {
      operations: amaMemoryTrace.length,
      llmCalls: amaMemoryTrace.reduce((sum, record) => sum + (record.amaLlmCallCount ?? 0), 0),
      usageReports: amaMemoryTrace.reduce((sum, record) => sum + (record.amaUsageReportCount ?? 0), 0),
      failedOperations: amaMemoryTrace.filter((record) => record.status === "failed").length,
      commitOperations: amaCommitTrace.length,
      commitPromptTokens: amaCommitTrace.reduce((sum, record) => sum + (record.amaPromptTokens ?? 0), 0),
      recallOperations: amaRecallTrace.length,
      recallPromptTokens: amaRecallTrace.reduce((sum, record) => sum + (record.amaPromptTokens ?? 0), 0),
      sessionEndOperations: amaSessionEndTrace.length,
      sessionEndFailures: amaSessionEndTrace.filter((record) => record.status === "failed").length,
      sessionEndEpisodesGenerated: amaSessionEndTrace.filter((record) => record.episodeGenerated === true).length,
      sessionEndLlmCalls: amaSessionEndTrace.reduce((sum, record) => sum + (record.amaLlmCallCount ?? 0), 0),
      sessionEndPromptTokens: amaSessionEndTrace.reduce((sum, record) => sum + (record.amaPromptTokens ?? 0), 0),
    },
    tokenUsage,
    ...(failures.length ? { failures } : {}),
  };
  const output = resolve(root, "artifacts/clinical-eval/smokes", `${studyRunId}.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...result, output: output.replace(`${root}\\`, "") })}\n`);
  if (status !== "passed") process.exitCode = 2;
}

/** Samples only numeric bridge counters; never records prompts, replies, patient text, or thread identifiers. */
class BridgeConcurrencyObserver {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<boolean>;
  private maxObservedActiveTurns = 0;
  private maxObservedQueuedTurns = 0;
  private minConfiguredConcurrentTurns = Number.POSITIVE_INFINITY;
  private maxConfiguredConcurrentTurns = 0;
  private samples = 0;
  private failedSamples = 0;
  private attestationMismatch = false;
  private retryBaseline?: RetryCounterSnapshot;
  private retryLatest?: RetryCounterSnapshot;

  constructor(private readonly healthUrl: string, private readonly expectedModel: string) {}

  async start(): Promise<boolean> {
    const ready = await this.sample();
    if (!ready) return false;
    this.timer = setInterval(() => { void this.sample(); }, 200);
    return true;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.inFlight;
    await this.sample();
  }

  snapshot(): {
    readonly maxObservedActiveTurns: number;
    readonly maxObservedQueuedTurns: number;
    readonly minConfiguredConcurrentTurns: number;
    readonly maxConfiguredConcurrentTurns: number;
    readonly samples: number;
    readonly failedSamples: number;
    readonly attestationMismatch: boolean;
    readonly retryCounters: {
      readonly baseline: RetryCounterSnapshot | null;
      readonly final: RetryCounterSnapshot | null;
      readonly delta: RetryCounterSnapshot | null;
    };
  } {
    return {
      maxObservedActiveTurns: this.maxObservedActiveTurns,
      maxObservedQueuedTurns: this.maxObservedQueuedTurns,
      minConfiguredConcurrentTurns: Number.isFinite(this.minConfiguredConcurrentTurns) ? this.minConfiguredConcurrentTurns : 0,
      maxConfiguredConcurrentTurns: this.maxConfiguredConcurrentTurns,
      samples: this.samples,
      failedSamples: this.failedSamples,
      attestationMismatch: this.attestationMismatch,
      retryCounters: {
        baseline: this.retryBaseline ?? null,
        final: this.retryLatest ?? null,
        delta: this.retryBaseline && this.retryLatest ? subtractRetryCounters(this.retryLatest, this.retryBaseline) : null,
      },
    };
  }

  private sample(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const response = await fetch(this.healthUrl, { signal: AbortSignal.timeout(750) });
        if (!response.ok) throw new Error("bridge health unavailable");
        const health = await response.json() as Record<string, unknown>;
        const attestation = attestCodexBridgeHealth(health, this.expectedModel);
        if (attestation.status !== "matched" || attestation.maxConcurrentTurns === null) {
          this.attestationMismatch = true;
          throw new Error("bridge health counters unavailable");
        }
        const retryCounters = parseRetryCounters(health.retryCounters);
        if (!retryCounters) throw new Error("bridge retry counters unavailable");
        if (this.retryLatest && hasRetryCounterRegression(retryCounters, this.retryLatest)) {
          this.attestationMismatch = true;
          throw new Error("bridge retry counters reset during observation");
        }
        this.samples += 1;
        this.retryBaseline ??= retryCounters;
        this.retryLatest = retryCounters;
        this.maxObservedActiveTurns = Math.max(this.maxObservedActiveTurns, health.activeTurns as number);
        this.maxObservedQueuedTurns = Math.max(this.maxObservedQueuedTurns, health.queuedTurns as number);
        this.minConfiguredConcurrentTurns = Math.min(this.minConfiguredConcurrentTurns, attestation.maxConcurrentTurns);
        this.maxConfiguredConcurrentTurns = Math.max(this.maxConfiguredConcurrentTurns, attestation.maxConcurrentTurns);
        return true;
      } catch {
        this.failedSamples += 1;
        return false;
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }
}

interface RetryCounterSnapshot {
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly malformedResponse: number;
  readonly providerTurn: number;
}

function parseRetryCounters(value: unknown): RetryCounterSnapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const counters = value as Record<string, unknown>;
  const names = ["attempts", "successes", "failures", "malformedResponse", "providerTurn"] as const;
  if (!names.every((name) => Number.isSafeInteger(counters[name]) && (counters[name] as number) >= 0)) return undefined;
  if ((counters.successes as number) + (counters.failures as number) > (counters.attempts as number)) return undefined;
  if ((counters.malformedResponse as number) + (counters.providerTurn as number) !== (counters.attempts as number)) return undefined;
  return Object.fromEntries(names.map((name) => [name, counters[name]])) as unknown as RetryCounterSnapshot;
}

function subtractRetryCounters(after: RetryCounterSnapshot, before: RetryCounterSnapshot): RetryCounterSnapshot {
  return {
    attempts: after.attempts - before.attempts,
    successes: after.successes - before.successes,
    failures: after.failures - before.failures,
    malformedResponse: after.malformedResponse - before.malformedResponse,
    providerTurn: after.providerTurn - before.providerTurn,
  };
}

function hasRetryCounterRegression(after: RetryCounterSnapshot, before: RetryCounterSnapshot): boolean {
  return after.attempts < before.attempts || after.successes < before.successes || after.failures < before.failures ||
    after.malformedResponse < before.malformedResponse || after.providerTurn < before.providerTurn;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`gpt6-integrated-smoke: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
