import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClinicalApprovalTemplate, applyClinicalApproval, type ClinicalCohortApproval } from "./approval.js";
import { summarizeSyntheticCohort } from "./cohort-audit.js";
import { assertCodexLunaRoute, createClinicalRunPlan } from "./run-plan.js";
import { attestCodexBridgeHealth } from "./bridge-attestation.js";
import { createClinicalApprovalFromReview, createSyntheticCohortReviewPacket } from "./review-packet.js";
import { makeBlindReviewPacket, mergeBlindedReviews, type ClinicalBlindReviewPacket, type ClinicalReviewKeyEntry } from "./blind-review.js";
import { generateCohort, validateSyntheticCase } from "./cohort.js";
import { runCrossPatientMemoryIsolationProbe } from "./isolation.js";
import { checkHealthEngineRoute, clinicalTaskKey, makeUnblindKey, runClinicalBenchmark } from "./runner.js";
import { captureEvaluationSourceFingerprint, captureHealthEngineSourceFingerprint } from "./source-fingerprint.js";
import { createReviewTemplate, scoreClinicalRuns } from "./scoring.js";
import { readModelConfiguration } from "../../services/demo-gateway/src/backends/dsh-runtime.js";
import type { ClinicalReviewRecord, ClinicalRunRecord, EvalArm, PatientSimulationMode, SyntheticClinicalCase } from "./contracts.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_COHORT = "artifacts/clinical-eval/cohort-300.jsonl";
const DEFAULT_RUNS_ROOT = "artifacts/clinical-eval/runs";

interface Args { command: string; flags: Map<string, string> }

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "generate": return generateCommand(args.flags);
    case "validate": return validateCommand(args.flags);
    case "plan": return planCommand(args.flags);
    case "review-packet": return reviewPacketCommand(args.flags);
    case "approve-packet": return approvePacketCommand(args.flags);
    case "approval-template": return approvalTemplateCommand(args.flags);
    case "run": return runCommand(args.flags);
    case "isolation-probe": return isolationProbeCommand(args.flags);
    case "finalize": return finalizeRunCommand(args.flags);
    case "score": return scoreCommand(args.flags);
    case "merge-reviews": return mergeReviewsCommand(args.flags);
    case "help": return printHelp();
    default: throw new Error(`unknown command '${args.command}'. Run clinical-eval help.`);
  }
}

async function generateCommand(flags: Map<string, string>): Promise<void> {
  assertFlags(flags, ["output", "count", "seed", "development", "validation"]);
  const output = artifactPath(flags.get("output") ?? DEFAULT_COHORT);
  const count = integerFlag(flags, "count", 300, 1, 300);
  const seed = integerFlag(flags, "seed", 20261010, 0, Number.MAX_SAFE_INTEGER);
  const developmentCount = integerFlag(flags, "development", 30, 0, 300);
  const validationCount = integerFlag(flags, "validation", 75, 0, 300);
  const cases = generateCohort({ count, seed, developmentCount, validationCount });
  await mkdir(dirname(output), { recursive: true });
  const content = toJsonl(cases);
  await writeFile(output, content, "utf8");
  const counts = splitCounts(cases);
  process.stdout.write(`${JSON.stringify({ output: relative(ROOT, output), count, turns: cases.reduce((total, item) => total + item.turns.length, 0), splitCounts: counts, sha256: sha256(content), clinicalReviewStatus: "pending" })}\n`);
}

async function validateCommand(flags: Map<string, string>): Promise<void> {
  assertFlags(flags, ["cohort", "output"]);
  const cohortPath = resolveRepoPath(flags.get("cohort") ?? DEFAULT_COHORT);
  const cases = await readJsonl<SyntheticClinicalCase>(cohortPath);
  cases.forEach(validateSyntheticCase);
  const cohortHash = sha256(await readFile(cohortPath));
  const coverage = summarizeSyntheticCohort(cases);
  const report = {
    schemaVersion: "huiyi-synthetic-cohort-audit/v1",
    status: "valid-synthetic-cohort",
    source: relative(ROOT, cohortPath),
    sha256: cohortHash,
    createdAt: new Date().toISOString(),
    count: coverage.patients,
    turns: coverage.turns,
    facts: coverage.facts,
    splitCounts: splitCounts(cases),
    coverage,
    allPendingReview: cases.every((item) => item.clinicalReviewStatus === "pending"),
  };
  let output: string | undefined;
  if (flags.has("output")) {
    const outputPath = artifactPath(required(flags, "output"));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    output = relative(ROOT, outputPath);
  }
  process.stdout.write(`${JSON.stringify({ ...report, ...(output ? { output } : {}) })}\n`);
}

