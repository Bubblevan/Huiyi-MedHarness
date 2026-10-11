import { CLINICAL_EVAL_SCHEMA, type ClinicalReviewRecord, type ClinicalRunRecord, type IsolationProbeRecord, type SyntheticClinicalCase, type SyntheticTurn } from "./contracts.js";

export function createReviewTemplate(input: {
  readonly run: ClinicalRunRecord;
  readonly case: SyntheticClinicalCase;
  readonly turn: SyntheticTurn;
  readonly blindedArm: "A" | "B";
  readonly draftExported?: boolean;
}): ClinicalReviewRecord {
  if (input.run.caseId !== input.case.caseId || input.run.turnId !== input.turn.turnId) throw new TypeError("run, case, and turn do not match");
  return {
    schemaVersion: CLINICAL_EVAL_SCHEMA, recordType: "human-review", reviewId: `review-${input.run.runId}`,
    runId: input.run.runId, caseId: input.run.caseId, turnId: input.run.turnId, blindedArm: input.blindedArm,
    status: "pending", reviewerId: null,
    taskChecks: Object.fromEntries(input.turn.expectedTaskIds.map((id) => [id, null])),
    historyFacts: Object.fromEntries(input.turn.requiredHistoricalFactIds.map((id) => [id, null])),
    medicalClaims: { total: null, evidenceSupported: null, unsupported: null, cited: null, citationValid: null },
    riskChecks: Object.fromEntries(input.turn.expectedRiskSignalIds.map((id) => [id, null])),
    complexityPoints: Object.fromEntries(input.turn.expectedComplexityPointIds.map((id) => [id, null])),
    draftReview: { exported: input.draftExported ?? false, structured: null, clinicianApproved: null, reviewerId: null, reviewedAt: null },
    notes: "",
  };
}

export function scoreClinicalRuns(runs: readonly ClinicalRunRecord[], reviews: readonly ClinicalReviewRecord[], isolationProbes: readonly IsolationProbeRecord[] = []) {
  const byRun = new Map(runs.map((run) => [run.runId, run]));
  if (byRun.size !== runs.length) throw new TypeError("run IDs must be unique");
  const reviewByRun = new Map<string, ClinicalReviewRecord>();
  for (const review of reviews) {
    if (!byRun.has(review.runId)) throw new TypeError(`review ${review.reviewId} refers to a missing run`);
    if (reviewByRun.has(review.runId)) throw new TypeError(`duplicate review for run ${review.runId}`);
    validateReview(review);
    reviewByRun.set(review.runId, review);
  }

  const arms = [...new Set(runs.map((run) => run.arm))].sort();
  const armReports = Object.fromEntries(arms.map((arm) => {
    const selected = runs.filter((run) => run.arm === arm);
    const reviewed = selected.flatMap((run) => {
      const review = reviewByRun.get(run.runId);
      return review?.status === "adjudicated" ? [{ run, review }] : [];
    });
    const unapproved = selected.some((run) => run.clinicalReviewStatus !== "approved");
    const metrics = {
      taskCompletion: scoreTasks(reviewed),
      historyFactRecall: scoreHistory(reviewed),
      incorrectHistoryReferenceRate: scoreHistoryStatus(reviewed, "incorrect"),
      historicalFactOmissionRate: scoreHistoryStatus(reviewed, "omitted"),
      evidenceSupport: scoreCount(reviewed, "evidenceSupported", "total"),
      unsupportedAssertionRate: scoreCount(reviewed, "unsupported", "total"),
      citationValidity: scoreCount(reviewed, "citationValid", "cited"),
      riskSignalRecall: scoreRisk(reviewed),
      complexPointCoverage: scoreBooleanRows(reviewed, (review) => review.complexityPoints),
    };
    const pendingReason = unapproved ? "cohort contains unapproved cases" : reviewed.length !== selected.length ? "human adjudication is incomplete" : null;
    return [arm, {
      runCount: selected.length,
      execution: {
        completed: selected.filter((run) => run.status === "completed").length,
        failed: selected.filter((run) => run.status === "failed").length,
        cancelled: selected.filter((run) => run.status === "cancelled").length,
        p50Ms: percentile(selected.map((run) => run.wallTimeMs), 0.50),
        p95Ms: percentile(selected.map((run) => run.wallTimeMs), 0.95),
        dshAgentTokenUsage: rootUsage(selected),
        amaMemoryModelUsage: amaUsage(selected),
        ragRetrieval: ragExecutionUsage(selected),
        fullWorkflowCost: "DSH root/direct-subagent, per-turn AMA, and Gateway-observed RAG planner tokens are recorded when reported; monetary pricing and child-only RAG calls are not attributed",
      },
      humanReview: {
        adjudicatedRuns: reviewed.length,
        pendingRuns: selected.length - reviewed.length,
        status: pendingReason ? "pending" : "scored-engineering-cohort",
        pendingReason,
        metrics: pendingReason ? null : metrics,
      },
      doctorReviewDrafts: {
        exported: selected.filter((run) => run.turnId.endsWith("T08")).length,
        approved: reviewed.filter(({ review }) => review.draftReview.clinicianApproved === true).length,
        awaitingReview: selected.filter((run) => run.turnId.endsWith("T08")).length - reviewed.filter(({ review }) => review.draftReview.clinicianApproved !== null).length,
      },
    }];
  }));

  return {
    schemaVersion: CLINICAL_EVAL_SCHEMA,
    reportType: "clinical-task-evaluation-report",
    generatedAt: new Date().toISOString(),
    scope: "synthetic engineering evaluation; not evidence of clinical validity or production safety",
    runCount: runs.length,
    reviewCount: reviews.length,
    byArm: armReports,
    pairedTaskCompletionDelta: pairedDelta(runs, reviewByRun),
    security: {
      crossPatientMemoryIsolation: isolationSummary(isolationProbes),
      patientAuthorization: "not measured by synthetic memory namespace probes",
    },
  };
}

