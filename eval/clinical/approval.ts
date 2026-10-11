import type { ClinicalRunRecord, SyntheticClinicalCase } from "./contracts.js";

export interface ClinicalCohortApproval {
  readonly schemaVersion: "huiyi-clinical-approval/v1";
  readonly cohortSha256: string;
  status: "pending" | "approved";
  reviewerId: string | null;
  reviewerRole: "licensed-clinician" | null;
  reviewedAt: string | null;
  approvedCaseIds: string[];
  rationale: string;
  readonly reviewPacketSha256?: string;
  readonly reviewCrosswalkSha256?: string;
}

export function createClinicalApprovalTemplate(cases: readonly SyntheticClinicalCase[], cohortSha256: string): ClinicalCohortApproval {
  if (!/^[a-f0-9]{64}$/.test(cohortSha256)) throw new TypeError("cohort hash must be a lowercase SHA-256 digest");
  return {
    schemaVersion: "huiyi-clinical-approval/v1", cohortSha256, status: "pending", reviewerId: null,
    reviewerRole: null, reviewedAt: null, approvedCaseIds: [],
    rationale: "Review the synthetic cases and disclosure rules before approval. Approval only unlocks engineering evaluation metrics; it does not establish clinical validity.",
  };
}

export function applyClinicalApproval(input: {
  readonly runs: readonly ClinicalRunRecord[];
  readonly approval: ClinicalCohortApproval | undefined;
  readonly cohortSha256: string;
}): ClinicalRunRecord[] {
  const approved = input.approval;
  if (!approved) return input.runs.map((run) => ({ ...run, clinicalReviewStatus: "pending" }));
  if (approved.schemaVersion !== "huiyi-clinical-approval/v1" || approved.cohortSha256 !== input.cohortSha256) {
    throw new TypeError("clinical approval does not match this exact cohort artifact");
  }
  if (approved.status === "approved" && (!approved.reviewerId?.trim() || approved.reviewerRole !== "licensed-clinician"
    || !approved.reviewedAt || Number.isNaN(Date.parse(approved.reviewedAt)) || !approved.approvedCaseIds.length)) {
    throw new TypeError("approved cohort requires clinician identity, role, timestamp, and approved case IDs");
  }
  const approvedIds = new Set(approved.approvedCaseIds);
  if (approvedIds.size !== approved.approvedCaseIds.length) throw new TypeError("approved case IDs must be unique");
  return input.runs.map((run) => ({ ...run, clinicalReviewStatus: approved.status === "approved" && approvedIds.has(run.caseId) ? "approved" : "pending" }));
}