async function planCommand(flags: Map<string, string>): Promise<void> {
  assertFlags(flags, ["cohort", "split", "limit", "arms", "patient-simulation", "patient-followups", "max-tokens", "approval", "synthetic-ama-memory", "output"]);
  const cohortPath = resolveRepoPath(flags.get("cohort") ?? DEFAULT_COHORT);
  const cohortBytes = await readFile(cohortPath);
  const allCases = parseJsonl<SyntheticClinicalCase>(cohortBytes.toString("utf8"));
  allCases.forEach(validateSyntheticCase);
  const split = flags.get("split") ?? "development";
  if (!( ["development", "validation", "held-out", "all"] as const).includes(split as "development" | "validation" | "held-out" | "all")) {
    throw new Error("--split must be development, validation, held-out, or all");
  }
  const limit = integerFlag(flags, "limit", 1, 1, 300);
  const eligible = allCases.filter((item) => split === "all" || item.split === split);
  const selected = eligible.slice(0, limit);
  if (!selected.length) throw new Error(`no cases found in split '${split}'`);
  const armsValue = flags.get("arms") ?? "both";
  const arms = armsValue === "both" ? ["single-agent", "integrated"] as const
    : armsValue === "single-agent" || armsValue === "integrated" ? [armsValue] as const
      : (() => { throw new Error("--arms must be both, single-agent, or integrated"); })();
  const modeValue = flags.get("patient-simulation") ?? "scripted";
  if (modeValue !== "scripted" && modeValue !== "adaptive") throw new TypeError("--patient-simulation must be scripted or adaptive");
  const patientSimulationMode = modeValue;
  if (patientSimulationMode === "adaptive" && selected.some((item) => item.turns.some((turn) => !turn.patientPlan))) {
    throw new TypeError("adaptive patient simulation requires a v2 cohort with a patient plan for every turn");
  }
  const patientFollowUpLimit = flags.has("patient-followups") ? integerFlag(flags, "patient-followups", 0, 0, 5) : undefined;
  if (patientFollowUpLimit !== undefined && patientSimulationMode !== "adaptive") throw new TypeError("--patient-followups only applies with --patient-simulation=adaptive");
  if (patientFollowUpLimit !== undefined && selected.some((item) => item.turns.some((turn) => !turn.patientPlan || patientFollowUpLimit > turn.patientPlan.maxFollowUpMessages))) {
    throw new RangeError("--patient-followups cannot exceed a turn's frozen cohort plan");
  }
  const configuredMaxTokens = process.env.HUIYI_DEMO_MAX_TOKENS ? Number(process.env.HUIYI_DEMO_MAX_TOKENS) : 1536;
  const defaultMaxTokens = Number.isSafeInteger(configuredMaxTokens) && configuredMaxTokens >= 1 && configuredMaxTokens <= 4096 ? configuredMaxTokens : 1536;
  const maxTokens = integerFlag(flags, "max-tokens", defaultMaxTokens, 1, 4096);
  const cohortSha256 = sha256(cohortBytes);
  const approvalPath = flags.has("approval")
    ? resolveRepoPath(flags.get("approval")!)
    : resolveRepoPath(`${relative(ROOT, cohortPath)}.approval.json`);
  let approval: ClinicalCohortApproval | undefined;
  try {
    approval = JSON.parse(await readFile(approvalPath, "utf8")) as ClinicalCohortApproval;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const modelBackend = process.env.HUIYI_DEMO_MODEL_BACKEND?.trim() || "vllm";
  let model: ReturnType<typeof readModelConfiguration> | undefined;
  try { model = readModelConfiguration(); } catch { /* Report an unconfigured route without exposing env/config errors. */ }
  const syntheticAmaMemory = flags.get("synthetic-ama-memory") === "true";
  const plan = createClinicalRunPlan({
    cases: selected,
    cohortCaseIds: allCases.map((item) => item.caseId),
    cohortSha256,
    split,
    arms,
    patientSimulationMode,
    patientFollowUpLimit,
    maxTokens,
    modelBackend,
    providerName: model?.providerName ?? "unconfigured",
    modelId: model?.modelId ?? "unconfigured",
    approval,
  });
  const preflightBlockers = [
    ...(modelBackend !== "codex-app-server" ? ["HUIYI_DEMO_MODEL_BACKEND is not codex-app-server"] : []),
    ...(!model || model.modelId !== "gpt-6-luna" ? ["GPT-6-Luna model route is not configured"] : []),
    ...(arms.includes("integrated") && !syntheticAmaMemory ? ["integrated arm requires --synthetic-ama-memory=true"] : []),
  ];
  const healthEngineUrl = process.env.HUIYI_HEALTH_ENGINE_URL?.trim() || "http://127.0.0.1:8322";
  const routeAttestation = arms.includes("integrated") && model
    ? await readRoutePreflight(model.baseUrl, model.modelId, modelBackend, healthEngineUrl)
    : { status: arms.includes("integrated") ? "not-checked" : "not-required" };
  if (arms.includes("integrated") && routeAttestation.status !== "matched") preflightBlockers.push(`integrated runtime route attestation is ${routeAttestation.status}`);
  const report = {
    ...plan,
    createdAt: new Date().toISOString(),
    approvalArtifact: approval ? relative(ROOT, approvalPath) : null,
    syntheticAmaMemoryEnabled: syntheticAmaMemory,
    preflightBlockers,
    healthEngineRouteAttestation: routeAttestation,
    runtimeAttestation: arms.includes("integrated") ? "read-only bridge concurrency/model, Health Engine health/config, and loaded Health Engine/AMA source checks; retrieval readiness is deferred until run" : "not required",
  };
  let output: string | undefined;
  if (flags.has("output")) {
    const outputPath = artifactPath(required(flags, "output"));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    output = relative(ROOT, outputPath);
  }
  process.stdout.write(`${JSON.stringify({ ...report, ...(output ? { output } : {}) })}\n`);
}

async function reviewPacketCommand(flags: Map<string, string>): Promise<void> {
  assertFlags(flags, ["cohort", "split", "limit", "output", "crosswalk-output"]);
  const cohortPath = resolveRepoPath(flags.get("cohort") ?? DEFAULT_COHORT);
  const cohortBytes = await readFile(cohortPath);
  const allCases = parseJsonl<SyntheticClinicalCase>(cohortBytes.toString("utf8"));
  allCases.forEach(validateSyntheticCase);
  const split = flags.get("split") ?? "development";
  if (!( ["development", "validation", "held-out", "all"] as const).includes(split as "development" | "validation" | "held-out" | "all")) {
    throw new Error("--split must be development, validation, held-out, or all");
  }
  const defaultLimit = split === "all" ? 300 : 30;
  const limit = integerFlag(flags, "limit", defaultLimit, 1, 300);
  const selected = allCases.filter((item) => split === "all" || item.split === split).slice(0, limit);
  if (!selected.length) throw new Error(`no cases found in split '${split}'`);
  const { packet, crosswalk } = createSyntheticCohortReviewPacket({ cases: selected, cohortSha256: sha256(cohortBytes) });
  const outputPath = artifactPath(flags.get("output") ?? "artifacts/clinical-eval/reviews/development-review-packet.json");
  const crosswalkPath = artifactPath(flags.get("crosswalk-output")
    ?? `artifacts/clinical-eval/private/cohort-reviews/${crosswalk.cohortSha256.slice(0, 16)}-${split}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(crosswalkPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  await writeFile(crosswalkPath, `${JSON.stringify(crosswalk, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: relative(ROOT, outputPath), crosswalkOutput: relative(ROOT, crosswalkPath), schemaVersion: packet.schemaVersion, cohortSha256: packet.cohortSha256, split, cases: packet.cases.length, turns: packet.cases.reduce((sum, item) => sum + item.turns.length, 0), facts: packet.cases.reduce((sum, item) => sum + item.facts.length, 0), requiredReviewerRole: packet.requiredReviewerRole })}\n`);
}

async function approvePacketCommand(flags: Map<string, string>): Promise<void> {
  assertFlags(flags, ["cohort", "packet", "crosswalk", "output"]);
  const cohortPath = resolveRepoPath(flags.get("cohort") ?? DEFAULT_COHORT);
  const cohortBytes = await readFile(cohortPath);
  const cases = parseJsonl<SyntheticClinicalCase>(cohortBytes.toString("utf8"));
  cases.forEach(validateSyntheticCase);
  const packetBytes = await readFile(resolveRepoPath(required(flags, "packet")));
  const crosswalkBytes = await readFile(resolveRepoPath(required(flags, "crosswalk")));
  const result = createClinicalApprovalFromReview({
    cohort: cases,
    cohortSha256: sha256(cohortBytes),
    packet: JSON.parse(packetBytes.toString("utf8")) as unknown,
    crosswalk: JSON.parse(crosswalkBytes.toString("utf8")) as unknown,
    reviewPacketSha256: sha256(packetBytes),
    reviewCrosswalkSha256: sha256(crosswalkBytes),
  });
  const outputPath = artifactPath(required(flags, "output"));
  try {
    await stat(outputPath);
    throw new Error(`approval output already exists: ${relative(ROOT, outputPath)}; choose a new output path`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result.approval, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: relative(ROOT, outputPath), status: result.approval.status, reviewedCases: result.reviewedCaseCount, approvedCases: result.approval.approvedCaseIds.length, cohortSha256: result.approval.cohortSha256 })}\n`);
}