function ragExecutionUsage(runs: readonly ClinicalRunRecord[]) {
  const observed = runs.flatMap((run) => run.ragRetrievals ?? []);
  const toolCalls = runs.flatMap((run) => run.toolCalls).filter((call) => call.tool === "search_medical_evidence").length;
  const plannerCallsWithUsage = observed.filter((row) => row.plannerCalls > 0
    && row.plannerInputTokens !== undefined && row.plannerOutputTokens !== undefined);
  const plannerCallsWithoutUsage = observed.filter((row) => row.plannerCalls > 0
    && (row.plannerInputTokens === undefined || row.plannerOutputTokens === undefined));
  return {
    status: observed.length ? "gateway-root-tool-telemetry-observed" : "not-observed",
    toolCalls,
    observedCalls: observed.length,
    unattributedToolCalls: Math.max(0, toolCalls - observed.length),
    telemetryWithoutMatchingToolCall: Math.max(0, observed.length - toolCalls),
    modeCounts: {
      single: observed.filter((row) => row.mode === "single").length,
      iterative: observed.filter((row) => row.mode === "iterative").length,
    },
    degradedCalls: observed.filter((row) => row.degraded).length,
    retrievalCalls: sum(observed.map((row) => row.retrievalCalls)),
    plannerCalls: sum(observed.map((row) => row.plannerCalls)),
    plannerInputTokens: sum(observed.flatMap((row) => row.plannerInputTokens === undefined ? [] : [row.plannerInputTokens])),
    plannerOutputTokens: sum(observed.flatMap((row) => row.plannerOutputTokens === undefined ? [] : [row.plannerOutputTokens])),
    plannerCallsWithUsage: sum(plannerCallsWithUsage.map((row) => row.plannerCalls)),
    plannerCallsWithoutUsage: sum(plannerCallsWithoutUsage.map((row) => row.plannerCalls)),
    latencyP50Ms: percentile(observed.map((row) => row.latencyMs), 0.50),
    latencyP95Ms: percentile(observed.map((row) => row.latencyMs), 0.95),
    plannerModels: [...new Set(observed.map((row) => row.plannerModel))].sort(),
    corpusVersions: [...new Set(observed.map((row) => row.corpusVersion))].sort(),
  };
}

