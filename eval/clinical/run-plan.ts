import type { ClinicalCohortApproval } from "./approval.js";
import type { EvalArm, PatientSimulationMode, SyntheticClinicalCase } from "./contracts.js";

export type ClinicalApprovalCoverage = "not-provided" | "pending" | "partial" | "approved" | "hash-mismatch" | "invalid";

export function assertCodexLunaRoute(modelBackend: string, modelId: string): void {
  if (modelBackend !== "codex-app-server" || modelId !== "gpt-6-luna") {
    throw new Error("Clinical evaluation is pinned to Codex app-server GPT-6-Luna; refusing generation on any other backend/model.");
  }
}

export interface ClinicalRunPlanInput {
  readonly cases: readonly SyntheticClinicalCase[];
  readonly cohortCaseIds: readonly string[];
  readonly cohortSha256: string;
  readonly split: string;
  readonly arms: readonly EvalArm[];
  readonly patientSimulationMode: PatientSimulationMode;
  readonly patientFollowUpLimit?: number;
  readonly maxTokens: number;
  readonly modelBackend: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly approval?: ClinicalCohortApproval;
}

/** Aggregate-only preflight. It never returns case IDs, patient data, prompts, or evidence text. */
export function createClinicalRunPlan(input: ClinicalRunPlanInput) {
  const selectedIds = new Set(input.cases.map((item) => item.caseId));
  const turns = input.cases.flatMap((item) => item.turns);
  const followUpsPerArm = input.patientSimulationMode === "adaptive"
    ? turns.reduce((sum, turn) => sum + (turn.patientPlan
      ? Math.min(turn.patientPlan.maxFollowUpMessages, input.patientFollowUpLimit ?? turn.patientPlan.maxFollowUpMessages)
      : 0), 0)
    : 0;
  const initialExchangesPerArm = turns.length;
  const rootAssistantExchangeUpperBound = (initialExchangesPerArm + followUpsPerArm) * input.arms.length;
  const approval = summarizeApproval(input.approval, input.cohortSha256, selectedIds, new Set(input.cohortCaseIds));

  return {
    schemaVersion: "huiyi-clinical-run-plan/v1",
    status: "plan-only-no-generation",
    cohortSha256: input.cohortSha256,
    selection: {
      split: input.split,
      caseCount: input.cases.length,
      patientTaskTurns: initialExchangesPerArm,
      caseArmTasks: input.cases.length * input.arms.length,
      arms: [...input.arms],
    },
    simulation: {
      patientSimulationMode: input.patientSimulationMode,
      configuredFollowUpLimit: input.patientFollowUpLimit ?? null,
      patientReplyUpperBoundAcrossArms: followUpsPerArm * input.arms.length,
      rootAssistantExchangeUpperBound,
    },
    generationRoute: {
      backend: input.modelBackend,
      provider: input.providerName,
      model: input.modelId,
      maxOutputTokensPerGeneration: input.maxTokens,
      matchesRequestedCodexLunaRoute: input.modelBackend === "codex-app-server" && input.modelId === "gpt-6-luna",
    },
    clinicalReview: approval,
    clinicalMetricGate: {
      selectedCasesApproved: approval.status === "approved",
      blindedAdjudicationRequired: true,
    },
    limitations: [
      "Exchange count is not a token or cost estimate; DSH tool loops, subagents, AMA, and the RAG planner can each add model generations.",
      "Clinical outcome metrics require reviewed cases and adjudicated blinded reviews.",
    ],
  } as const;
}

function summarizeApproval(
  approval: ClinicalCohortApproval | undefined,
  cohortSha256: string,
  selectedCaseIds: ReadonlySet<string>,
  cohortCaseIds: ReadonlySet<string>,
): { readonly status: ClinicalApprovalCoverage; readonly selectedCasesApproved: number; readonly selectedCaseCount: number } {
  const selectedCaseCount = selectedCaseIds.size;
  if (!approval) return { status: "not-provided", selectedCasesApproved: 0, selectedCaseCount };
  if (approval.schemaVersion !== "huiyi-clinical-approval/v1" || approval.cohortSha256 !== cohortSha256) {
    return { status: "hash-mismatch", selectedCasesApproved: 0, selectedCaseCount };
  }
  if (!Array.isArray(approval.approvedCaseIds) || new Set(approval.approvedCaseIds).size !== approval.approvedCaseIds.length
    || approval.approvedCaseIds.some((id) => !id || typeof id !== "string" || !cohortCaseIds.has(id))) {
    return { status: "invalid", selectedCasesApproved: 0, selectedCaseCount };
  }
  if (approval.status === "pending") return { status: "pending", selectedCasesApproved: 0, selectedCaseCount };
  if (approval.status !== "approved" || !approval.reviewerId?.trim() || approval.reviewerRole !== "licensed-clinician"
    || !approval.reviewedAt || Number.isNaN(Date.parse(approval.reviewedAt)) || approval.approvedCaseIds.length === 0) {
    return { status: "invalid", selectedCasesApproved: 0, selectedCaseCount };
  }
  const approvedIds = new Set(approval.approvedCaseIds);
  const selectedCasesApproved = [...selectedCaseIds].filter((id) => approvedIds.has(id)).length;
  return {
    status: selectedCasesApproved === 0 ? "pending" : selectedCasesApproved === selectedCaseCount ? "approved" : "partial",
    selectedCasesApproved,
    selectedCaseCount,
  };
}