async function readRoutePreflight(modelBaseUrl: string, modelId: string, modelBackend: string, healthEngineUrl: string): Promise<Record<string, unknown>> {
  if (modelBackend !== "codex-app-server" || modelId !== "gpt-6-luna") return { status: "not-checked" };
  let bridge: URL;
  let engine: URL;
  try {
    bridge = new URL(modelBaseUrl);
    engine = new URL(healthEngineUrl);
  } catch { return { status: "unsafe-url" }; }
  const loopback = (url: URL) => url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash;
  if (!loopback(bridge) || !loopback(engine)) return { status: "unsafe-url" };
  const bridgeHealthUrl = `${bridge.origin}/healthz`;
  const engineHealthUrl = `${engine.toString().replace(/\/$/, "")}/health`;
  const configUrl = `${engine.toString().replace(/\/$/, "")}/_internal/evaluation/config`;
  try {
    const [bridgeHealth, engineHealth, configResponse] = await Promise.all([
      fetch(bridgeHealthUrl, { signal: AbortSignal.timeout(2500) }),
      fetch(engineHealthUrl, { signal: AbortSignal.timeout(2500) }),
      fetch(configUrl, { signal: AbortSignal.timeout(2500) }),
    ]);
    if (!bridgeHealth.ok || !engineHealth.ok || !configResponse.ok) {
      return { status: "unavailable", bridgeHttpStatus: bridgeHealth.status, healthEngineHttpStatus: engineHealth.status, configHttpStatus: configResponse.status };
    }
    const bridgeAttestation = attestCodexBridgeHealth(await bridgeHealth.json().catch(() => undefined), modelId);
    const value: unknown = await configResponse.json();
    if (typeof value !== "object" || value === null) return { status: "invalid-config" };
    const route = value as Record<string, unknown>;
    const currentSourceSha256 = await captureHealthEngineSourceFingerprint(ROOT);
    const healthEngineSourceMatches = route.healthEngineSourceSha256 === currentSourceSha256;
    const expectedEndpoint = `${modelBaseUrl.replace(/\/$/, "")}/chat/completions`;
    const amaEndpointMatches = route.amaEndpoint === expectedEndpoint;
    const plannerEndpointMatches = route.ragPlannerEndpoint === expectedEndpoint;
    const embeddingModel = typeof route.embeddingModel === "string" ? route.embeddingModel : null;
    const embeddingMatches = typeof embeddingModel === "string" && /Qwen3-Embedding-0\.6B/i.test(embeddingModel);
    const checks = {
      bridgeModelMatches: bridgeAttestation.modelMatches,
      bridgeRouteMatches: bridgeAttestation.routeMatches,
      bridgeHealthy: bridgeAttestation.healthy,
      bridgeBoundedConcurrency: bridgeAttestation.boundedConcurrency,
      amaModelMatches: route.amaModel === modelId,
      amaEndpointMatches,
      ragPlannerModelMatches: route.ragPlannerModel === modelId,
      plannerEndpointMatches,
      ragEnabled: route.ragEnabled === true,
      memoryRecallIsolation: route.memoryRecallIsolation === true,
      qwen3Embedding: embeddingMatches,
      healthEngineSourceMatches,
    };
    return {
      status: Object.values(checks).every(Boolean) ? "matched" : "mismatch",
      bridgeHealth: bridgeAttestation.healthy ? "ok" : "mismatch",
      bridgeMaxConcurrentTurns: bridgeAttestation.maxConcurrentTurns,
      healthEngineHealth: "ok", ...checks,
      amaModel: typeof route.amaModel === "string" ? route.amaModel : null,
      ragPlannerModel: typeof route.ragPlannerModel === "string" ? route.ragPlannerModel : null,
      embeddingModel,
      healthEngineSourceSha256: typeof route.healthEngineSourceSha256 === "string" ? route.healthEngineSourceSha256 : null,
    };
  } catch (error) {
    return { status: "unavailable", errorClass: error instanceof Error ? error.name : "Error" };
  }
}

