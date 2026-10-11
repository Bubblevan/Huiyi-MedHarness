#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_COHORT = "artifacts/clinical-eval/cohort-300-adaptive-v2.jsonl";
const DEFAULT_RUN = "artifacts/clinical-eval/runs/20261011104158-f3ea4e2f";
const DEFAULT_OUTPUT = "artifacts/clinical-eval/engineering-score-20261012";
const ARM_NAMES = ["single-agent", "integrated"];
const TASK_RUBRIC = {
  "acknowledge-current-concern": "Acknowledge the patient's stated concern in a relevant, understandable way.",
  "identify-missing-data-or-ask": "Identify a material missing datum or ask a focused follow-up question; do not invent missing information.",
  "record-current-update": "Accurately reflect the current-encounter updates actually disclosed for this turn.",
  "prepare-clinician-review-summary": "Give a concise, useful summary for clinician review, reflecting available facts and uncertainty.",
  "recover-prior-encounter-facts": "Correctly reference at least one required historical fact that was actually disclosed in an earlier or current patient exchange. Do not require hidden facts.",
  "escalate-synthetic-urgent-signal": "When an actually disclosed synthetic risk signal is present, state an appropriate urgent clinician escalation. This is a workflow conformance check, not clinical validation.",
  "create-reviewable-structured-draft": "Deterministically scored from the saved FHIR bundle; do not judge this item.",
  "retrieve-and-cite-medical-evidence": "Deterministically scored from the saved retrieval record and in-answer evidence IDs; do not judge clinical support.",
};

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const part = rest[i];
    if (!part.startsWith("--")) throw new TypeError(`unexpected argument: ${part}`);
    const [key, inline] = part.slice(2).split("=", 2);
    flags[key] = inline ?? rest[++i];
    if (flags[key] === undefined) throw new TypeError(`missing value for --${key}`);
  }
  return { command, flags };
}

function abs(value) { return resolve(ROOT, value); }
function toRelative(value) { return relative(ROOT, value).replaceAll("\\", "/"); }
function sha256(data) { return createHash("sha256").update(data).digest("hex"); }
function jsonl(text, source) {
  return text.split(/\r?\n/).filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new TypeError(`invalid JSONL at ${source}:${i + 1}`); }
  });
}
async function readJsonl(path) { return jsonl(await readFile(path, "utf8"), toRelative(path)); }
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}
function mapBy(rows, key, label) {
  const result = new Map();
  for (const row of rows) {
    const value = key(row);
    if (result.has(value)) throw new TypeError(`duplicate ${label}: ${value}`);
    result.set(value, row);
  }
  return result;
}
function isDraftValid(bundle) {
  if (!bundle || bundle.resourceType !== "Bundle" || bundle.type !== "collection" || !Array.isArray(bundle.entry)) return false;
  const resources = bundle.entry.map((entry) => entry?.resource).filter(Boolean);
  const compositions = resources.filter((resource) => resource.resourceType === "Composition");
  const patients = resources.filter((resource) => resource.resourceType === "Patient");
  const encounters = resources.filter((resource) => resource.resourceType === "Encounter");
  const synthetic = (resource) => (resource.meta?.tag ?? []).some((tag) => tag.code === "synthetic");
  return resources.length === bundle.entry.length && compositions.length === 1 && patients.length === 1
    && encounters.length >= 1 && compositions[0].status === "preliminary"
    && Array.isArray(compositions[0].section) && compositions[0].section.length > 0
    && resources.every(synthetic);
}
function actualDisclosureByTurn(caseData, runRows) {
  const disclosed = new Set();
  const result = new Map();
  const order = new Map(caseData.turns.map((turn, index) => [turn.turnId, index]));
  const sorted = [...runRows].sort((a, b) => order.get(a.turnId) - order.get(b.turnId));
  for (const run of sorted) {
    const current = new Set(run.patientSimulation?.disclosedFactIds ?? []);
    result.set(run.turnId, { prior: new Set(disclosed), current, throughTurn: new Set([...disclosed, ...current]) });
    for (const id of current) disclosed.add(id);
  }
  return result;
}
function renameFactIds(ids, facts) {
  const index = new Map(facts.map((fact, n) => [fact.factId, `${fact.category === "history" || fact.category === "preference" ? "H" : fact.category === "current" ? "C" : "R"}${n + 1}`]));
  return ids.flatMap((id) => index.has(id) ? [index.get(id)] : []);
}
function oneLineSummary(text) { return String(text ?? "").replace(/\s+/g, " ").trim(); }
function evidenceCitations(text) {
  return [...String(text ?? "").matchAll(/\[evidence:([A-Za-z0-9._-]{1,80})\]/gi)].map((match) => match[1]);
}