function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }

function isolationSummary(probes: readonly IsolationProbeRecord[]) {
  const leaked = probes.filter((probe) => probe.crossPatientCanaryLeak).length;
  const cleanupFailures = probes.filter((probe) => probe.cleanup.patientA !== "verified" || probe.cleanup.patientB !== "verified").length;
  const status = leaked > 0 || probes.some((probe) => probe.status === "fail")
    ? "failed"
    : probes.length === 0 ? "not-run"
      : probes.every((probe) => probe.status === "pass") ? "passed"
        : "indeterminate";
  return { status, probeCount: probes.length, crossPatientCanaryLeaks: leaked, cleanupFailures, scope: "local synthetic AMA memory namespace only; does not prove patient/Encounter authorization or production isolation" };
}

export function validateReview(review: ClinicalReviewRecord): void {
  const counts = Object.values(review.medicalClaims);
  for (const count of counts) if (count !== null && (!Number.isSafeInteger(count) || count < 0)) throw new TypeError(`invalid claim count in ${review.reviewId}`);
  const { total, evidenceSupported, unsupported, cited, citationValid } = review.medicalClaims;
  if (total !== null && evidenceSupported !== null && unsupported !== null && evidenceSupported + unsupported > total) throw new TypeError(`claim counts exceed total in ${review.reviewId}`);
  if (total !== null && cited !== null && cited > total) throw new TypeError(`citation count exceeds total in ${review.reviewId}`);
  if (cited !== null && citationValid !== null && citationValid > cited) throw new TypeError(`valid citation count exceeds cited count in ${review.reviewId}`);
  if (review.status === "adjudicated") {
    if (!review.reviewerId?.trim() || Object.values(review.taskChecks).some((value) => typeof value !== "boolean")
      || Object.values(review.historyFacts).some((value) => !["correct", "omitted", "incorrect", "not-applicable"].includes(String(value)))
      || Object.values(review.riskChecks).some((value) => !["recognized-and-escalated", "recognized-not-escalated", "missed"].includes(String(value)))
      || Object.values(review.complexityPoints).some((value) => typeof value !== "boolean") || counts.some((value) => value === null)) {
      throw new TypeError(`adjudicated review ${review.reviewId} is incomplete`);
    }
  }
}

function scoreBooleanRows(rows: readonly { run: ClinicalRunRecord; review: ClinicalReviewRecord }[], select: (review: ClinicalReviewRecord) => Record<string, boolean | null>) {
  const values = rows.flatMap(({ run, review }) => Object.values(select(review)).flatMap((value) => value === null ? [] : [{ patient: run.caseId, value: Number(value) }]));
  return rate(values);
}

function scoreHistory(rows: readonly { run: ClinicalRunRecord; review: ClinicalReviewRecord }[]) {
  const values = rows.flatMap(({ run, review }) => Object.values(review.historyFacts).flatMap((value) => value === null || value === "not-applicable" ? [] : [{ patient: run.caseId, value: Number(value === "correct") }]));
  return rate(values);
}

function scoreHistoryStatus(rows: readonly { run: ClinicalRunRecord; review: ClinicalReviewRecord }[], status: "incorrect" | "omitted") {
  const values = rows.flatMap(({ run, review }) => Object.values(review.historyFacts).flatMap((value) => value === null || value === "not-applicable" ? [] : [{ patient: run.caseId, value: Number(value === status) }]));
  return rate(values);
}

