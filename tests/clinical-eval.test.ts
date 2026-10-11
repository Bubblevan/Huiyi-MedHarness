import { describe, expect, it } from "vitest";
import { createClinicalApprovalTemplate, applyClinicalApproval } from "../eval/clinical/approval.js";
import { readDemoEventStream } from "../eval/clinical/authenticated-gateway.js";
import { makeBlindReviewPacket, mergeBlindedReviews, type ClinicalReviewKeyEntry } from "../eval/clinical/blind-review.js";
import { generateCohort, toPatientContext, validateSyntheticCase } from "../eval/clinical/cohort.js";
import { summarizeSyntheticCohort } from "../eval/clinical/cohort-audit.js";
import { assertCodexLunaRoute, createClinicalRunPlan } from "../eval/clinical/run-plan.js";
import { createClinicalApprovalFromReview, createSyntheticCohortReviewPacket } from "../eval/clinical/review-packet.js";
import { detectPatientQuestionIntents, SyntheticPatientSimulator } from "../eval/clinical/patient-simulator.js";
import { createReviewDraftBundle } from "../eval/clinical/fhir-draft.js";
import { assessIsolationProbe } from "../eval/clinical/isolation.js";
import { captureEvaluationSourceFingerprint, captureHealthEngineSourceFingerprint } from "../eval/clinical/source-fingerprint.js";
import { summarizeCollaborationTrace } from "../eval/clinical/collaboration-trace-summary.js";
import { attestCodexBridgeHealth } from "../eval/clinical/bridge-attestation.js";
import { extractRagRetrievalTelemetry } from "../eval/clinical/runner.js";
import { uniqueRagRetrievalTelemetry } from "../eval/clinical/rag-telemetry.js";
import { createReviewTemplate, scoreClinicalRuns } from "../eval/clinical/scoring.js";
import type { ClinicalReviewRecord, ClinicalRunRecord, SyntheticClinicalCase } from "../eval/clinical/contracts.js";
import { createEvent } from "../services/demo-gateway/src/contracts.js";