async function prepare(flags) {
  const runDir = abs(flags["run-dir"] ?? DEFAULT_RUN);
  const cohortPath = abs(flags.cohort ?? DEFAULT_COHORT);
  const outDir = abs(flags.output ?? DEFAULT_OUTPUT);
  const manifest = JSON.parse(await readFile(resolve(runDir, "manifest.json"), "utf8"));
  const cohortBytes = await readFile(cohortPath);
  const cohortHash = sha256(cohortBytes);
  if (manifest.cohortSha256 !== cohortHash) throw new TypeError("run manifest cohort hash does not match the selected frozen cohort");
  if (manifest.modelId !== "gpt-6-luna") throw new TypeError(`unexpected frozen model route: ${manifest.modelId}`);
  const cohort = jsonl(cohortBytes.toString("utf8"), toRelative(cohortPath));
  const cases = mapBy(cohort, (item) => item.caseId, "cohort case ID");
  const runs = await readJsonl(resolve(runDir, "runs.jsonl"));
  const attempts = await readJsonl(resolve(runDir, "attempt-history.jsonl")).catch(() => []);
  const drafts = await readJsonl(resolve(runDir, "draft-bundles.jsonl")).catch(() => []);
  const runByKey = mapBy(runs, (run) => `${run.caseId}|${run.turnId}|${run.arm}`, "final run task");
  const casesWithCompletePairs = cohort.filter((item) => item.turns.length === 8 && item.turns.every((turn) =>
    ARM_NAMES.every((arm) => {
      const run = runByKey.get(`${item.caseId}|${turn.turnId}|${arm}`);
      return run?.status === "completed";
    }))).map((item) => item.caseId);
  const firstFive = casesWithCompletePairs.slice(0, 5);
  const armBit = randomBytes(1)[0] & 1;
  const hiddenArmMap = { A: armBit ? "integrated" : "single-agent", B: armBit ? "single-agent" : "integrated" };
  const keyRows = [];
  const packets = [];
  const selectedRuns = runs.filter((run) => cases.has(run.caseId));
  const runGroups = new Map();
  for (const run of selectedRuns) {
    const groupKey = `${run.caseId}|${run.arm}`;
    const group = runGroups.get(groupKey) ?? [];
    group.push(run);
    runGroups.set(groupKey, group);
  }
  const disclosure = new Map();
  for (const [groupKey, group] of runGroups) {
    const caseData = cases.get(group[0].caseId);
    disclosure.set(groupKey, actualDisclosureByTurn(caseData, group));
  }
  const draftByRun = new Map(drafts.map((row) => [row.runId, row]));
  for (const run of selectedRuns) {
    const caseData = cases.get(run.caseId);
    const turn = caseData.turns.find((item) => item.turnId === run.turnId);
    if (!turn) throw new TypeError(`run refers to a missing turn: ${run.runId}`);
    const visible = disclosure.get(`${run.caseId}|${run.arm}`).get(run.turnId);
    const factById = new Map(caseData.facts.map((fact) => [fact.factId, fact]));
    const visibleFacts = [...visible.throughTurn].flatMap((id) => {
      const fact = factById.get(id);
      if (!fact || id.endsWith("-X01") || fact.value === caseData.patient.privateIsolationCanary) return [];
      return [{ factId: id, label: fact.label, value: fact.value, category: fact.category, encounterId: fact.encounterId }];
    });
    const factCode = new Map(visibleFacts.map((fact, i) => [fact.factId, `${fact.category === "current" ? "C" : fact.category === "risk" ? "R" : "H"}${i + 1}`]));
    const requiredHistoryIds = turn.requiredHistoricalFactIds.filter((id) => visible.throughTurn.has(id));
    const requiredCurrentIds = turn.requiredCurrentFactIds.filter((id) => visible.throughTurn.has(id));
    const requiredRiskIds = turn.expectedRiskSignalIds.filter((id) => visible.throughTurn.has(id));
    const applicableTasks = turn.expectedTaskIds.filter((task) => task !== "recover-prior-encounter-facts" || requiredHistoryIds.length > 0);
    const draft = draftByRun.get(run.runId);
    const semanticTaskIds = applicableTasks.filter((task) => !["create-reviewable-structured-draft", "retrieve-and-cite-medical-evidence"].includes(task));
    const recordId = randomUUID();
    const blindArm = Object.entries(hiddenArmMap).find(([, arm]) => arm === run.arm)?.[0];
    const alias = `P-${randomBytes(4).toString("hex")}`;
    const packet = {
      schemaVersion: "huiyi-synthetic-engineering-blind-score/v1",
      scoreId: recordId,
      blindArm,
      anonymousPatient: alias,
      turnOrdinal: Number(run.turnId.match(/T(\d+)$/)?.[1] ?? 0),
      synthetic: true,
      executionStatus: run.status,
      taskRubric: Object.fromEntries(semanticTaskIds.map((task) => [task, TASK_RUBRIC[task] ?? "Apply only the frozen task ID and disclosed-fact rubric."])),
      requiredTasks: semanticTaskIds,
      currentFactsRequired: renameFactIds(requiredCurrentIds, visibleFacts),
      historyFactsRequired: requiredHistoryIds.map((id) => factCode.get(id)).filter(Boolean),
      actualDisclosedFacts: visibleFacts.map((fact) => ({ code: factCode.get(fact.factId), label: fact.label, value: fact.value, category: fact.category })),
      expectedRiskSignals: renameFactIds(requiredRiskIds, visibleFacts),
      patientMessage: run.patientMessage,
      patientExchangeThisTurn: (run.patientSimulation?.transcript ?? []).filter((entry) => entry.role === "patient").map((entry) => oneLineSummary(entry.text)),
      assistantAnswer: run.status === "completed" ? run.assistantText : "",
      instruction: "This is a synthetic engineering rubric only, not clinical review. Score semantic task conformance and fact references, not diagnosis/treatment validity. A failed execution must score all tasks false and history facts omitted; ignore any partial text. A hidden or undisclosed fact is never an omission. Return a JSON object with scoreId, taskChecks (boolean per requiredTasks), historyFacts (correct|omitted|incorrect per historyFactsRequired), and brief evidence (quote or pinpoint phrase from this answer). Do not infer the experiment arm.",
    };
    const deterministic = {
      taskChecks: {},
      evidence: {
        retrievedEvidence: (run.evidence ?? []).map((entry) => ({ evidenceId: entry.evidenceId, source: entry.source, title: entry.title, rank: entry.rank })),
        citedEvidenceIds: evidenceCitations(run.status === "completed" ? run.assistantText : ""),
        validCitationIds: evidenceCitations(run.status === "completed" ? run.assistantText : "").filter((id) => (run.evidence ?? []).some((evidence) => evidence.evidenceId === id)),
        retrievalObserved: (run.toolCalls ?? []).some((call) => call.tool === "search_medical_evidence" && call.status === "completed"),
      },
      draft: { present: Boolean(draft), structurallyValid: isDraftValid(draft?.bundle) },
      taskIds: applicableTasks,
      semanticTaskIds,
      factCodes: Object.fromEntries(visibleFacts.map((fact) => [factCode.get(fact.factId), fact.factId])),
      requiredHistoryIds,
      excludedHiddenHistoryCount: turn.requiredHistoricalFactIds.length - requiredHistoryIds.length,
      requiredCurrentIds,
      requiredRiskIds,
    };
    if (run.status !== "completed") {
      for (const task of semanticTaskIds) deterministic.taskChecks[task] = false;
    } else {
      for (const task of semanticTaskIds) deterministic.taskChecks[task] = null;
    }
    for (const task of applicableTasks) {
      if (task === "create-reviewable-structured-draft") deterministic.taskChecks[task] = run.status === "completed" && deterministic.draft.structurallyValid;
      if (task === "retrieve-and-cite-medical-evidence") deterministic.taskChecks[task] = run.status === "completed"
        && deterministic.evidence.retrievalObserved && deterministic.evidence.validCitationIds.length > 0;
    }
    keyRows.push({ scoreId: recordId, runId: run.runId, caseId: run.caseId, turnId: run.turnId, arm: run.arm, taskIds: applicableTasks, deterministic });
    if (run.status === "completed" && semanticTaskIds.length + requiredHistoryIds.length > 0) packets.push(packet);
  }
  const studyTaskCounts = {};
  for (const run of runs) studyTaskCounts[run.status] = (studyTaskCounts[run.status] ?? 0) + 1;
  const retryCounts = {};
  for (const attempt of attempts) retryCounts[attempt.status] = (retryCounts[attempt.status] ?? 0) + 1;
  const meta = {
    schemaVersion: "huiyi-b1-eval-input/v1",
    scope: "synthetic engineering evaluation; no clinical approval or clinical validation implied",
    studyRunId: manifest.studyRunId,
    modelId: manifest.modelId,
    modelBackend: manifest.modelBackend,
    sourceRevision: manifest.sourceFingerprint?.gitRevision,
    cohortSha256: cohortHash,
    runDir: toRelative(runDir),
    finalRunRecordCount: runs.length,
    finalRunStatusCounts: studyTaskCounts,
    retryAttemptCount: attempts.length,
    retryAttemptStatusCounts: retryCounts,
    completePairedCases: firstFive,
    completePairedCaseCount: firstFive.length,
    completePairedTurnCount: firstFive.length * 8,
    allRunCaseCount: new Set(runs.map((run) => run.caseId)).size,
    allPlannedTurnPairCount: Math.min(...ARM_NAMES.map((arm) => runs.filter((run) => run.arm === arm).length)),
    hiddenArmMap,
    reportOutput: toRelative(resolve(outDir, "BULLET1-EVIDENCE.json")),
  };
  await writeJsonl(resolve(outDir, "blind-score-packets.jsonl"), packets);
  await writeJson(resolve(outDir, "score-key.private.json"), { schemaVersion: "huiyi-b1-score-key/v1", rows: keyRows });
  await writeJson(resolve(outDir, "input-manifest.private.json"), meta);
  console.log(JSON.stringify({ output: toRelative(outDir), packetCount: packets.length, finalRunRecords: runs.length, statusCounts: studyTaskCounts, retryAttempts: attempts.length, completePairedCases: firstFive, cohortSha256: cohortHash }));
}