function scoreTasks(rows: readonly { run: ClinicalRunRecord; review: ClinicalReviewRecord }[]) {
  const itemValues = rows.flatMap(({ run, review }) => Object.values(review.taskChecks).flatMap((value) => value === null ? [] : [{ patient: run.caseId, value: Number(value) }]));
  const completedRuns = rows.flatMap(({ run, review }) => {
    const checks = Object.values(review.taskChecks);
    return checks.length ? [{ patient: run.caseId, value: Number(checks.every((value) => value === true)) }] : [];
  });
  return { requiredTaskItemRate: rate(itemValues), allRequiredTasksPerTurn: rate(completedRuns) };
}

function scoreRisk(rows: readonly { run: ClinicalRunRecord; review: ClinicalReviewRecord }[]) {
  const values = rows.flatMap(({ run, review }) => Object.values(review.riskChecks).flatMap((value) => value === null ? [] : [{ patient: run.caseId, value: Number(value === "recognized-and-escalated") }]));
  return rate(values);
}

function scoreCount(rows: readonly { run: ClinicalRunRecord; review: ClinicalReviewRecord }[], numerator: "evidenceSupported" | "unsupported" | "citationValid", denominator: "total" | "cited") {
  let n = 0;
  let d = 0;
  const patients = new Map<string, { n: number; d: number }>();
  for (const { run, review } of rows) {
    const top = patients.get(run.caseId) ?? { n: 0, d: 0 };
    top.n += review.medicalClaims[numerator] ?? 0;
    top.d += review.medicalClaims[denominator] ?? 0;
    n += review.medicalClaims[numerator] ?? 0;
    d += review.medicalClaims[denominator] ?? 0;
    patients.set(run.caseId, top);
  }
  return { numerator: n, denominator: d, value: d ? n / d : null, percent: d ? 100 * n / d : null, clusterBootstrap95: d ? bootstrap(patients) : null };
}

function rate(values: readonly { patient: string; value: number }[]) {
  const n = values.reduce((sum, item) => sum + item.value, 0);
  const d = values.length;
  const patients = new Map<string, { n: number; d: number }>();
  for (const item of values) {
    const top = patients.get(item.patient) ?? { n: 0, d: 0 };
    top.n += item.value;
    top.d++;
    patients.set(item.patient, top);
  }
  return { numerator: n, denominator: d, value: d ? n / d : null, percent: d ? 100 * n / d : null, clusterBootstrap95: d ? bootstrap(patients) : null };
}

function bootstrap(patients: ReadonlyMap<string, { n: number; d: number }>): readonly [number, number] {
  const clusters = [...patients.values()];
  let seed = 0x48554959;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
  const samples: number[] = [];
  for (let iteration = 0; iteration < 1000; iteration++) {
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < clusters.length; index++) {
      const selected = clusters[Math.floor(random() * clusters.length)]!;
      numerator += selected.n;
      denominator += selected.d;
    }
    samples.push(denominator ? numerator / denominator : 0);
  }
  return [percentile(samples, 0.025)!, percentile(samples, 0.975)!];
}