async function approvalTemplateCommand(flags: Map<string, string>): Promise<void> {
  assertFlags(flags, ["cohort", "output"]);
  const cohortPath = resolveRepoPath(flags.get("cohort") ?? DEFAULT_COHORT);
  const content = await readFile(cohortPath);
  const cases = parseJsonl<SyntheticClinicalCase>(content.toString("utf8"));
  cases.forEach(validateSyntheticCase);
  const output = artifactPath(flags.get("output") ?? `${relative(ROOT, cohortPath)}.approval.json`);
  await mkdir(dirname(output), { recursive: true });
  const template = createClinicalApprovalTemplate(cases, sha256(content));
  await writeFile(output, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: relative(ROOT, output), status: template.status, cohortSha256: template.cohortSha256, reviewerRoleRequired: "licensed-clinician" })}\n`);
}

async function runCommand(flags: Map<string, string>): Promise<void> {
  assertFlags(flags, ["cohort", "split", "limit", "case-ids", "arms", "concurrency", "approval", "synthetic-ama-memory", "max-tokens", "memory-commit-batch-turns", "turn-timeout-ms", "study-run-id", "resume", "patient-simulation", "patient-followups"]);
  const resume = flags.get("resume") === "true";
  if (flags.has("resume") && !resume) throw new Error("--resume must be true when specified");
  if (resume && !flags.has("study-run-id")) throw new Error("--resume=true requires --study-run-id=<existing-run>");
  if (!resume && flags.has("study-run-id") && ["split", "limit", "case-ids", "arms"].some((name) => flags.has(name))) throw new Error("a named new run cannot also specify selection flags");

  const cohortPath = resolveRepoPath(flags.get("cohort") ?? DEFAULT_COHORT);
  const cohortBytes = await readFile(cohortPath);
  const cohortHash = sha256(cohortBytes);
  const allCases = parseJsonl<SyntheticClinicalCase>(cohortBytes.toString("utf8"));
  allCases.forEach(validateSyntheticCase);

  let manifest: Record<string, unknown>;
  let studyRunId: string;
  let runDir: string;
  let selected: SyntheticClinicalCase[];
  let arms: readonly EvalArm[];
  let concurrency: number;
  let turnTimeoutMs: number;
  let maxTokens: number;
  let memoryCommitBatchTurns: number;
  let split: string;
  let allowSyntheticAma: boolean;
  let patientSimulationMode: PatientSimulationMode;
  let patientFollowUpLimit: number | undefined;
  let approvalPath: string | undefined;

  if (resume) {
    studyRunId = safeStudyRunId(required(flags, "study-run-id"));
    runDir = artifactPath(join(DEFAULT_RUNS_ROOT, studyRunId));
    manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    if (manifest.schemaVersion !== "huiyi-clinical-run-manifest/v1" || manifest.studyRunId !== studyRunId) throw new TypeError("run manifest identity or schema does not match --study-run-id");
    if (manifest.status === "completed") throw new Error("study is already complete; use clinical-eval finalize to rebuild its report");
    if (manifest.status === "running" && typeof manifest.processId === "number" && manifest.processId !== process.pid && isProcessAlive(manifest.processId)) throw new Error("another local process appears to be running this study; do not resume it concurrently");
    if (manifest.cohortSha256 !== cohortHash) throw new TypeError("resume cohort SHA-256 does not match the original run manifest");
    const currentSource = await captureEvaluationSourceFingerprint(ROOT);
    if (!manifest.sourceFingerprint || JSON.stringify(manifest.sourceFingerprint) !== JSON.stringify(currentSource)) {
      throw new Error("resume source fingerprint differs or is missing; start a new run to keep results reproducible");
    }
    if (["split", "limit", "case-ids", "arms", "concurrency", "max-tokens", "memory-commit-batch-turns", "turn-timeout-ms", "synthetic-ama-memory", "patient-simulation", "patient-followups"].some((name) => flags.has(name))) throw new Error("resume uses the frozen cohort selection and runtime settings in manifest.json");

    const caseIds = readManifestStringArray(manifest, "cohortCaseIds");
    const byId = new Map(allCases.map((item) => [item.caseId, item]));
    selected = caseIds.map((id) => {
      const item = byId.get(id);
      if (!item) throw new TypeError(`manifest references case '${id}' missing from cohort`);
      return item;
    });
    if (!selected.length || new Set(caseIds).size !== caseIds.length) throw new TypeError("manifest case selection is empty or contains duplicate IDs");
    arms = readManifestArms(manifest);
    concurrency = readManifestInteger(manifest, "concurrency", 1, 8);
    maxTokens = readManifestInteger(manifest, "maxTokens", 1, 4096);
    memoryCommitBatchTurns = typeof manifest.memoryCommitBatchTurns === "number"
      ? readManifestInteger(manifest, "memoryCommitBatchTurns", 1, 8)
      : 1;
    turnTimeoutMs = readManifestInteger(manifest, "turnTimeoutMs", 10_000, 600_000);
    split = typeof manifest.split === "string" ? manifest.split : "custom";
    patientSimulationMode = manifest.patientSimulationMode === undefined ? "scripted" : manifest.patientSimulationMode as PatientSimulationMode;
    if (patientSimulationMode !== "scripted" && patientSimulationMode !== "adaptive") throw new TypeError("run manifest contains an invalid patient simulation mode");
    patientFollowUpLimit = manifest.patientFollowUpLimit === null || manifest.patientFollowUpLimit === undefined
      ? undefined : readManifestInteger(manifest, "patientFollowUpLimit", 0, 5);
    if (patientFollowUpLimit !== undefined && patientSimulationMode !== "adaptive") throw new TypeError("scripted run manifest must not contain an adaptive patient follow-up limit");
    allowSyntheticAma = manifest.syntheticAmaMemory === true;
    if (arms.includes("integrated") && !allowSyntheticAma) throw new TypeError("integrated run manifest lacks synthetic AMA authorization");

    process.env.HUIYI_DEMO_MAX_TOKENS = String(maxTokens);
    process.env.HUIYI_MEMORY_COMMIT_BATCH_TURNS = String(memoryCommitBatchTurns);
    if (allowSyntheticAma) process.env.HUIYI_DEMO_SYNTHETIC_AMA_MEMORY = "1";
    const model = readModelConfiguration();
    const backend = process.env.HUIYI_DEMO_MODEL_BACKEND?.trim() || "vllm";
    assertCodexLunaRoute(backend, model.modelId);
    if (backend !== manifest.modelBackend || model.providerName !== manifest.providerName || model.modelId !== manifest.modelId || model.baseUrl !== manifest.modelEndpoint) throw new Error("resume model backend/provider/model/endpoint must match the original run");
    const healthEngineUrl = process.env.HUIYI_HEALTH_ENGINE_URL?.trim() || "http://127.0.0.1:8322";
    if (arms.includes("integrated") && healthEngineUrl !== manifest.healthEngineUrl) throw new Error("resume Health Engine URL must match the original run");
    const configuredApproval = typeof manifest.clinicalApprovalArtifact === "string" ? manifest.clinicalApprovalArtifact : undefined;
    approvalPath = flags.has("approval") ? resolveRepoPath(flags.get("approval")!) : configuredApproval ? resolveRepoPath(configuredApproval) : undefined;
    if (flags.has("approval") && relative(ROOT, approvalPath!) !== manifest.clinicalApprovalArtifact) throw new Error("resume approval artifact differs from the original run");
    const plannedTurns = selected.reduce((total, item) => total + item.turns.length, 0) * arms.length;
    if (manifest.plannedTurns !== plannedTurns) throw new TypeError("manifest planned turn count does not match its selected cases and arms");
  } else {
    studyRunId = safeStudyRunId(flags.get("study-run-id") ?? `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`);
    runDir = artifactPath(join(DEFAULT_RUNS_ROOT, studyRunId));
    try {
      await stat(runDir);
      throw new Error(`run directory already exists: ${relative(ROOT, runDir)}; use --resume=true`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    split = flags.get("split") ?? "development";
    if (!( ["development", "validation", "held-out", "all"] as const).includes(split as "development" | "validation" | "held-out" | "all")) throw new Error("--split must be development, validation, held-out, or all");
    const limit = integerFlag(flags, "limit", 1, 1, 300);
    const requestedIds = flags.get("case-ids")?.split(",").map((value) => value.trim()).filter(Boolean);
    if (requestedIds && new Set(requestedIds).size !== requestedIds.length) throw new Error("--case-ids contains duplicate IDs");
    const eligible = allCases.filter((item) => requestedIds?.length ? requestedIds.includes(item.caseId) : split === "all" || item.split === split);
    if (requestedIds && eligible.length !== new Set(requestedIds).size) throw new Error("--case-ids contains an unknown or duplicate case ID");
    selected = eligible.slice(0, requestedIds?.length ?? limit);
    if (!selected.length) throw new Error(`no cases found in split '${split}'`);
    const armsValue = flags.get("arms") ?? "both";
    arms = armsValue === "both" ? ["single-agent", "integrated"] : armsValue === "single-agent" || armsValue === "integrated" ? [armsValue] : (() => { throw new Error("--arms must be both, single-agent, or integrated"); })();
    if (!arms.includes("integrated") && flags.has("memory-commit-batch-turns")) throw new Error("--memory-commit-batch-turns only applies to the integrated AMA memory arm");
    memoryCommitBatchTurns = arms.includes("integrated") ? integerFlag(flags, "memory-commit-batch-turns", 4, 1, 8) : 1;
    allowSyntheticAma = flags.get("synthetic-ama-memory") === "true";
    if (flags.has("synthetic-ama-memory") && !allowSyntheticAma) throw new Error("--synthetic-ama-memory must be true when specified");
    if (arms.includes("integrated") && !allowSyntheticAma) throw new Error("integrated evaluation requires explicit --synthetic-ama-memory=true; only unique run-scoped synthetic IDs are written and removed after each case");
    if (allowSyntheticAma) process.env.HUIYI_DEMO_SYNTHETIC_AMA_MEMORY = "1";
    const requestedPatientSimulation = flags.get("patient-simulation") ?? "scripted";
    if (requestedPatientSimulation !== "scripted" && requestedPatientSimulation !== "adaptive") throw new TypeError("--patient-simulation must be scripted or adaptive");
    patientSimulationMode = requestedPatientSimulation;
    if (patientSimulationMode === "adaptive" && selected.some((item) => item.turns.some((turn) => !turn.patientPlan))) {
      throw new TypeError("adaptive patient simulation requires a v2 cohort with a patient plan for every turn");
    }
    patientFollowUpLimit = flags.has("patient-followups") ? integerFlag(flags, "patient-followups", 0, 0, 5) : undefined;
    if (patientFollowUpLimit !== undefined && patientSimulationMode !== "adaptive") throw new TypeError("--patient-followups only applies with --patient-simulation=adaptive");
    if (patientFollowUpLimit !== undefined && selected.some((item) => item.turns.some((turn) => !turn.patientPlan || patientFollowUpLimit! > turn.patientPlan.maxFollowUpMessages))) {
      throw new RangeError("--patient-followups cannot exceed a turn's frozen cohort plan");
    }
    concurrency = integerFlag(flags, "concurrency", 1, 1, 8);
    const configuredMaxTokens = process.env.HUIYI_DEMO_MAX_TOKENS ? Number(process.env.HUIYI_DEMO_MAX_TOKENS) : 1536;
    const defaultMaxTokens = Number.isSafeInteger(configuredMaxTokens) && configuredMaxTokens >= 1 && configuredMaxTokens <= 4096 ? configuredMaxTokens : 1536;
    maxTokens = integerFlag(flags, "max-tokens", defaultMaxTokens, 1, 4096);
    turnTimeoutMs = integerFlag(flags, "turn-timeout-ms", 300_000, 10_000, 600_000);
    process.env.HUIYI_DEMO_MAX_TOKENS = String(maxTokens);
    process.env.HUIYI_MEMORY_COMMIT_BATCH_TURNS = String(memoryCommitBatchTurns);
    const model = readModelConfiguration();
    const modelBackend = process.env.HUIYI_DEMO_MODEL_BACKEND?.trim() || "vllm";
    assertCodexLunaRoute(modelBackend, model.modelId);
    approvalPath = flags.has("approval") ? resolveRepoPath(flags.get("approval")!) : undefined;
    const sourceFingerprint = await captureEvaluationSourceFingerprint(ROOT);

    manifest = {
      schemaVersion: "huiyi-clinical-run-manifest/v1", studyRunId, status: "running", createdAt: new Date().toISOString(),
      cohortArtifact: relative(ROOT, cohortPath), cohortSha256: cohortHash,
      sourceFingerprint,
      patientSimulationMode,
      patientFollowUpLimit: patientFollowUpLimit ?? null,
      cohortCaseCount: selected.length, cohortCaseIds: selected.map((item) => item.caseId), split,
      plannedTurns: selected.reduce((total, item) => total + item.turns.length, 0) * arms.length,
      plannedAssistantExchangesUpperBound: upperBoundAssistantExchanges(selected, arms.length, patientSimulationMode, patientFollowUpLimit),
      arms, concurrency, turnTimeoutMs, modelBackend,
      memoryCommitBatchTurns,
      providerName: model.providerName, modelId: model.modelId, maxTokens: model.maxTokens, contextWindow: model.contextWindow,
      modelEndpoint: model.baseUrl, healthEngineUrl: process.env.HUIYI_HEALTH_ENGINE_URL?.trim() || "http://127.0.0.1:8322",
      syntheticAmaMemory: arms.includes("integrated"),
      amaMemoryPolicy: arms.includes("integrated") ? {
        automaticRecall: "first-turn-per-Encounter; explicit recall tool remains available",
        commitBatchTurns: memoryCommitBatchTurns,
        recallWindowIsolation: "enabled in the isolated Health Engine",
        persistedContent: "patient-originated messages only; assistant output is excluded from longitudinal patient memory",
      } : null,
      hardware: process.env.HUIYI_EVAL_HARDWARE?.trim() || null,
      node: process.version, platform: process.platform, architecture: process.arch, processId: process.pid,
      clinicalApprovalArtifact: approvalPath ? relative(ROOT, approvalPath) : null,
      outputs: { runs: "runs.jsonl", attemptHistory: "attempt-history.jsonl", memoryTrace: "memory-trace.jsonl", reviewPackets: "review-packets.jsonl", drafts: "draft-bundles.jsonl", report: "score-report.json", privateReviewKey: `artifacts/clinical-eval/private/${studyRunId}/review-key.json`, privateReviewTemplates: `artifacts/clinical-eval/private/${studyRunId}/review-templates.jsonl` },
    };
    await mkdir(dirname(runDir), { recursive: true });
    await mkdir(runDir);
  }

  const runsFile = join(runDir, "runs.jsonl");
  const draftsFile = join(runDir, "draft-bundles.jsonl");
  const memoryTraceFile = join(runDir, "memory-trace.jsonl");
  const manifestPath = join(runDir, "manifest.json");
  process.env.HUIYI_MEMORY_TRACE_FILE = memoryTraceFile;
  if (arms.includes("integrated")) {
    const route = await checkHealthEngineRoute(readModelConfiguration());
    if (resume && manifest.healthEngineRoute && JSON.stringify(manifest.healthEngineRoute) !== JSON.stringify(route)) throw new Error("resume Health Engine route attestation differs from the original run");
    manifest.healthEngineRoute = route;
  }
  let completedTaskKeys: string[] = [];
  if (resume) {
    const oldRuns = await readResumableJsonl<ClinicalRunRecord>(runsFile);
    if (oldRuns.droppedIncompleteTail) process.stderr.write("clinical-eval: discarded one incomplete trailing runs.jsonl write before resume\n");
    const complete = classifyCompletedTasks(selected, arms, oldRuns.records);
    completedTaskKeys = [...complete.completedKeys];
    const incompleteKeys = new Set(complete.incompleteKeys);
    const staleRecords = oldRuns.records.filter((record) => incompleteKeys.has(clinicalTaskKey(record.caseId, record.arm)));
    if (staleRecords.length) {
      await appendJsonl(join(runDir, "attempt-history.jsonl"), staleRecords);
      await atomicWriteJsonl(runsFile, oldRuns.records.filter((record) => !incompleteKeys.has(clinicalTaskKey(record.caseId, record.arm))));
    } else if (oldRuns.needsRewrite) await atomicWriteJsonl(runsFile, oldRuns.records);
    const oldDrafts = await readResumableJsonl<{ runId: string }>(draftsFile).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], droppedIncompleteTail: false, needsRewrite: false };
      throw error;
    });
    const staleRunIds = new Set(staleRecords.map((record) => record.runId));
    const staleDrafts = oldDrafts.records.filter((draft) => staleRunIds.has(draft.runId));
    if (staleDrafts.length) {
      await appendJsonl(join(runDir, "attempt-drafts.jsonl"), staleDrafts);
      await atomicWriteJsonl(draftsFile, oldDrafts.records.filter((draft) => !staleRunIds.has(draft.runId)));
    } else if (oldDrafts.needsRewrite) await atomicWriteJsonl(draftsFile, oldDrafts.records);
    const stalePacketIds = new Set(staleRecords.map((record) => `RPK-${createHash("sha256").update(`${studyRunId}\0${record.caseId}\0${record.turnId}\0${record.arm}`).digest("hex").slice(0, 24)}`));
    const packetPath = join(runDir, "review-packets.jsonl");
    const packets = await readResumableJsonl<ClinicalBlindReviewPacket>(packetPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], droppedIncompleteTail: false, needsRewrite: false };
      throw error;
    });
    if (stalePacketIds.size || packets.needsRewrite) await atomicWriteJsonl(packetPath, packets.records.filter((packet) => !stalePacketIds.has(packet.packetId)));
    const attempts = Array.isArray(manifest.resumeAttempts) ? manifest.resumeAttempts as unknown[] : [];
    attempts.push({ resumedAt: new Date().toISOString(), completeCaseArmTasksRetained: completedTaskKeys.length, pendingCaseArmTasks: complete.incompleteKeys.length });
    manifest.resumeAttempts = attempts;
    manifest.status = "running";
    manifest.processId = process.pid;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  let writes = Promise.resolve();
  const append = (path: string, value: unknown): Promise<void> => {
    writes = writes.then(() => appendFile(path, `${JSON.stringify(value)}\n`, "utf8"));
    return writes;
  };
  let completed = 0;
  try {
    const totalTasks = selected.flatMap((item) => arms.map((arm) => clinicalTaskKey(item.caseId, arm)));
    const pendingCount = totalTasks.filter((key) => !completedTaskKeys.includes(key)).length;
    if (!pendingCount) {
      const finalizeFlags = new Map<string, string>([["run-dir", relative(ROOT, runDir)]]);
      if (approvalPath) finalizeFlags.set("approval", relative(ROOT, approvalPath));
      await finalizeRunCommand(finalizeFlags);
      return;
    }
    const result = await runClinicalBenchmark(selected, {
      studyRunId, authorizationCases: allCases, arms, concurrency, turnTimeoutMs, completedTaskKeys, patientSimulationMode, patientFollowUpLimit,
      onRecord: async (record) => {
        await append(runsFile, record);
        completed++;
        if (completed % 10 === 0 || completed === selected.reduce((total, item) => total + item.turns.length, 0) * arms.length) process.stdout.write(`completed turns ${completed}/${selected.reduce((total, item) => total + item.turns.length, 0) * arms.length}\n`);
      },
      onDraftBundle: async (draft) => append(draftsFile, draft),
    });
    await writes;
    if (result.healthEngineRoute) manifest.healthEngineRoute = result.healthEngineRoute;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const finalizeFlags = new Map<string, string>([["run-dir", relative(ROOT, runDir)]]);
    if (approvalPath) finalizeFlags.set("approval", relative(ROOT, approvalPath));
    await finalizeRunCommand(finalizeFlags);
  } catch (error) {
    await writes;
    const durable = await readResumableJsonl<ClinicalRunRecord>(runsFile).catch(() => ({ records: [] as ClinicalRunRecord[], droppedIncompleteTail: false, needsRewrite: false }));
    Object.assign(manifest, { status: "failed", failedAt: new Date().toISOString(), completedTurns: durable.records.length, turnsWrittenThisAttempt: completed, error: error instanceof Error ? error.message : "unknown error" });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    throw error;
  }
}

async function scoreCommand(flags: Map<string, string>): Promise<void> {
  assertFlags(flags, ["runs", "reviews", "cohort", "approval", "isolation-probes", "output"]);
  const runsPath = resolveRepoPath(required(flags, "runs"));
  const reviewsPath = resolveRepoPath(required(flags, "reviews"));
  const cohortPath = resolveRepoPath(flags.get("cohort") ?? DEFAULT_COHORT);
  const cohortBytes = await readFile(cohortPath);
  const runs = parseJsonl<ClinicalRunRecord>(await readFile(runsPath, "utf8"));
  const reviews = parseJsonl<ClinicalReviewRecord>(await readFile(reviewsPath, "utf8"));
  const approvalPath = flags.get("approval") ? resolveRepoPath(flags.get("approval")!) : undefined;
  const approval = approvalPath ? JSON.parse(await readFile(approvalPath, "utf8")) as ClinicalCohortApproval : undefined;
  const isolationProbes = flags.has("isolation-probes") ? await readJsonl<import("./contracts.js").IsolationProbeRecord>(resolveRepoPath(required(flags, "isolation-probes"))) : [];
  const report = scoreClinicalRuns(applyClinicalApproval({ runs, approval, cohortSha256: sha256(cohortBytes) }), reviews, isolationProbes);
  const output = artifactPath(flags.get("output") ?? join(dirname(relative(ROOT, runsPath)), "score-report.json"));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: relative(ROOT, output), runCount: report.runCount, pairedStatus: report.pairedTaskCompletionDelta.status })}\n`);
}