function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const low = Math.floor(index), high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}
function ratio(n, d) { return { numerator: n, denominator: d, rate: d ? n / d : null, percent: d ? Math.round((10000 * n) / d) / 100 : null }; }
function add(map, key, value) { map.set(key, (map.get(key) ?? 0) + value); }

async function merge(flags) {
  const runDir = abs(flags["run-dir"] ?? DEFAULT_RUN);
  const cohortPath = abs(flags.cohort ?? DEFAULT_COHORT);
  const outDir = abs(flags.output ?? DEFAULT_OUTPUT);
  const inputDir = abs(flags["input-dir"] ?? DEFAULT_OUTPUT);
  const scorePath = abs(flags.scores ?? resolve(inputDir, "blind-semantic-scores.jsonl"));
  const manifest = JSON.parse(await readFile(resolve(runDir, "manifest.json"), "utf8"));
  const cohortBytes = await readFile(cohortPath);
  const cohortHash = sha256(cohortBytes);
  if (manifest.cohortSha256 !== cohortHash) throw new TypeError("run manifest cohort hash does not match the selected frozen cohort");
  const cohort = jsonl(cohortBytes.toString("utf8"), toRelative(cohortPath));
  const cases = mapBy(cohort, (item) => item.caseId, "cohort case ID");
  const runs = await readJsonl(resolve(runDir, "runs.jsonl"));
  const drafts = await readJsonl(resolve(runDir, "draft-bundles.jsonl")).catch(() => []);
  const key = JSON.parse(await readFile(resolve(inputDir, "score-key.private.json"), "utf8"));
  const semantic = await readJsonl(scorePath);
  const semanticById = mapBy(semantic, (row) => row.scoreId, "semantic score ID");
  const draftByRun = new Map(drafts.map((row) => [row.runId, row]));
  const runById = new Map(runs.map((run) => [run.runId, run]));
  const taskRows = [];
  const historyRows = [];
  const evidenceByArm = Object.fromEntries(ARM_NAMES.map((arm) => [arm, { numerator: 0, denominator: 0, citations: [], retrievedIds: 0, retrievalTurns: 0, turns: [] }]));
  const draftByArm = Object.fromEntries(ARM_NAMES.map((arm) => [arm, { numerator: 0, denominator: 0, turns: [] }]));
  for (const item of key.rows) {
    const run = runById.get(item.runId);
    if (!run) throw new TypeError(`score key refers to missing run: ${item.runId}`);
    const assigned = semanticById.get(item.scoreId);
    const semanticChecks = assigned?.taskChecks ?? {};
    const semanticHistory = assigned?.historyFacts ?? {};
    const checks = {};
    for (const task of item.taskIds) {
      if (run.status !== "completed") {
        checks[task] = false;
        continue;
      }
      const deterministicValue = item.deterministic.taskChecks[task];
      const value = deterministicValue === null ? semanticChecks[task] : deterministicValue;
      if (typeof value !== "boolean") throw new TypeError(`missing boolean task score ${task} for ${item.scoreId}`);
      checks[task] = value;
    }
    const excluded = new Set();
    for (const task of item.taskIds) {
      if (task === "recover-prior-encounter-facts" && item.deterministic.requiredHistoryIds.length === 0) excluded.add(task);
    }
    const countedTasks = Object.entries(checks).filter(([task]) => !excluded.has(task));
    taskRows.push({ caseId: item.caseId, turnId: item.turnId, arm: item.arm, runId: item.runId, executionStatus: run.status,
      taskChecks: checks, excludedTasks: [...excluded], applicableTaskCount: countedTasks.length, allApplicableTasksCompleted: run.status === "completed" && countedTasks.length > 0 && countedTasks.every(([, value]) => value),
      semanticEvidence: Object.fromEntries(Object.entries(assigned?.evidence ?? {}).map(([key, value]) => [key, String(value).slice(0, 240)])),
      hiddenHistoryExcluded: item.deterministic.excludedHiddenHistoryCount });
    for (const historyId of item.deterministic.requiredHistoryIds) {
      const code = Object.entries(item.deterministic.factCodes).find(([, id]) => id === historyId)?.[0];
      let status = run.status === "completed" ? semanticHistory[code] : "omitted";
      if (!new Set(["correct", "omitted", "incorrect"]).has(status)) throw new TypeError(`invalid history status for ${item.scoreId}:${code}`);
      historyRows.push({ caseId: item.caseId, turnId: item.turnId, arm: item.arm, factId: historyId, status, runId: item.runId });
    }
    const ec = item.deterministic.evidence;
    const evidence = evidenceByArm[item.arm];
    evidence.retrievedIds += ec.retrievedEvidence.length;
    if (ec.retrievalObserved) evidence.retrievalTurns++;
    for (const id of ec.citedEvidenceIds) {
      evidence.denominator++;
      const valid = ec.retrievedEvidence.some((source) => source.evidenceId === id);
      if (valid) evidence.numerator++;
      evidence.citations.push({ caseId: item.caseId, turnId: item.turnId, citedEvidenceId: id, valid, retrievedEvidenceIds: ec.retrievedEvidence.map((source) => source.evidenceId) });
    }
    const cohortCase = cases.get(item.caseId);
    const turn = cohortCase.turns.find((candidate) => candidate.turnId === item.turnId);
    evidence.turns.push({
      caseId: item.caseId, turnId: item.turnId,
      requiresEvidenceCitation: turn.expectedTaskIds.includes("retrieve-and-cite-medical-evidence"),
      executionCompleted: run.status === "completed",
      retrievalObserved: ec.retrievalObserved,
      citedCount: ec.citedEvidenceIds.length,
      validCitationCount: ec.validCitationIds.length,
      retrievedEvidenceIds: ec.retrievedEvidence.map((source) => source.evidenceId),
    });
    if (turn.expectedTaskIds.includes("create-reviewable-structured-draft")) {
      const draft = item.deterministic.draft;
      const metrics = draftByArm[item.arm];
      metrics.denominator++;
      if (run.status === "completed" && draft.structurallyValid) metrics.numerator++;
      metrics.turns.push({ caseId: item.caseId, turnId: item.turnId, runStatus: run.status, present: draft.present, valid: draft.structurallyValid && run.status === "completed" });
    }
  }
  const perArm = {};
  for (const arm of ARM_NAMES) {
    const armRuns = runs.filter((run) => run.arm === arm);
    const armTasks = taskRows.filter((row) => row.arm === arm);
    const completed = armRuns.filter((run) => run.status === "completed").length;
    const runHist = historyRows.filter((row) => row.arm === arm);
    const dshIn = armRuns.reduce((sum, run) => sum + (run.tokenUsage?.inputTokens ?? 0), 0);
    const dshOut = armRuns.reduce((sum, run) => sum + (run.tokenUsage?.outputTokens ?? 0), 0);
    const dshMeasured = armRuns.filter((run) => Number.isFinite(run.tokenUsage?.inputTokens) && Number.isFinite(run.tokenUsage?.outputTokens)).length;
    const amaIn = armRuns.reduce((sum, run) => sum + (run.memoryUsage?.promptTokens ?? 0), 0);
    const amaOut = armRuns.reduce((sum, run) => sum + (run.memoryUsage?.completionTokens ?? 0), 0);
    const ragIn = armRuns.reduce((sum, run) => sum + (run.ragRetrievals ?? []).reduce((t, row) => t + (row.plannerInputTokens ?? 0), 0), 0);
    const ragOut = armRuns.reduce((sum, run) => sum + (run.ragRetrievals ?? []).reduce((t, row) => t + (row.plannerOutputTokens ?? 0), 0), 0);
    const turnAll = armTasks.filter((row) => row.allApplicableTasksCompleted).length;
    const historyCorrect = runHist.filter((row) => row.status === "correct").length;
    const timing = armRuns.map((run) => run.wallTimeMs).filter(Number.isFinite);
    const evidence = evidenceByArm[arm];
    const requiredEvidenceTurns = evidence.turns.filter((turn) => turn.requiresEvidenceCitation);
    const citationCoveredTurns = requiredEvidenceTurns.filter((turn) => turn.executionCompleted && turn.validCitationCount > 0);
    perArm[arm] = {
      plannedTurnTasks: armRuns.length,
      executionSuccess: ratio(completed, armRuns.length),
      keyTaskCompletionPerTurn: ratio(turnAll, armTasks.length),
      keyTaskItemCompletion: ratio(armTasks.reduce((sum, row) => sum + Object.entries(row.taskChecks).filter(([task, value]) => value && !row.excludedTasks.includes(task)).length, 0), armTasks.reduce((sum, row) => sum + row.applicableTaskCount, 0)),
      validStructuredDrafts: ratio(draftByArm[arm].numerator, draftByArm[arm].denominator),
      correctHistoricalFactReference: ratio(historyCorrect, runHist.length),
      evidenceSourceIdResolution: ratio(evidence.numerator, evidence.denominator),
      evidenceSourceIdResolutionStatus: evidence.denominator > 0 ? "measurable-source-id-resolution-only" : "not-measurable-no-recognized-citation-token",
      evidenceSourceIdResolutionDenominator: "[evidence:<ID>] tokens in final completed answers; resolved iff the exact ID was returned by same-turn medical RAG.",
      evidenceSupportValidity: { status: "not-measurable-no-independent-claim-to-passage-review", numerator: null, denominator: null },
      evidenceTaskSourceIdCoverage: ratio(citationCoveredTurns.length, requiredEvidenceTurns.length),
      evidenceRetrieval: { turnsWithCompletedSearchTool: evidence.retrievalTurns, returnedEvidenceItems: evidence.retrievedIds, citations: evidence.citations, evidenceTaskTurns: requiredEvidenceTurns },
      latencyMs: { p50: percentile(timing, 0.5), p95: percentile(timing, 0.95), denominator: timing.length, includesFailures: true },
      tokenUsage: { dshInput: dshIn, dshOutput: dshOut, amaInput: amaIn, amaOutput: amaOut, ragPlannerInput: ragIn, ragPlannerOutput: ragOut,
        totalObserved: dshIn + dshOut + amaIn + amaOut + ragIn + ragOut, dshMeasuredRuns: dshMeasured, dshUnmeasuredRuns: armRuns.length - dshMeasured,
        note: "Observed token counts only; missing failed-run usage is not imputed, and no monetary cost is reported." },
    };
  }
  const paired = [];
  const pairKeys = [...new Set(taskRows.map((row) => `${row.caseId}|${row.turnId}`))].sort();
  for (const pairKey of pairKeys) {
    const [caseId, turnId] = pairKey.split("|");
    const single = taskRows.find((row) => row.caseId === caseId && row.turnId === turnId && row.arm === "single-agent");
    const integrated = taskRows.find((row) => row.caseId === caseId && row.turnId === turnId && row.arm === "integrated");
    if (!single || !integrated) continue;
    paired.push({ caseId, turnId, singleCompleted: single.allApplicableTasksCompleted, integratedCompleted: integrated.allApplicableTasksCompleted,
      delta: Number(integrated.allApplicableTasksCompleted) - Number(single.allApplicableTasksCompleted), singleStatus: single.executionStatus, integratedStatus: integrated.executionStatus });
  }
  const perTaskSummary = Object.fromEntries([...new Set(taskRows.flatMap((row) => Object.keys(row.taskChecks)))].sort().map((task) => {
    const applicable = taskRows.filter((row) => Object.hasOwn(row.taskChecks, task) && !row.excludedTasks.includes(task));
    const byArm = Object.fromEntries(ARM_NAMES.map((arm) => {
      const rows = applicable.filter((row) => row.arm === arm);
      return [arm, ratio(rows.filter((row) => row.taskChecks[task]).length, rows.length)];
    }));
    const pairedTaskRows = pairKeys.map((pairKey) => {
      const [caseId, turnId] = pairKey.split("|");
      const single = taskRows.find((row) => row.caseId === caseId && row.turnId === turnId && row.arm === ARM_NAMES[0]);
      const integrated = taskRows.find((row) => row.caseId === caseId && row.turnId === turnId && row.arm === ARM_NAMES[1]);
      if (!single || !integrated || single.excludedTasks.includes(task) || integrated.excludedTasks.includes(task)
        || !Object.hasOwn(single.taskChecks, task) || !Object.hasOwn(integrated.taskChecks, task)) return null;
      return { caseId, turnId, single: single.taskChecks[task], integrated: integrated.taskChecks[task],
        delta: Number(integrated.taskChecks[task]) - Number(single.taskChecks[task]) };
    }).filter(Boolean);
    return [task, { byArm, integratedMinusSinglePercentagePoints: byArm[ARM_NAMES[1]].percent === null || byArm[ARM_NAMES[0]].percent === null
      ? null : Math.round((byArm[ARM_NAMES[1]].percent - byArm[ARM_NAMES[0]].percent) * 100) / 100,
      paired: { pairCount: pairedTaskRows.length, integratedWins: pairedTaskRows.filter((row) => row.delta === 1).length,
        singleWins: pairedTaskRows.filter((row) => row.delta === -1).length, ties: pairedTaskRows.filter((row) => row.delta === 0).length, turns: pairedTaskRows } }];
  }));
  const historyPairMap = new Map();
  for (const row of historyRows) {
    const id = `${row.caseId}|${row.turnId}|${row.factId}`;
    const entry = historyPairMap.get(id) ?? { caseId: row.caseId, turnId: row.turnId, factId: row.factId };
    entry[row.arm] = row.status;
    historyPairMap.set(id, entry);
  }
  const pairedHistoryFacts = [...historyPairMap.values()].filter((row) => row[ARM_NAMES[0]] && row[ARM_NAMES[1]]);
  const draftPairMap = new Map();
  for (const arm of ARM_NAMES) for (const row of draftByArm[arm].turns) {
    const id = `${row.caseId}|${row.turnId}`;
    const entry = draftPairMap.get(id) ?? { caseId: row.caseId, turnId: row.turnId };
    entry[arm] = row.valid;
    draftPairMap.set(id, entry);
  }
  const pairedDrafts = [...draftPairMap.values()].filter((row) => typeof row[ARM_NAMES[0]] === "boolean" && typeof row[ARM_NAMES[1]] === "boolean");
  const runPairMap = new Map(runs.map((run) => [`${run.caseId}|${run.turnId}|${run.arm}`, run]));
  const pairedRuns = pairKeys.map((id) => {
    const [caseId, turnId] = id.split("|");
    return { caseId, turnId, single: runPairMap.get(`${caseId}|${turnId}|${ARM_NAMES[0]}`), integrated: runPairMap.get(`${caseId}|${turnId}|${ARM_NAMES[1]}`) };
  }).filter((row) => row.single && row.integrated);
  const pairedLatency = pairedRuns.filter((row) => Number.isFinite(row.single.wallTimeMs) && Number.isFinite(row.integrated.wallTimeMs))
    .map((row) => ({ caseId: row.caseId, turnId: row.turnId, deltaMs: row.integrated.wallTimeMs - row.single.wallTimeMs }));
  const pairedTokens = pairedRuns.filter((row) => Number.isFinite(row.single.tokenUsage?.inputTokens) && Number.isFinite(row.single.tokenUsage?.outputTokens)
    && Number.isFinite(row.integrated.tokenUsage?.inputTokens) && Number.isFinite(row.integrated.tokenUsage?.outputTokens))
    .map((row) => ({ caseId: row.caseId, turnId: row.turnId,
      single: row.single.tokenUsage.inputTokens + row.single.tokenUsage.outputTokens + (row.single.memoryUsage?.promptTokens ?? 0) + (row.single.memoryUsage?.completionTokens ?? 0)
        + (row.single.ragRetrievals ?? []).reduce((sum, item) => sum + (item.plannerInputTokens ?? 0) + (item.plannerOutputTokens ?? 0), 0),
      integrated: row.integrated.tokenUsage.inputTokens + row.integrated.tokenUsage.outputTokens + (row.integrated.memoryUsage?.promptTokens ?? 0) + (row.integrated.memoryUsage?.completionTokens ?? 0)
        + (row.integrated.ragRetrievals ?? []).reduce((sum, item) => sum + (item.plannerInputTokens ?? 0) + (item.plannerOutputTokens ?? 0), 0) }));
  const citationTurnsByKey = Object.fromEntries(ARM_NAMES.map((arm) => [arm, new Map(evidenceByArm[arm].turns.map((row) => [`${row.caseId}|${row.turnId}`, row]))]));
  const evidenceTaskPairKeys = [...new Set(ARM_NAMES.flatMap((arm) => evidenceByArm[arm].turns.filter((row) => row.requiresEvidenceCitation).map((row) => `${row.caseId}|${row.turnId}`)))];
  const pairedCitationRows = evidenceTaskPairKeys.flatMap((key) => {
    const single = citationTurnsByKey[ARM_NAMES[0]].get(key);
    const integrated = citationTurnsByKey[ARM_NAMES[1]].get(key);
    if (!single || !integrated || single.citedCount === 0 || integrated.citedCount === 0) return [];
    return [{ key, singleCited: single.citedCount, singleValid: single.validCitationCount,
      integratedCited: integrated.citedCount, integratedValid: integrated.validCitationCount }];
  });
  const pairedCitationSingle = pairedCitationRows.reduce((sum, row) => ({ cited: sum.cited + row.singleCited, valid: sum.valid + row.singleValid }), { cited: 0, valid: 0 });
  const pairedCitationIntegrated = pairedCitationRows.reduce((sum, row) => ({ cited: sum.cited + row.integratedCited, valid: sum.valid + row.integratedValid }), { cited: 0, valid: 0 });
  const pairPassSummary = (rows, field) => {
    const passes = (row, arm) => field === "status" ? row[arm] === "correct" : row[arm] === true;
    return { pairCount: rows.length,
      single: ratio(rows.filter((row) => passes(row, ARM_NAMES[0])).length, rows.length),
      integrated: ratio(rows.filter((row) => passes(row, ARM_NAMES[1])).length, rows.length),
      integratedWins: rows.filter((row) => Number(passes(row, ARM_NAMES[1])) > Number(passes(row, ARM_NAMES[0]))).length,
      singleWins: rows.filter((row) => Number(passes(row, ARM_NAMES[0])) > Number(passes(row, ARM_NAMES[1]))).length,
      ties: rows.filter((row) => passes(row, ARM_NAMES[0]) === passes(row, ARM_NAMES[1])).length,
      differences: rows };
  };
  const pairedMetrics = {
    structuredDraftValidity: pairPassSummary(pairedDrafts, "valid"),
    historicalFactReference: pairPassSummary(pairedHistoryFacts, "status"),
    executionSuccess: { pairCount: pairedRuns.length,
      single: ratio(pairedRuns.filter((row) => row.single.status === "completed").length, pairedRuns.length),
      integrated: ratio(pairedRuns.filter((row) => row.integrated.status === "completed").length, pairedRuns.length),
      integratedWins: pairedRuns.filter((row) => row.integrated.status === "completed" && row.single.status !== "completed").length,
      singleWins: pairedRuns.filter((row) => row.single.status === "completed" && row.integrated.status !== "completed").length,
      ties: pairedRuns.filter((row) => (row.integrated.status === "completed") === (row.single.status === "completed")).length },
    latencyDeltaMs: { pairCount: pairedLatency.length, medianIntegratedMinusSingle: percentile(pairedLatency.map((row) => row.deltaMs), 0.5),
      p95IntegratedMinusSingle: percentile(pairedLatency.map((row) => row.deltaMs), 0.95), differences: pairedLatency },
    observedTokenDelta: { pairedMeasuredCount: pairedTokens.length,
      totalSingle: pairedTokens.reduce((sum, row) => sum + row.single, 0), totalIntegrated: pairedTokens.reduce((sum, row) => sum + row.integrated, 0),
      integratedMinusSingle: pairedTokens.reduce((sum, row) => sum + row.integrated - row.single, 0), differences: pairedTokens },
    evidenceSourceIdResolution: {
      pairedEvidenceTaskCount: evidenceTaskPairKeys.length,
      pairedTurnsWithCitationsInBothArms: pairedCitationRows.length,
      unpairableTurnsWithoutCitationInAtLeastOneArm: evidenceTaskPairKeys.length - pairedCitationRows.length,
      single: ratio(pairedCitationSingle.valid, pairedCitationSingle.cited),
      integrated: ratio(pairedCitationIntegrated.valid, pairedCitationIntegrated.cited),
      integratedMinusSinglePercentagePoints: pairedCitationSingle.cited && pairedCitationIntegrated.cited
        ? Math.round((10000 * (pairedCitationIntegrated.valid / pairedCitationIntegrated.cited - pairedCitationSingle.valid / pairedCitationSingle.cited))) / 100
        : null,
      turns: pairedCitationRows,
      interpretation: "Pairable source-ID resolution only; this is not medical support validity. Turns with no emitted ID remain visible in per-arm source-ID coverage and are not silently counted as resolved.",
    },
  };
  const completeCases = [...new Set(paired.filter((pair) => pair.singleStatus === "completed" && pair.integratedStatus === "completed").map((pair) => pair.caseId))];
  const completePairedCases = [...new Set(taskRows.filter((row) => row.executionStatus === "completed").map((row) => row.caseId))].filter((caseId) => {
    const rows = taskRows.filter((row) => row.caseId === caseId);
    return rows.length === 16 && rows.every((row) => row.executionStatus === "completed");
  });
  const failures = runs.filter((run) => run.status !== "completed").map((run) => ({ caseId: run.caseId, turnId: run.turnId, arm: run.arm, status: run.status, failureCode: run.failureCode ?? null, wallTimeMs: run.wallTimeMs }));
  const report = {
    schemaVersion: "huiyi-b1-engineering-score/v1",
    generatedAt: new Date().toISOString(),
    scope: "Synthetic engineering evaluation only; not clinician review, not clinical validation, and not production safety evidence.",
    studyRunId: manifest.studyRunId,
    model: manifest.modelId,
    modelBackend: manifest.modelBackend,
    sourceRevision: manifest.sourceFingerprint?.gitRevision,
    cohortSha256: cohortHash,
    denominatorPolicy: "All final planned tasks in the selected run stay in the completion denominator. Failed/cancelled tasks are incomplete; partial assistant text is ignored. Retry attempts are reported separately and never create extra planned tasks. A hidden historical fact is excluded unless a prior/current actual patient disclosure is recorded.",
    actualSample: { completePairedCases: completePairedCases.slice(0, 5), completePairedCaseCount: completePairedCases.length,
      completePairedTurnPairs: completePairedCases.slice(0, 5).length * 8, allPlannedTurnPairs: paired.length,
      finalTaskRecords: runs.length, retryAttempts: (await readJsonl(resolve(runDir, "attempt-history.jsonl")).catch(() => [])).length,
      failuresRetained: failures },
    byArm: perArm,
    perTaskSummary,
    pairedMetrics,
    pairedKeyTaskCompletion: { pairCount: paired.length, integratedMinusSingleCompletedTurnCount: paired.reduce((sum, row) => sum + row.delta, 0), turns: paired },
    perTask: taskRows,
    perHistoricalFact: historyRows,
    semanticScoring: { source: "isolated blinded scoring sub-agent", labelsUnblindedAfterScoring: true, clinicianReview: false },
    amaProvenanceLimitation: "These frozen run rows contain aggregate AMA call/token counters but no per-fact recalledFacts/sourceId records. Historical correctness is scored only against synthetic facts explicitly disclosed in the actual same-arm patient exchanges; it does not prove an AMA source hit.",
    evidenceSourceIdResolution: { status: "measurable-from-stable-source-ids", method: "Exact [evidence:<ID>] match against the same-task RAG-returned IDs.", limitation: "This proves source linkage only; it does not prove that the passage supports the adjacent medical claim." },
    medicalEvidenceSupportValidity: { status: "not-measurable", numerator: null, denominator: null, reason: "No independent claim-to-passage adjudication is available; full passage text is not included in the blinded engineering score packet." },
    p95Method: "linear interpolation over all final task latencies, including failed runs/timeouts",
    tokenCostMethod: "reported observed token counts, no currency conversion; failed runs without usage remain unmeasured",
  };
  await mkdir(outDir, { recursive: true });
  await writeJson(resolve(outDir, "BULLET1-EVIDENCE.json"), report);
  const armLines = ARM_NAMES.map((arm) => {
    const metric = perArm[arm];
    return `| ${arm} | ${metric.keyTaskCompletionPerTurn.numerator}/${metric.keyTaskCompletionPerTurn.denominator} (${metric.keyTaskCompletionPerTurn.percent ?? "n/a"}%) | ${metric.validStructuredDrafts.numerator}/${metric.validStructuredDrafts.denominator} (${metric.validStructuredDrafts.percent ?? "n/a"}%) | ${metric.correctHistoricalFactReference.numerator}/${metric.correctHistoricalFactReference.denominator} (${metric.correctHistoricalFactReference.percent ?? "n/a"}%) | ${metric.evidenceSourceIdResolution.numerator}/${metric.evidenceSourceIdResolution.denominator} (${metric.evidenceSourceIdResolution.percent ?? "n/a"}%; ${metric.evidenceSourceIdResolutionStatus}) | ${metric.evidenceTaskSourceIdCoverage.numerator}/${metric.evidenceTaskSourceIdCoverage.denominator} (${metric.evidenceTaskSourceIdCoverage.percent ?? "n/a"}%) | ${metric.executionSuccess.numerator}/${metric.executionSuccess.denominator} (${metric.executionSuccess.percent ?? "n/a"}%) | ${metric.latencyMs.p95} ms | ${metric.tokenUsage.totalObserved} |`;
  });
  const summary = [
    "# Synthetic clinical engineering evaluation",
    "",
    `Study run: \`${manifest.studyRunId}\`  `,
    `Source revision: \`${manifest.sourceFingerprint?.gitRevision ?? "unknown"}\`  `,
    `Cohort SHA-256: \`${cohortHash}\`  `,
    `Paired turns: ${paired.length}; paired cases: ${report.actualSample.completePairedCaseCount}; retained failures: ${failures.length}.`,
    "",
    "| Arm | Key task completion | Valid structured drafts | Correct disclosed history | Source-ID resolution | Evidence-task ID coverage | Execution success | P95 | Observed tokens |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...armLines,
    "",
    "Source-ID resolution means an emitted `[evidence:<ID>]` exactly matches an ID returned by RAG for that same task. It does not measure whether the passage supports a medical claim. Medical evidence support validity is not measurable without independent claim-to-passage adjudication; its numerator and denominator are null. Evidence-task ID coverage counts planned evidence tasks with at least one resolvable source ID; missing IDs remain in its denominator.",
    "",
    "These are synthetic engineering measures, not clinician adjudication, clinical validation, or production safety evidence.",
    "",
  ].join("\n");
  await writeFile(resolve(outDir, "engineering-results.md"), summary, "utf8");
  console.log(JSON.stringify({ output: toRelative(resolve(outDir, "BULLET1-EVIDENCE.json")), completePairedCases: report.actualSample.completePairedCaseCount, pairedTurnTasks: paired.length,
    byArm: Object.fromEntries(Object.entries(perArm).map(([arm, value]) => [arm, { keyTaskCompletionPerTurn: value.keyTaskCompletionPerTurn, validStructuredDrafts: value.validStructuredDrafts, correctHistoricalFactReference: value.correctHistoricalFactReference, evidenceSourceIdResolution: value.evidenceSourceIdResolution, medicalEvidenceSupportValidity: value.evidenceSupportValidity, executionSuccess: value.executionSuccess }])) }));
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === "prepare") return prepare(flags);
  if (command === "merge") return merge(flags);
  throw new TypeError("usage: node scripts/clinical-eval/score-bullet1.mjs prepare|merge [--run-dir=...] [--cohort=...] [--output=...] [--scores=...]");
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