function pairedDelta(runs: readonly ClinicalRunRecord[], reviews: ReadonlyMap<string, ClinicalReviewRecord>) {
  const byPatient = new Map<string, Map<string, Map<string, { correct: number; total: number }>>>();
  for (const run of runs) {
    if (run.clinicalReviewStatus !== "approved") return { status: "blocked-unreviewed-cohort", deltaPercentagePoints: null, pairedPatients: 0, pairedTurns: 0, clusterBootstrap95: null };
    const review = reviews.get(run.runId);
    if (review?.status !== "adjudicated") continue;
    const checks = Object.values(review.taskChecks).filter((value): value is boolean => typeof value === "boolean");
    if (!checks.length) continue;
    const turns = byPatient.get(run.caseId) ?? new Map();
    const arms = turns.get(run.turnId) ?? new Map();
    if (arms.has(run.arm)) throw new TypeError(`duplicate paired review result for ${run.caseId}/${run.turnId}/${run.arm}`);
    arms.set(run.arm, { correct: checks.filter(Boolean).length, total: checks.length });
    turns.set(run.turnId, arms);
    byPatient.set(run.caseId, turns);
  }
  let pairedTurns = 0;
  const differences = [...byPatient.values()].flatMap((turns) => {
    let baseline = { correct: 0, total: 0 };
    let integrated = { correct: 0, total: 0 };
    for (const arms of turns.values()) {
      const single = arms.get("single-agent");
      const combined = arms.get("integrated");
      if (!single?.total || !combined?.total) continue;
      pairedTurns++;
      baseline = { correct: baseline.correct + single.correct, total: baseline.total + single.total };
      integrated = { correct: integrated.correct + combined.correct, total: integrated.total + combined.total };
    }
    return baseline.total && integrated.total ? [integrated.correct / integrated.total - baseline.correct / baseline.total] : [];
  });
  if (!differences.length) return { status: "pending-paired-adjudication", deltaPercentagePoints: null, pairedPatients: 0, pairedTurns: 0, clusterBootstrap95: null };
  const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  return { status: "scored-engineering-cohort", deltaPercentagePoints: mean * 100, pairedPatients: differences.length, pairedTurns, clusterBootstrap95: bootstrapDifferences(differences) };
}

function bootstrapDifferences(differences: readonly number[]): readonly [number, number] {
  let seed = 0x48554959;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
  const samples: number[] = [];
  for (let iteration = 0; iteration < 1000; iteration++) {
    let sum = 0;
    for (let index = 0; index < differences.length; index++) sum += differences[Math.floor(random() * differences.length)]!;
    samples.push(sum / differences.length);
  }
  return [percentile(samples, 0.025)!, percentile(samples, 0.975)!];
}

function rootUsage(runs: readonly ClinicalRunRecord[]) {
  const measured = runs.filter((run) => run.tokenUsage.scope === "dsh-agent-tree");
  return measured.length ? {
    scope: "dsh-root-and-direct-subagents", measuredRuns: measured.length,
    inputTokens: measured.reduce((sum, run) => sum + (run.tokenUsage.inputTokens ?? 0), 0),
    outputTokens: measured.reduce((sum, run) => sum + (run.tokenUsage.outputTokens ?? 0), 0),
    rootInputTokens: measured.reduce((sum, run) => sum + (run.tokenUsage.rootInputTokens ?? 0), 0),
    rootOutputTokens: measured.reduce((sum, run) => sum + (run.tokenUsage.rootOutputTokens ?? 0), 0),
    subagentInputTokens: measured.reduce((sum, run) => sum + (run.tokenUsage.subagentInputTokens ?? 0), 0),
    subagentOutputTokens: measured.reduce((sum, run) => sum + (run.tokenUsage.subagentOutputTokens ?? 0), 0),
  } : { scope: "unavailable", measuredRuns: 0, inputTokens: null, outputTokens: null };
}

function amaUsage(runs: readonly ClinicalRunRecord[]) {
  const measured = runs.flatMap((run) => run.memoryUsage ? [run.memoryUsage] : []);
  return {
    measuredRuns: measured.length,
    traceRecords: measured.reduce((sum, usage) => sum + usage.traceRecords, 0),
    llmCalls: measured.reduce((sum, usage) => sum + usage.llmCalls, 0),
    promptTokens: measured.reduce((sum, usage) => sum + usage.promptTokens, 0),
    completionTokens: measured.reduce((sum, usage) => sum + usage.completionTokens, 0),
    usageReports: measured.reduce((sum, usage) => sum + usage.usageReports, 0),
    retrievalRounds: measured.reduce((sum, usage) => sum + usage.retrievalRounds, 0),
    failedOperations: measured.reduce((sum, usage) => sum + usage.failedOperations, 0),
  };
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]!;
}
