import type { SyntheticClinicalCase } from "./contracts.js";
import type { ClinicalCohortApproval } from "./approval.js";

export function createSyntheticCohortReviewPacket(input: {
  readonly cases: readonly SyntheticClinicalCase[];
  readonly cohortSha256: string;
  readonly requiredReviewerRole?: "licensed-clinician";
}) {
  if (!/^[a-f0-9]{64}$/.test(input.cohortSha256)) throw new TypeError("cohort hash must be a lowercase SHA-256 digest");
  const crosswalkItems: { reviewCaseId: string; cohortCaseId: string }[] = [];
  const cases = input.cases.map((item, caseIndex) => {
    const reviewCaseId = `REV-${String(caseIndex + 1).padStart(3, "0")}`;
    crosswalkItems.push({ reviewCaseId, cohortCaseId: item.caseId });
    const hiddenFactIds = new Set(item.facts.filter((fact) => fact.value.includes(item.patient.privateIsolationCanary)).map((fact) => fact.factId));
    const visibleFacts = item.facts.filter((fact) => !hiddenFactIds.has(fact.factId));
    const factAliases = new Map(visibleFacts.map((fact, index) => [fact.factId, `${reviewCaseId}-F${String(index + 1).padStart(3, "0")}`]));
    const encounterIds = [...new Set(visibleFacts.map((fact) => fact.encounterId))];
    const encounterAliases = new Map(encounterIds.map((encounterId, index) => [encounterId, `${reviewCaseId}-E${String(index + 1).padStart(2, "0")}`]));
    const turnAliases = new Map(item.turns.map((turn, index) => [turn.turnId, `${reviewCaseId}-T${String(index + 1).padStart(2, "0")}`]));
    const scrub = (text: string) => text
      .split(item.patient.privateIsolationCanary).join("[synthetic isolation marker excluded]")
      .split(item.patient.patientId).join("[synthetic internal patient key]")
      .split(item.caseId).join(reviewCaseId)
      .split(item.patient.displayName).join(`合成档案 ${reviewCaseId}`);
    const mapVisibleFactIds = (ids: readonly string[]) => ids.flatMap((id) => {
      const alias = factAliases.get(id);
      return alias ? [alias] : [];
    });
    return {
      reviewCaseId,
      split: item.split,
      scenarioFamily: item.scenarioFamily,
      complexity: item.complexity,
      synthetic: true as const,
      profile: {
        syntheticLabel: `合成档案 ${reviewCaseId}`,
        age: item.patient.age,
        gender: item.patient.gender,
      },
      facts: visibleFacts.map((fact) => ({
        factId: factAliases.get(fact.factId)!,
        encounterId: encounterAliases.get(fact.encounterId)!,
        category: fact.category,
        label: scrub(fact.label),
        value: scrub(fact.value),
      })),
      turns: item.turns.map((turn) => ({
        turnId: turnAliases.get(turn.turnId)!,
        encounterId: encounterAliases.get(turn.encounterId)!,
        patientMessage: scrub(turn.patientMessage),
        patientPlan: turn.patientPlan ? {
          openingMessage: scrub(turn.patientPlan.openingMessage),
          initialFactIds: mapVisibleFactIds(turn.patientPlan.initialFactIds),
          disclosures: turn.patientPlan.disclosures.map((disclosure) => ({
            factIds: mapVisibleFactIds(disclosure.factIds),
            triggers: [...disclosure.triggers],
          })),
          maxFollowUpMessages: turn.patientPlan.maxFollowUpMessages,
        } : null,
        expectedTaskIds: [...turn.expectedTaskIds],
        requiredHistoricalFactIds: mapVisibleFactIds(turn.requiredHistoricalFactIds),
        requiredCurrentFactIds: mapVisibleFactIds(turn.requiredCurrentFactIds),
        expectedRiskSignalIds: mapVisibleFactIds(turn.expectedRiskSignalIds),
        expectedComplexityPointIds: turn.expectedComplexityPointIds.map(scrub),
        evidenceTopics: turn.evidenceTopics.map(scrub),
      })),
      review: {
        profileFactConsistency: "pending" as const,
        medicationAllergySafety: "pending" as const,
        riskSignalCoverage: "pending" as const,
        disclosurePlanCoherence: "pending" as const,
        decision: "pending" as const,
        correctionNotes: "",
      },
    };
  });
  return {
    packet: {
    schemaVersion: "huiyi-synthetic-cohort-review/v1",
    cohortSha256: input.cohortSha256,
    requiredReviewerRole: input.requiredReviewerRole ?? "licensed-clinician",
    reviewer: { reviewerId: null, reviewerRole: null, reviewedAt: null },
    instructions: [
      "All records in this packet are generated synthetic test material, not real patient data or clinical advice.",
      "Review profile/fact consistency, medication and allergy safety, risk-signal coverage, and whether each disclosure plan is coherent and safe.",
      "Set each checklist field to pass or fail, add case-specific correction notes, and set decision to approve-for-engineering or revise.",
      "Do not add real patient information. This review authorizes engineering evaluation only; it does not establish clinical validity.",
    ],
    cases,
    },
    crosswalk: {
      schemaVersion: "huiyi-synthetic-cohort-review-crosswalk/v1",
      cohortSha256: input.cohortSha256,
      items: crosswalkItems,
    },
  };
}