describe("clinical synthetic evaluation foundation", () => {
  it("deduplicates repeated RAG telemetry references without merging different summaries", () => {
    const retrieval = {
      mode: "single" as const, rounds: 1, generatedQueries: 0, uniqueDocuments: 3, candidateCount: 3,
      returnedEvidenceCount: 3, retrievalCalls: 1, plannerCalls: 0, retrievalLatencyMs: 420,
      plannerLatencyMs: 0, latencyMs: 421, estimatedContextTokens: 340, plannerModel: "gpt-6-luna",
      plannerPromptVersion: "", corpusVersion: "local-v1", degraded: false,
    };
    const distinct = { ...retrieval, retrievalLatencyMs: 700, latencyMs: 701 };
    expect(uniqueRagRetrievalTelemetry([retrieval, { ...retrieval }, distinct])).toEqual([retrieval, distinct]);
  });

  it("requires a current Codex bridge to attest its bounded concurrency cap", () => {
    const current = attestCodexBridgeHealth({
      status: "ok", model: "gpt-6-luna", route: "codex-app-server",
      maxConcurrentTurns: 2, activeTurns: 1, queuedTurns: 0, peakConcurrentTurns: 2,
    }, "gpt-6-luna");
    expect(current).toEqual({
      status: "matched", modelMatches: true, routeMatches: true, healthy: true,
      boundedConcurrency: true, maxConcurrentTurns: 2,
    });
    const oldBridge = attestCodexBridgeHealth({ status: "ok", model: "gpt-6-luna", route: "codex-app-server" }, "gpt-6-luna");
    expect(oldBridge.status).toBe("mismatch");
    expect(oldBridge.boundedConcurrency).toBe(false);
    expect(oldBridge.maxConcurrentTurns).toBeNull();
    const unsafeCap = attestCodexBridgeHealth({
      status: "ok", model: "gpt-6-luna", route: "codex-app-server",
      maxConcurrentTurns: 8, activeTurns: 0, queuedTurns: 0, peakConcurrentTurns: 0,
    }, "gpt-6-luna");
    expect(unsafeCap.status).toBe("mismatch");
    expect(unsafeCap.boundedConcurrency).toBe(false);
  });

  it("summarizes child failures without retaining case, role, prompt, or run identifiers", () => {
    const summary = summarizeCollaborationTrace([
      {
        event: "child", caseHash: "private-case-hash", profile: "product", complexity: "advanced",
        task: "specialist-analysis", roleLabel: "private-generated-role", childRunId: "private-child-id",
        startedAt: 100, endedAt: 250, durationMs: 150, status: "failed", round: 1,
        childRunCount: 2, degraded: true, failureClass: "InvalidStructuredOutput", validationCode: "SCHEMA_INVALID",
      },
      {
        event: "policy", caseHash: "private-case-hash", profile: "product", complexity: "advanced",
        task: "peer-refinement", roleLabel: "private-generated-role", startedAt: 250, endedAt: 250,
        durationMs: 0, status: "skipped", childRunCount: 2, degraded: true, failureClass: "BudgetExhausted",
      },
    ]);
    expect(summary).toEqual({
      childRunCount: 1,
      children: [{
        task: "specialist-analysis", complexity: "advanced", status: "failed", durationMs: 150,
        failureClass: "InvalidStructuredOutput", validationCode: "SCHEMA_INVALID", round: 1,
      }],
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("private-case-hash");
    expect(serialized).not.toContain("private-generated-role");
    expect(serialized).not.toContain("private-child-id");
  });

  it("summarizes synthetic cohort coverage without exposing patient records", () => {
    const cases = generateCohort({ count: 24, seed: 20261011, developmentCount: 8, validationCount: 8 });
    const summary = summarizeSyntheticCohort(cases);
    expect(summary.patients).toBe(24);
    expect(summary.turns).toBe(192);
    expect(summary.facts).toBe(cases.reduce((sum, item) => sum + item.facts.length, 0));
    expect(summary.splits.development.patients).toBe(8);
    expect(summary.splits.validation.patients).toBe(8);
    expect(summary.splits["held-out"].patients).toBe(8);
    expect(Object.values(summary.splits.development.scenarioFamilies).reduce((sum, count) => sum + count, 0)).toBe(8);
    const output = JSON.stringify(summary);
    expect(output).not.toContain(cases[0]!.patient.patientId);
    expect(output).not.toContain(cases[0]!.patient.displayName);
    expect(output).not.toContain(cases[0]!.patient.privateIsolationCanary);
  });

  it("plans adaptive evaluation exchanges without exposing patients or making model calls", () => {
    const cases = generateCohort({ count: 4, seed: 20261011, developmentCount: 4, validationCount: 0 });
    const cohortSha256 = "a".repeat(64);
    const plan = createClinicalRunPlan({
      cases,
      cohortCaseIds: cases.map((item) => item.caseId),
      cohortSha256,
      split: "development",
      arms: ["single-agent", "integrated"],
      patientSimulationMode: "adaptive",
      patientFollowUpLimit: 1,
      maxTokens: 1536,
      modelBackend: "codex-app-server",
      providerName: "codex",
      modelId: "gpt-6-luna",
      approval: createClinicalApprovalTemplate(cases, cohortSha256),
    });
    expect(plan.status).toBe("plan-only-no-generation");
    expect(plan.selection).toMatchObject({ caseCount: 4, patientTaskTurns: 32, caseArmTasks: 8 });
    expect(plan.simulation).toMatchObject({ patientReplyUpperBoundAcrossArms: 64, rootAssistantExchangeUpperBound: 128 });
    expect(plan.clinicalReview).toMatchObject({ status: "pending", selectedCasesApproved: 0, selectedCaseCount: 4 });
    const output = JSON.stringify(plan);
    expect(output).not.toContain(cases[0]!.patient.patientId);
    expect(output).not.toContain(cases[0]!.patient.displayName);
    expect(output).not.toContain(cases[0]!.patient.privateIsolationCanary);
    expect(() => assertCodexLunaRoute("vllm", "Qwen/Qwen3-8B")).toThrow("refusing generation on any other backend/model");
    expect(() => assertCodexLunaRoute("codex-app-server", "gpt-6-luna")).not.toThrow();
  });

  it("creates a clinician review packet without internal IDs, isolation canaries, or FHIR bundles", () => {
    const cases = generateCohort({ count: 4, seed: 20261011, developmentCount: 4, validationCount: 0 });
    const { packet, crosswalk } = createSyntheticCohortReviewPacket({ cases, cohortSha256: "b".repeat(64) });
    expect(packet.schemaVersion).toBe("huiyi-synthetic-cohort-review/v1");
    expect(packet.requiredReviewerRole).toBe("licensed-clinician");
    expect(packet.cases).toHaveLength(4);
    expect(packet.cases[0]!.facts.length).toBe(cases[0]!.facts.filter((fact) => !fact.value.includes(cases[0]!.patient.privateIsolationCanary)).length);
    expect(packet.cases[0]!.turns.length).toBe(8);
    expect(packet.cases[0]!.review.decision).toBe("pending");
    const output = JSON.stringify(packet);
    expect(output).toContain("REV-001");
    expect(output).not.toContain(cases[0]!.patient.displayName);
    expect(output).not.toContain(cases[0]!.patient.patientId);
    expect(output).not.toContain(cases[0]!.patient.privateIsolationCanary);
    expect(output).not.toContain(cases[0]!.caseId);
    expect(output).not.toContain("fhirBundle");
    expect(crosswalk.items[0]).toEqual({ reviewCaseId: "REV-001", cohortCaseId: cases[0]!.caseId });
  });

  it("imports only completed clinician reviews bound to the exact cohort and unchanged packet", () => {
    const cases = generateCohort({ count: 4, seed: 20261011, developmentCount: 4, validationCount: 0 });
    const cohortSha256 = "d".repeat(64);
    const generated = createSyntheticCohortReviewPacket({ cases, cohortSha256 });
    const packet = JSON.parse(JSON.stringify(generated.packet)) as {
      reviewer: { reviewerId: string | null; reviewerRole: string | null; reviewedAt: string | null };
      cases: Array<{ review: Record<string, unknown> }>;
    };
    packet.reviewer = { reviewerId: "reviewer-1", reviewerRole: "licensed-clinician", reviewedAt: "2026-10-11T00:00:00.000Z" };
    for (const item of packet.cases) {
      Object.assign(item.review, {
        profileFactConsistency: "pass", medicationAllergySafety: "pass", riskSignalCoverage: "pass",
        disclosurePlanCoherence: "pass", decision: "approve-for-engineering",
      });
    }
    const result = createClinicalApprovalFromReview({
      cohort: cases, cohortSha256, packet, crosswalk: generated.crosswalk,
      reviewPacketSha256: "e".repeat(64), reviewCrosswalkSha256: "f".repeat(64),
    });
    expect(result.reviewedCaseCount).toBe(4);
    expect(result.approval.approvedCaseIds).toEqual(cases.map((item) => item.caseId));
    expect(result.approval.reviewPacketSha256).toBe("e".repeat(64));
    const altered = JSON.parse(JSON.stringify(packet));
    altered.cases[0].profile.age += 1;
    expect(() => createClinicalApprovalFromReview({
      cohort: cases, cohortSha256, packet: altered, crosswalk: generated.crosswalk,
      reviewPacketSha256: "e".repeat(64), reviewCrosswalkSha256: "f".repeat(64),
    })).toThrow("clinical content differs from the frozen source cohort");
  });

  it("persists only structured RAG retrieval telemetry from Gateway events", () => {
    const retrieval = {
      mode: "iterative" as const, rounds: 2, generatedQueries: 4, uniqueDocuments: 8, candidateCount: 12,
      returnedEvidenceCount: 3, retrievalCalls: 4, plannerCalls: 2, retrievalLatencyMs: 100,
      plannerLatencyMs: 200, latencyMs: 300, estimatedContextTokens: 500, plannerModel: "gpt-6-luna",
      plannerPromptVersion: "v1", corpusVersion: "corpus-v1", degraded: false,
      plannerInputTokens: 1000, plannerOutputTokens: 20,
    };
    const events = [
      createEvent("evidence.completed", "run-1", "session-1", { count: 3, retrieval }),
      createEvent("assistant.delta", "run-1", "session-1", { text: "private answer text" }),
    ];
    expect(extractRagRetrievalTelemetry(events)).toEqual([retrieval]);
    expect(JSON.stringify(extractRagRetrievalTelemetry(events))).not.toContain("private answer text");
  });

  it("captures a bounded source fingerprint for reproducible future runs", async () => {
    const fingerprint = await captureEvaluationSourceFingerprint(process.cwd());
    expect(fingerprint.gitRevision).toMatch(/^[a-f0-9]{40,64}$/i);
    expect(fingerprint.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint.sourceFileCount).toBeGreaterThan(0);
    expect(fingerprint.sourceBytes).toBeGreaterThan(0);
    expect(fingerprint.sourceBytes).toBeLessThan(25 * 1024 * 1024);
    expect(await captureEvaluationSourceFingerprint(process.cwd())).toEqual(fingerprint);
  });

  it("fingerprints the Health Engine and pinned AMA runtime sources", async () => {
    const fingerprint = await captureHealthEngineSourceFingerprint(process.cwd());
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await captureHealthEngineSourceFingerprint(process.cwd())).toBe(fingerprint);
  });

  it("preserves already received Gateway events when an SSE response times out", async () => {
    const runId = "run-synthetic-1";
    const retrieval = {
      mode: "iterative" as const, rounds: 2, generatedQueries: 4, uniqueDocuments: 8, candidateCount: 12,
      returnedEvidenceCount: 3, retrievalCalls: 4, plannerCalls: 2, retrievalLatencyMs: 100,
      plannerLatencyMs: 200, latencyMs: 300, estimatedContextTokens: 500, plannerModel: "gpt-6-luna",
      plannerPromptVersion: "v1", corpusVersion: "corpus-v1", degraded: false,
    };
    const frame = [
      createEvent("tool.started", runId, "session-synthetic-1", { tool: "consult_clinical_team" }),
      createEvent("evidence.completed", runId, "session-synthetic-1", { count: 3, retrieval }),
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    const encoder = new TextEncoder();
    const signal = new AbortController();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(encoder.encode(frame));
        else {
          signal.abort(new DOMException("synthetic test timeout", "TimeoutError"));
          controller.error(new DOMException("synthetic stream close", "AbortError"));
        }
      },
    });
    const result = await readDemoEventStream({ response: new Response(body), expectedRunId: runId, signal: signal.signal });
    expect(result.incomplete).toBe("timeout");
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({ event: "tool.started", data: { tool: "consult_clinical_team" } });
    expect(result.events[1]).toMatchObject({ event: "evidence.completed", data: { retrieval: { plannerCalls: 2 } } });
  });

  it("generates deterministic 300-patient longitudinal cohort and FHIR R4-shaped data", () => {
    const cohort = generateCohort({ count: 300 });
    expect(cohort).toHaveLength(300);
    expect(cohort.reduce((sum, item) => sum + item.turns.length, 0)).toBe(2400);
    expect(cohort.slice(0, 30).every((item) => item.split === "development")).toBe(true);
    expect(cohort.slice(30, 105).every((item) => item.split === "validation")).toBe(true);
    expect(cohort.slice(105).every((item) => item.split === "held-out")).toBe(true);
    expect(cohort.every((item) => item.clinicalReviewStatus === "pending" && item.synthetic)).toBe(true);
    expect(cohort.every((item) => item.generatorVersion === "synthetic-longitudinal-v2" && item.turns.every((turn) => turn.patientPlan))).toBe(true);
    expect(cohort.map((item) => item.caseId)).toEqual(generateCohort({ count: 300 }).map((item) => item.caseId));
    for (const item of [cohort[0]!, cohort[67]!, cohort[299]!]) validateSyntheticCase(item);

    const { generatorVersion: _version, turns, ...base } = cohort[0]!;
    validateSyntheticCase({ ...base, generatorVersion: "synthetic-longitudinal-v1", turns: turns.map(({ patientPlan: _plan, ...turn }) => turn) });
  });

  it("does not preload current or future encounter facts into the agent context", () => {
    const item = generateCohort({ count: 1 })[0]!;
    const context = toPatientContext({ syntheticPatientId: "synthetic-run-a1", encounterId: item.turns[0]!.encounterId, case: item });
    expect(context.conditions).toEqual([]);
    expect(context.medications).toEqual([]);
    expect(context.allergies).toEqual([]);
    expect(context.memory).toMatchObject({ summary: "", items: 0 });
    expect(context.patientId).not.toBe(item.patient.patientId);
  });

  it("makes evidence evaluation turns explicit local-knowledge retrieval requests", () => {
    const item = generateCohort({ count: 1 })[0]!;
    const evidenceTurn = item.turns.find((turn) => turn.turnId.endsWith("T07"))!;
    expect(evidenceTurn.evidenceTopics.length).toBeGreaterThan(0);
    expect(evidenceTurn.patientMessage).toContain("检索本地医学知识库");
    expect(evidenceTurn.patientMessage).toContain("不要补造引用");
    expect(evidenceTurn.patientPlan?.openingMessage).toContain("医学来源");
  });

  it("replays adaptive patient disclosures only after a matching assistant question", () => {
    const item = generateCohort({ count: 1 })[0]!;
    const turn = item.turns.find((candidate) => candidate.turnId.endsWith("T02"))!;
    const simulator = new SyntheticPatientSimulator(item);
    const opening = simulator.startTurn(turn);
    expect(opening.kind).toBe("opening");
    expect(opening.disclosedFactIds).toEqual([]);
    expect(opening.message).not.toContain("患者描述的当前用药与旧记录存在差异");

    const unprompted = simulator.respondToAssistant("我会先总结目前能确认的信息，并标出仍需核实的部分。");
    expect(unprompted).toBeUndefined();
    const medicationReply = simulator.respondToAssistant("请核对目前的用药和过敏情况。");
    expect(medicationReply?.disclosedFactIds).toContain(`${item.caseId}-C04`);
    expect(medicationReply?.message).toContain("用药或过敏状态");
    const timelineReply = simulator.respondToAssistant("这些变化大约从什么时候开始，先后过程如何？");
    expect(timelineReply?.disclosedFactIds).toContain(`${item.caseId}-C02`);
    expect(timelineReply?.matchedIntents).toContain("timeline");
    expect(simulator.respondToAssistant("请再说明目前用药情况。")).toBeUndefined();
  });

  it("honors a run-level follow-up cap below the cohort's frozen maximum", () => {
    const item = generateCohort({ count: 1 })[0]!;
    const turn = item.turns.find((candidate) => candidate.turnId.endsWith("T02"))!;
    const simulator = new SyntheticPatientSimulator(item, { maxFollowUpMessages: 1 });
    simulator.startTurn(turn);
    expect(simulator.respondToAssistant("请核对用药和过敏情况。")?.disclosedFactIds).toContain(`${item.caseId}-C04`);
    expect(simulator.respondToAssistant("这些变化从什么时候开始？")).toBeUndefined();

    const noFollowUps = new SyntheticPatientSimulator(item, { maxFollowUpMessages: 0 });
    noFollowUps.startTurn(turn);
    expect(noFollowUps.respondToAssistant("请核对用药和过敏情况。" )).toBeUndefined();
  });

  it("keeps adaptive plans within each turn's target facts and never releases the isolation canary", () => {
    const cohort = generateCohort({ count: 24 });
    for (const item of cohort) {
      for (const turn of item.turns) {
        const plan = turn.patientPlan!;
        const allowed = new Set([...turn.requiredHistoricalFactIds, ...turn.requiredCurrentFactIds, ...turn.expectedRiskSignalIds]);
        const plannedIds = [...plan.initialFactIds, ...plan.disclosures.flatMap((rule) => rule.factIds)];
        expect(plannedIds.every((id) => allowed.has(id))).toBe(true);
        expect(plannedIds.map((id) => item.facts.find((fact) => fact.factId === id)?.value)).not.toContain(item.patient.privateIsolationCanary);
      }
    }
    expect(detectPatientQuestionIntents("What medications are you taking, and when did the symptoms start?"))
      .toEqual(expect.arrayContaining(["medication", "timeline"]));
  });

  it("emits a preliminary synthetic-only FHIR Composition without writing back", () => {
    const item = generateCohort({ count: 1 })[0]!;
    const turn = item.turns.find((candidate) => candidate.turnId.endsWith("T04"))!;
    const run = sampleRun(item, turn, "single-agent");
    const bundle = createReviewDraftBundle({ case: item, turn, run: { ...run, assistantText: "<section>synthetic & reviewed later</section>" } });
    const composition = bundle.entry.find((entry) => entry.resource.resourceType === "Composition")?.resource;
    expect(composition).toMatchObject({
      resourceType: "Composition", status: "preliminary",
      extension: [{ url: "https://huiyi.invalid/fhir/StructureDefinition/review-workflow-state", valueCode: "preliminary" }],
    });
    expect(JSON.stringify(composition)).toContain("&lt;section&gt;synthetic &amp; reviewed later&lt;/section&gt;");
    const sections = composition!.section as Array<{ title: string; text: { div: string }; extension: unknown[] }>;
    expect(sections.map((section) => section.title)).toEqual(expect.arrayContaining([
      "主诉与病情变化", "既往重要病史", "当前用药", "过敏信息", "本次症状与检查摘要",
      "待医生核实的信息", "记录中的风险相关信息（待核实）", "医学证据与出处", "不确定性与缺失信息",
    ]));
    expect(sections.find((section) => section.title === "记录中的风险相关信息（待核实）")?.text.div).toContain("不表示 Agent 已识别风险");
    expect(sections.find((section) => section.title === "既往重要病史")?.text.div).toContain("fact:");
    expect(sections.every((section) => section.extension.length === 1)).toBe(true);
    expect(bundle.meta.tag.some((tag) => tag.code === "synthetic")).toBe(true);
  });

  it("keeps clinical scores suppressed until cohort approval and human adjudication", () => {
    const item = generateCohort({ count: 1 })[0]!;
    const turn = item.turns[0]!;
    const run = sampleRun(item, turn, "single-agent");
    const review = createReviewTemplate({ run, case: item, turn, blindedArm: "A" });
    const report = scoreClinicalRuns([run], [review]);
    expect(report.byArm["single-agent"].humanReview.status).toBe("pending");
    expect(report.byArm["single-agent"].humanReview.metrics).toBeNull();
    expect(report.pairedTaskCompletionDelta.status).toBe("blocked-unreviewed-cohort");
  });

  it("binds clinician approval to an exact cohort hash and requires a named clinician sign-off", () => {
    const item = generateCohort({ count: 1 })[0]!;
    const digest = "a".repeat(64);
    const template = createClinicalApprovalTemplate([item], digest);
    expect(applyClinicalApproval({ runs: [sampleRun(item, item.turns[0]!, "single-agent")], approval: template, cohortSha256: digest })[0]!.clinicalReviewStatus).toBe("pending");
    const approved = { ...template, status: "approved" as const, reviewerId: "reviewer-01", reviewerRole: "licensed-clinician" as const, reviewedAt: "2026-10-10T00:00:00.000Z", approvedCaseIds: [item.caseId] };
    expect(applyClinicalApproval({ runs: [sampleRun(item, item.turns[0]!, "single-agent")], approval: approved, cohortSha256: digest })[0]!.clinicalReviewStatus).toBe("approved");
    expect(() => applyClinicalApproval({ runs: [], approval: approved, cohortSha256: "b".repeat(64) })).toThrow(/does not match/);
    expect(() => applyClinicalApproval({ runs: [], approval: { ...approved, reviewerId: null }, cohortSha256: digest })).toThrow(/clinician identity/);
  });

  it("keeps reviewer packets blinded and joins adjudications through a private key", () => {
    const item = generateCohort({ count: 1 })[0]!;
    const turn = item.turns[0]!;
    const run = sampleRun(item, turn, "integrated");
    const review = createReviewTemplate({ run, case: item, turn, blindedArm: "B" });
    const packet = makeBlindReviewPacket({ packetId: "RPK-123", blindedArm: "B", case: item, turn, review, conversationSoFar: [], assistantText: run.assistantText, evidenceMetadata: [{ evidenceId: "ev-1", source: "synthetic-fixture", title: "合成参考材料", rank: 1, snippet: "仅供盲审核验的受限摘录" }] });
    expect(JSON.stringify(packet)).not.toContain(run.runId);
    expect(JSON.stringify(packet)).not.toContain("integrated");
    expect(packet.adjudication).not.toHaveProperty("runId");
    expect(packet.expectedCriteria).not.toHaveProperty("patientPlan");
    expect(packet.evidenceMetadata[0]!.snippet).toBe("仅供盲审核验的受限摘录");
    const key: ClinicalReviewKeyEntry[] = [{ packetId: packet.packetId, runId: run.runId, caseId: item.caseId, turnId: turn.turnId, actualArm: run.arm, blindedArm: "B" }];
    const merged = mergeBlindedReviews({ packets: [packet], key });
    expect(merged[0]).toMatchObject({ runId: run.runId, blindedArm: "B", status: "pending" });
    expect(() => mergeBlindedReviews({ packets: [packet], key: [] })).toThrow(/does not match/);
    expect(() => mergeBlindedReviews({ packets: [packet], key: [{ ...key[0]!, blindedArm: "A" }] })).toThrow(/changed/);
    const forged = { ...packet, adjudication: { ...packet.adjudication, runId: "forged" } } as typeof packet;
    expect(() => mergeBlindedReviews({ packets: [forged], key })).toThrow(/protected/);
  });

  it("scores blinded paired runs with patient-clustered uncertainty after adjudication", () => {
    const item = { ...generateCohort({ count: 1 })[0]!, clinicalReviewStatus: "approved" as const };
    const turn = item.turns[0]!;
    const single = sampleRun(item, turn, "single-agent");
    const integrated: ClinicalRunRecord = { ...sampleRun(item, turn, "integrated"), ragRetrievals: [{
      mode: "iterative", rounds: 2, generatedQueries: 4, uniqueDocuments: 8, candidateCount: 12,
      returnedEvidenceCount: 3, retrievalCalls: 4, plannerCalls: 2, retrievalLatencyMs: 100,
      plannerLatencyMs: 200, latencyMs: 300, estimatedContextTokens: 500, plannerModel: "gpt-6-luna",
      plannerPromptVersion: "v1", corpusVersion: "corpus-v1", degraded: false,
      plannerInputTokens: 1000, plannerOutputTokens: 20,
    }], toolCalls: [{ tool: "search_medical_evidence", status: "completed" }] };
    const runs = [single, integrated];
    const reviews = runs.map((run) => adjudicatedReview(item, turn, run));
    const report = scoreClinicalRuns(runs, reviews);
    expect(report.pairedTaskCompletionDelta).toMatchObject({ status: "scored-engineering-cohort", deltaPercentagePoints: 0, pairedPatients: 1 });
    expect(report.byArm.integrated.humanReview.metrics).not.toBeNull();
    expect(report.byArm.integrated.humanReview.metrics!.taskCompletion.requiredTaskItemRate.value).toBe(1);
    expect(report.byArm.integrated.humanReview.metrics!.taskCompletion.allRequiredTasksPerTurn.value).toBe(1);
    expect(report.byArm.integrated.humanReview.metrics!.taskCompletion.requiredTaskItemRate.clusterBootstrap95).toEqual([1, 1]);
    expect(report.byArm.integrated.execution.ragRetrieval).toMatchObject({
      status: "gateway-root-tool-telemetry-observed", observedCalls: 1, unattributedToolCalls: 0,
      modeCounts: { iterative: 1 }, plannerCalls: 2, plannerInputTokens: 1000, plannerOutputTokens: 20,
      latencyP95Ms: 300, corpusVersions: ["corpus-v1"],
    });
  });

  it("fails cross-patient leakage, keeps misses or cleanup failures indeterminate, and reports only probe scope", () => {
    expect(assessIsolationProbe({ ownRecallMatchedA: true, ownRecallMatchedB: true, crossPatientCanaryLeak: true, cleanupVerifiedA: true, cleanupVerifiedB: true })).toBe("fail");
    expect(assessIsolationProbe({ ownRecallMatchedA: false, ownRecallMatchedB: true, crossPatientCanaryLeak: false, cleanupVerifiedA: true, cleanupVerifiedB: true })).toBe("indeterminate");
    expect(assessIsolationProbe({ ownRecallMatchedA: true, ownRecallMatchedB: true, crossPatientCanaryLeak: false, cleanupVerifiedA: true, cleanupVerifiedB: false })).toBe("indeterminate");
    expect(assessIsolationProbe({ ownRecallMatchedA: true, ownRecallMatchedB: true, crossPatientCanaryLeak: false, cleanupVerifiedA: true, cleanupVerifiedB: true })).toBe("pass");
    const security = scoreClinicalRuns([], [], [{
      schemaVersion: "huiyi-clinical-eval/v1", recordType: "cross-patient-memory-isolation-probe", probeId: "probe-12345678",
      status: "pass", createdAt: "2026-10-10T00:00:00.000Z", wallTimeMs: 10,
      ownRecallMatched: { patientA: true, patientB: true }, crossPatientCanaryLeak: false,
      cleanup: { patientA: "verified", patientB: "verified" },
      scope: "local Health Engine synthetic AMA memory namespace only; not authorization or production isolation",
    }]).security;
    expect(security.crossPatientMemoryIsolation).toMatchObject({ status: "passed", probeCount: 1, crossPatientCanaryLeaks: 0, cleanupFailures: 0 });
    expect(security.patientAuthorization).toContain("not measured");
  });
});