async function isolationProbeCommand(flags: Map<string, string>): Promise<void> {
  assertFlags(flags, ["run-dir", "output", "synthetic-only"]);
  if (flags.get("synthetic-only") !== "true") throw new Error("isolation-probe requires --synthetic-only=true because it writes and then deletes unique synthetic AMA memory");
  const output = artifactPath(flags.get("output") ?? (flags.has("run-dir") ? join(required(flags, "run-dir"), "isolation-probes.jsonl") : "artifacts/clinical-eval/isolation-probes.jsonl"));
  const result = await runCrossPatientMemoryIsolationProbe();
  await mkdir(dirname(output), { recursive: true });
  await appendFile(output, `${JSON.stringify(result)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: relative(ROOT, output), status: result.status, ownRecallMatched: result.ownRecallMatched, crossPatientCanaryLeak: result.crossPatientCanaryLeak, cleanup: result.cleanup, scope: result.scope })}\n`);
  if (result.status === "fail") process.exitCode = 2;
}

async function mergeReviewsCommand(flags: Map<string, string>): Promise<void> {
  assertFlags(flags, ["packets", "key", "output"]);
  const packetsPath = resolveRepoPath(required(flags, "packets"));
  const keyPath = resolveRepoPath(required(flags, "key"));
  const packets = parseJsonl<ClinicalBlindReviewPacket>(await readFile(packetsPath, "utf8"));
  const key = JSON.parse(await readFile(keyPath, "utf8")) as ClinicalReviewKeyEntry[];
  const reviews = mergeBlindedReviews({ packets, key });
  const output = artifactPath(flags.get("output") ?? join(dirname(keyPath), "reviews-merged.jsonl"));
  await mkdir(dirname(output), { recursive: true });
  await writeJsonl(output, reviews);
  process.stdout.write(`${JSON.stringify({ output: relative(ROOT, output), mergedReviews: reviews.length, adjudicated: reviews.filter((review) => review.status === "adjudicated").length })}\n`);
}