export function createClinicalApprovalFromReview(input: {
  readonly cohort: readonly SyntheticClinicalCase[];
  readonly cohortSha256: string;
  readonly packet: unknown;
  readonly crosswalk: unknown;
  readonly reviewPacketSha256: string;
  readonly reviewCrosswalkSha256: string;
}): { readonly approval: ClinicalCohortApproval; readonly reviewedCaseCount: number } {
  if (!/^[a-f0-9]{64}$/.test(input.reviewPacketSha256) || !/^[a-f0-9]{64}$/.test(input.reviewCrosswalkSha256)) {
    throw new TypeError("review packet and crosswalk hashes must be lowercase SHA-256 digests");
  }
  const packet = asRecord(input.packet, "review packet");
  const crosswalk = asRecord(input.crosswalk, "review crosswalk");
  if (packet.schemaVersion !== "huiyi-synthetic-cohort-review/v1" || packet.cohortSha256 !== input.cohortSha256
    || packet.requiredReviewerRole !== "licensed-clinician"
    || crosswalk.schemaVersion !== "huiyi-synthetic-cohort-review-crosswalk/v1" || crosswalk.cohortSha256 !== input.cohortSha256) {
    throw new TypeError("review packet/crosswalk does not match this exact cohort hash and schema");
  }
  const reviewer = asRecord(packet.reviewer, "reviewer metadata");
  const reviewerId = typeof reviewer.reviewerId === "string" ? reviewer.reviewerId.trim() : "";
  const reviewedAt = typeof reviewer.reviewedAt === "string" ? reviewer.reviewedAt : "";
  if (!reviewerId || reviewerId.length > 160 || reviewer.reviewerRole !== "licensed-clinician"
    || !reviewedAt || Number.isNaN(Date.parse(reviewedAt))) {
    throw new TypeError("completed review packet must identify a licensed-clinician reviewer and valid review timestamp");
  }
  if (!Array.isArray(crosswalk.items) || !Array.isArray(packet.cases) || crosswalk.items.length === 0
    || packet.cases.length !== crosswalk.items.length) throw new TypeError("review packet and crosswalk case counts do not match");

  const cohortById = new Map(input.cohort.map((item) => [item.caseId, item]));
  const crosswalkItems = crosswalk.items.map((item, index) => {
    const entry = asRecord(item, `crosswalk item ${index + 1}`);
    const expectedAlias = `REV-${String(index + 1).padStart(3, "0")}`;
    if (entry.reviewCaseId !== expectedAlias || typeof entry.cohortCaseId !== "string") throw new TypeError("review crosswalk aliases are invalid or out of order");
    const sourceCase = cohortById.get(entry.cohortCaseId);
    if (!sourceCase) throw new TypeError("review crosswalk references a case outside this cohort");
    return { reviewCaseId: expectedAlias, cohortCaseId: entry.cohortCaseId, sourceCase };
  });
  if (new Set(crosswalkItems.map((item) => item.cohortCaseId)).size !== crosswalkItems.length) throw new TypeError("review crosswalk contains duplicate cohort cases");

  const expected = createSyntheticCohortReviewPacket({ cases: crosswalkItems.map((item) => item.sourceCase), cohortSha256: input.cohortSha256 });
  const suppliedCases = packet.cases as unknown[];
  const immutableSuppliedCases = suppliedCases.map((item, index) => {
    const entry = asRecord(item, `review packet case ${index + 1}`);
    if (typeof entry.reviewCaseId !== "string" || entry.reviewCaseId !== crosswalkItems[index]!.reviewCaseId) throw new TypeError("review packet case aliases do not match the private crosswalk");
    const { review: _review, ...immutable } = entry;
    return immutable;
  });
  const immutableExpectedCases = expected.packet.cases.map(({ review: _review, ...immutable }) => immutable);
  if (stableJson(immutableSuppliedCases) !== stableJson(immutableExpectedCases)) {
    throw new TypeError("review packet clinical content differs from the frozen source cohort");
  }

  const approvedCaseIds: string[] = [];
  for (let index = 0; index < suppliedCases.length; index++) {
    const entry = asRecord(suppliedCases[index], `review packet case ${index + 1}`);
    const review = asRecord(entry.review, `review fields for ${crosswalkItems[index]!.reviewCaseId}`);
    const checklist = ["profileFactConsistency", "medicationAllergySafety", "riskSignalCoverage", "disclosurePlanCoherence"] as const;
    if (checklist.some((key) => review[key] !== "pass" && review[key] !== "fail")) throw new TypeError("every case checklist must be completed with pass/fail before importing review");
    if (review.decision === "approve-for-engineering") {
      if (checklist.some((key) => review[key] !== "pass")) throw new TypeError("a case can be approved only when every safety/content checklist passes");
      approvedCaseIds.push(crosswalkItems[index]!.cohortCaseId);
    } else if (review.decision === "revise") {
      if (typeof review.correctionNotes !== "string" || !review.correctionNotes.trim()) throw new TypeError("cases marked revise require correction notes");
    } else {
      throw new TypeError("every case decision must be approve-for-engineering or revise");
    }
  }

  const status = approvedCaseIds.length ? "approved" : "pending";
  return {
    reviewedCaseCount: suppliedCases.length,
    approval: {
      schemaVersion: "huiyi-clinical-approval/v1",
      cohortSha256: input.cohortSha256,
      status,
      reviewerId,
      reviewerRole: "licensed-clinician",
      reviewedAt,
      approvedCaseIds,
      rationale: `Imported synthetic cohort review packet; approved ${approvedCaseIds.length}/${suppliedCases.length} reviewed profiles. Review is an engineering data-quality gate, not evidence of clinical validity.`,
      reviewPacketSha256: input.reviewPacketSha256,
      reviewCrosswalkSha256: input.reviewCrosswalkSha256,
    },
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