function sampleRun(item: SyntheticClinicalCase, turn: SyntheticClinicalCase["turns"][number], arm: ClinicalRunRecord["arm"]): ClinicalRunRecord {
  return {
    schemaVersion: "huiyi-clinical-eval/v1", recordType: "turn-run", runId: `${arm}-${turn.turnId}`,
    caseId: item.caseId, turnId: turn.turnId, clinicalReviewStatus: item.clinicalReviewStatus, arm,
    model: "fixture-test-only", patientMessage: turn.patientMessage, assistantText: "合成测试回答",
    status: "completed", wallTimeMs: 100, startedAt: "2026-10-10T00:00:00.000Z",
    evidence: [], toolCalls: [], tokenUsage: { scope: "unavailable" },
  };
}

function adjudicatedReview(item: SyntheticClinicalCase, turn: SyntheticClinicalCase["turns"][number], run: ClinicalRunRecord): ClinicalReviewRecord {
  const review = createReviewTemplate({ run, case: item, turn, blindedArm: run.arm === "single-agent" ? "A" : "B" });
  review.status = "adjudicated";
  review.reviewerId = "synthetic-test-reviewer";
  review.taskChecks = Object.fromEntries(Object.keys(review.taskChecks).map((key) => [key, true]));
  review.historyFacts = Object.fromEntries(Object.keys(review.historyFacts).map((key) => [key, "correct"]));
  review.medicalClaims = { total: 0, evidenceSupported: 0, unsupported: 0, cited: 0, citationValid: 0 };
  review.riskChecks = Object.fromEntries(Object.keys(review.riskChecks).map((key) => [key, "recognized-and-escalated"]));
  review.complexityPoints = Object.fromEntries(Object.keys(review.complexityPoints).map((key) => [key, true]));
  return review;
}