async function finalizeRunCommand(flags: Map<string, string>): Promise<void> {
  assertFlags(flags, ["run-dir", "cohort", "approval", "isolation-probes"]);
  const runDir = artifactPath(required(flags, "run-dir"));
  const manifestPath = join(runDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  if (typeof manifest.studyRunId !== "string" || typeof manifest.cohortSha256 !== "string") throw new TypeError("run manifest is missing its study ID or cohort hash");
  const cohortPath = resolveRepoPath(flags.get("cohort") ?? String(manifest.cohortArtifact ?? DEFAULT_COHORT));
  const cohortBytes = await readFile(cohortPath);
  if (sha256(cohortBytes) !== manifest.cohortSha256) throw new TypeError("run cohort file changed after execution");
  const cases = parseJsonl<SyntheticClinicalCase>(cohortBytes.toString("utf8"));
  cases.forEach(validateSyntheticCase);
  const records = await readJsonl<ClinicalRunRecord>(join(runDir, "runs.jsonl"));
  const drafts = await readJsonl<{ runId: string }>(join(runDir, "draft-bundles.jsonl")).catch(() => []);
  const exportedRunIds = new Set(drafts.map((draft) => draft.runId));
  const arms = [...new Set(records.map((run) => run.arm))];
  const unblindKey = makeUnblindKey(manifest.studyRunId);
  const privateDir = artifactPath(join("artifacts/clinical-eval/private", manifest.studyRunId));
  const mergedReviews = await readJsonl<ClinicalReviewRecord>(join(privateDir, "reviews-merged.jsonl")).catch(() => []);
  const mergedReviewByRun = new Map<string, ClinicalReviewRecord>(mergedReviews.map((review) => [review.runId, review] as const));
  if (mergedReviewByRun.size !== mergedReviews.length) throw new TypeError("merged review run IDs must be unique");
  const reviews: ClinicalReviewRecord[] = [];
  const packets: ClinicalBlindReviewPacket[] = [];
  const reviewKey: ClinicalReviewKeyEntry[] = [];
  const existingPackets = await readJsonl<ClinicalBlindReviewPacket>(join(runDir, "review-packets.jsonl")).catch(() => []);
  const existingPacketById = new Map<string, ClinicalBlindReviewPacket>(existingPackets.map((packet) => [packet.packetId, packet] as const));
  if (existingPacketById.size !== existingPackets.length) throw new TypeError("existing blind packet IDs must be unique");
  const runsByKey = new Map<string, ClinicalRunRecord>(records.map((run) => [`${run.caseId}\0${run.turnId}\0${run.arm}`, run] as const));
  for (const item of cases) {
    const conversations = new Map(arms.map((arm) => [arm, [] as { role: "patient" | "assistant"; text: string }[]]));
    for (const turn of item.turns) {
      const turnRuns = new Map<string, ClinicalRunRecord>();
      for (const arm of arms) {
        const run = runsByKey.get(`${item.caseId}\0${turn.turnId}\0${arm}`);
        if (!run) continue;
        turnRuns.set(arm, run);
        const template = createReviewTemplate({ run, case: item, turn, blindedArm: unblindKey[arm], draftExported: exportedRunIds.has(run.runId) });
        const merged = mergedReviewByRun.get(run.runId);
        if (merged && (merged.caseId !== run.caseId || merged.turnId !== run.turnId || merged.blindedArm !== unblindKey[arm])) throw new TypeError(`merged review does not match its blinded run ${run.runId}`);
        const review = merged ?? template;
        reviews.push(review);
        const packetId = `RPK-${createHash("sha256").update(`${manifest.studyRunId}\0${item.caseId}\0${turn.turnId}\0${arm}`).digest("hex").slice(0, 24)}`;
        const existingPacket = existingPacketById.get(packetId);
        if (existingPacket && (existingPacket.caseId !== run.caseId || existingPacket.turnId !== run.turnId || existingPacket.blindedArm !== unblindKey[arm])) throw new TypeError(`existing blind packet does not match run ${run.runId}`);
        const evidenceMetadata = existingPacket?.evidenceMetadata?.map((hit) => ({ ...hit, snippet: typeof hit.snippet === "string" ? hit.snippet.slice(0, 500) : "" }))
          ?? run.evidence.map((hit) => ({ ...hit, snippet: "" }));
        packets.push(makeBlindReviewPacket({ packetId, blindedArm: review.blindedArm, case: item, turn, review, patientMessage: run.patientMessage, conversationSoFar: [...conversations.get(arm)!, ...runTranscript(run, turn.patientMessage)], assistantText: run.assistantText, evidenceMetadata }));
        reviewKey.push({ packetId, runId: run.runId, caseId: run.caseId, turnId: run.turnId, actualArm: run.arm, blindedArm: unblindKey[arm] });
      }
      for (const arm of arms) {
        const conversation = conversations.get(arm)!;
        const run = turnRuns.get(arm);
        conversation.push(...(run ? runTranscript(run, turn.patientMessage) : [{ role: "patient" as const, text: turn.patientMessage }]));
      }
    }
  }
  await mkdir(privateDir, { recursive: true });
  await writeJsonl(join(runDir, "review-packets.jsonl"), packets);
  await writeJsonl(join(privateDir, "review-templates.jsonl"), reviews);
  await writeFile(join(privateDir, "review-key.json"), `${JSON.stringify(reviewKey, null, 2)}\n`, "utf8");
  await writeFile(join(privateDir, "unblind-key.json"), `${JSON.stringify(unblindKey, null, 2)}\n`, "utf8");
  const approvalPath = flags.get("approval") ? resolveRepoPath(flags.get("approval")!) : undefined;
  const approval = approvalPath ? JSON.parse(await readFile(approvalPath, "utf8")) as ClinicalCohortApproval : undefined;
  const isolationProbePath = flags.get("isolation-probes") ? resolveRepoPath(flags.get("isolation-probes")!) : join(runDir, "isolation-probes.jsonl");
  const isolationProbes = await readJsonl<import("./contracts.js").IsolationProbeRecord>(isolationProbePath).catch(() => []);
  const plannedTurns = typeof manifest.plannedTurns === "number" ? manifest.plannedTurns : null;
  if (plannedTurns !== null && records.length > plannedTurns) throw new TypeError("runs.jsonl contains more turns than the frozen run plan");
  const executionComplete = plannedTurns !== null && plannedTurns === records.length && records.every((run) => run.status === "completed");
  const report = scoreClinicalRuns(applyClinicalApproval({ runs: records, approval: executionComplete ? approval : undefined, cohortSha256: sha256(cohortBytes) }), reviews, isolationProbes);
  await writeFile(join(runDir, "score-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  Object.assign(manifest, {
    status: executionComplete ? "completed" : "partial",
    finalizedAt: new Date().toISOString(), completedTurns: records.length,
    completedRuns: records.filter((run) => run.status === "completed").length,
    failedRuns: records.filter((run) => run.status === "failed").length,
    cancelledRuns: records.filter((run) => run.status === "cancelled").length,
    clinicalMetricsStatus: report.pairedTaskCompletionDelta.status,
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: manifest.status, runDirectory: relative(ROOT, runDir), records: records.length, blindedReviewPackets: packets.length, clinicalMetricsStatus: report.pairedTaskCompletionDelta.status, memoryIsolation: report.security.crossPatientMemoryIsolation.status })}\n`);
}

function parseArgs(values: readonly string[]): Args {
  if (!values.length) return { command: "help", flags: new Map() };
  const [command, ...rest] = values;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const raw = rest[index]!;
    if (!raw.startsWith("--")) throw new Error(`unexpected argument '${raw}'`);
    const [name, inline] = raw.slice(2).split("=", 2);
    if (!name || flags.has(name)) throw new Error(`invalid or repeated option '${raw}'`);
    const value = inline ?? rest[++index];
    if (!value || value.startsWith("--")) throw new Error(`option --${name} requires a value`);
    flags.set(name, value);
  }
  return { command: command!, flags };
}

function assertFlags(flags: Map<string, string>, allowed: readonly string[]): void {
  for (const name of flags.keys()) if (!allowed.includes(name)) throw new Error(`unknown option --${name}`);
}

function integerFlag(flags: Map<string, string>, name: string, fallback: number, min: number, max: number): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`--${name} must be an integer from ${min} to ${max}`);
  return value;
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function resolveRepoPath(value: string): string { return isAbsolute(value) ? resolve(value) : resolve(ROOT, value); }

function artifactPath(value: string): string {
  const path = resolveRepoPath(value);
  const root = resolve(ROOT, "artifacts/clinical-eval");
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error("clinical-eval outputs must stay under artifacts/clinical-eval");
  return path;
}

async function readJsonl<T>(path: string): Promise<T[]> { return parseJsonl<T>(await readFile(path, "utf8")); }

async function readResumableJsonl<T>(path: string): Promise<{ records: T[]; droppedIncompleteTail: boolean; needsRewrite: boolean }> {
  const content = await readFile(path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  if (!content.trim()) return { records: [], droppedIncompleteTail: false, needsRewrite: false };
  const terminated = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (terminated) lines.pop();
  const records: T[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as T); }
    catch (error) {
      if (!terminated && index === lines.length - 1) return { records, droppedIncompleteTail: true, needsRewrite: true };
      throw new SyntaxError(`invalid JSONL at line ${index + 1} in ${path}`, { cause: error });
    }
  }
  return { records, droppedIncompleteTail: false, needsRewrite: !terminated };
}

function classifyCompletedTasks(cases: readonly SyntheticClinicalCase[], arms: readonly EvalArm[], records: readonly ClinicalRunRecord[]): { completedKeys: Set<string>; incompleteKeys: string[] } {
  const expected = new Map<string, Set<string>>();
  for (const item of cases) for (const arm of arms) expected.set(clinicalTaskKey(item.caseId, arm), new Set(item.turns.map((turn) => turn.turnId)));
  const grouped = new Map<string, Map<string, ClinicalRunRecord>>();
  const runIds = new Set<string>();
  for (const record of records) {
    if (!runIds.add(record.runId)) throw new TypeError(`duplicate runId '${record.runId}' in runs.jsonl`);
    const key = clinicalTaskKey(record.caseId, record.arm);
    const turns = expected.get(key);
    if (!turns || !turns.has(record.turnId)) throw new TypeError(`runs.jsonl contains a turn outside the frozen study plan: ${record.caseId}/${record.turnId}/${record.arm}`);
    const rows = grouped.get(key) ?? new Map<string, ClinicalRunRecord>();
    if (rows.has(record.turnId)) throw new TypeError(`runs.jsonl contains a duplicate task turn: ${record.caseId}/${record.turnId}/${record.arm}`);
    rows.set(record.turnId, record);
    grouped.set(key, rows);
  }
  const completedKeys = new Set<string>();
  const incompleteKeys: string[] = [];
  for (const [key, turnIds] of expected) {
    const rows = grouped.get(key);
    if (rows?.size === turnIds.size && [...turnIds].every((id) => rows.get(id)?.status === "completed")) completedKeys.add(key);
    else incompleteKeys.push(key);
  }
  return { completedKeys, incompleteKeys };
}

async function appendJsonl(path: string, records: readonly unknown[]): Promise<void> {
  if (!records.length) return;
  const existing = await readResumableJsonl<unknown>(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], droppedIncompleteTail: false, needsRewrite: false };
    throw error;
  });
  await atomicWriteJsonl(path, [...existing.records, ...records]);
}

async function atomicWriteJsonl(path: string, records: readonly unknown[]): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, toJsonl(records), "utf8");
  await rename(temporary, path);
}

function safeStudyRunId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value) || value === "." || value === "..") throw new TypeError("study run ID must contain only letters, numbers, dot, underscore, or dash");
  return value;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function readManifestStringArray(manifest: Record<string, unknown>, key: string): string[] {
  const value = manifest[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new TypeError(`run manifest field '${key}' must be a string array`);
  return value as string[];
}

function readManifestArms(manifest: Record<string, unknown>): EvalArm[] {
  const arms = readManifestStringArray(manifest, "arms");
  if (!arms.length || arms.some((arm) => arm !== "single-agent" && arm !== "integrated") || new Set(arms).size !== arms.length) throw new TypeError("run manifest contains invalid evaluation arms");
  return arms as EvalArm[];
}

function readManifestInteger(manifest: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = manifest[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`run manifest field '${key}' must be an integer from ${min} to ${max}`);
  return value;
}

function upperBoundAssistantExchanges(
  cases: readonly SyntheticClinicalCase[], armCount: number, mode: PatientSimulationMode, patientFollowUpLimit?: number,
): number {
  const exchangesPerArm = cases.reduce((sum, item) => sum + item.turns.reduce((turnSum, turn) => {
    const followUps = mode === "adaptive" && turn.patientPlan
      ? Math.min(turn.patientPlan.maxFollowUpMessages, patientFollowUpLimit ?? turn.patientPlan.maxFollowUpMessages)
      : 0;
    return turnSum + 1 + followUps;
  }, 0), 0);
  return exchangesPerArm * armCount;
}

function runTranscript(run: ClinicalRunRecord, fallbackPatientMessage: string): readonly { role: "patient" | "assistant"; text: string }[] {
  return run.patientSimulation?.transcript ?? [
    { role: "patient", text: run.patientMessage || fallbackPatientMessage },
    ...(run.assistantText ? [{ role: "assistant" as const, text: run.assistantText }] : []),
  ];
}

function parseJsonl<T>(content: string): T[] {
  return content.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line) as T; }
    catch { throw new SyntaxError(`invalid JSONL at line ${index + 1}`); }
  });
}

async function writeJsonl(path: string, values: readonly unknown[]): Promise<void> {
  await writeFile(path, toJsonl(values), "utf8");
}

function toJsonl(values: readonly unknown[]): string { return values.map((value) => JSON.stringify(value)).join("\n") + "\n"; }
function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function splitCounts(cases: readonly SyntheticClinicalCase[]): Record<string, number> {
  return { development: cases.filter((item) => item.split === "development").length, validation: cases.filter((item) => item.split === "validation").length, "held-out": cases.filter((item) => item.split === "held-out").length };
}

function printHelp(): void {
  process.stdout.write([
    "Clinical synthetic evaluation commands:",
    "  generate --count=300 [--seed=20261010] [--output=artifacts/clinical-eval/cohort-300.jsonl]",
    "  validate [--cohort=artifacts/clinical-eval/cohort-300.jsonl] [--output=artifacts/clinical-eval/cohort-audit.json]",
    "  plan [--cohort=...] [--split=development|validation|held-out|all] [--limit=1] [--arms=both|single-agent|integrated] [--patient-simulation=scripted|adaptive] [--patient-followups=0..3] [--output=artifacts/clinical-eval/plans/plan.json]",
    "  review-packet [--cohort=...] [--split=development|validation|held-out|all] [--limit=30] [--output=artifacts/clinical-eval/reviews/review-packet.json] [--crosswalk-output=artifacts/clinical-eval/private/cohort-reviews/crosswalk.json]",
    "  approve-packet --cohort=... --packet=... --crosswalk=... --output=<new-approval.json>",
    "  approval-template [--cohort=...] [--output=...approval.json]",
    "  run [--cohort=...] [--split=development|validation|held-out|all] [--case-ids=HCE-0001,...] [--limit=1] [--arms=both|single-agent|integrated] [--concurrency=1] [--max-tokens=1536] [--approval=...]",
    "      Patient protocol: --patient-simulation=scripted|adaptive (default scripted; adaptive requires a v2 cohort and re-review).",
    "      Bound adaptive cost with --patient-followups=0..3; the cap is frozen in the run manifest.",
    "      Resume an interrupted run with: run --study-run-id=<id> --resume=true [--cohort=...]",
    "  isolation-probe --synthetic-only=true [--run-dir=artifacts/clinical-eval/runs/<studyRunId> | --output=...jsonl]",
    "  finalize --run-dir=artifacts/clinical-eval/runs/<studyRunId> [--cohort=...] [--approval=...] [--isolation-probes=...jsonl]",
    "      Integrated runs also require --synthetic-ama-memory=true; per-run synthetic memory is erased after each case.",
    "  score --runs=... --reviews=... [--cohort=...] [--approval=...] [--isolation-probes=...jsonl --output=...]",
    "  merge-reviews --packets=<reviewer-edited-blind-jsonl> --key=artifacts/clinical-eval/private/<run>/review-key.json [--output=...internal.jsonl]",
    "All generated cohorts are pending clinical review. Evaluation artifacts are local synthetic data; runs need a loopback model route, and the integrated arm additionally needs local Health Engine RAG + synthetic AMA memory.",
  ].join("\n") + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`clinical-eval: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
