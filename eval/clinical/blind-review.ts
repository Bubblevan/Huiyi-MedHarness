import { CLINICAL_EVAL_SCHEMA, type ClinicalReviewRecord, type EvalArm, type SyntheticClinicalCase, type SyntheticFact, type SyntheticTurn } from "./contracts.js";
import { validateReview } from "./scoring.js";

export interface ClinicalBlindReviewPacket {
  readonly schemaVersion: "huiyi-clinical-review-packet/v1";
  readonly packetId: string;
  readonly blindedArm: "A" | "B";
  readonly caseId: string;
  readonly split: string;
  readonly scenarioFamily: string;
  readonly complexity: string;
  readonly synthetic: true;
  readonly turnId: string;
  readonly conversationSoFar: readonly { readonly role: "patient" | "assistant"; readonly text: string }[];
  readonly patientMessage: string;
  readonly referenceFactsForAdjudication: readonly SyntheticFact[];
  readonly expectedCriteria: SyntheticTurn;
  readonly assistantText: string;
  readonly evidenceMetadata: readonly { readonly evidenceId: string; readonly source: string; readonly title: string; readonly rank: number; readonly snippet: string }[];
  adjudication: Omit<ClinicalReviewRecord, "schemaVersion" | "recordType" | "reviewId" | "runId" | "caseId" | "turnId" | "blindedArm">;
}

export interface ClinicalReviewKeyEntry {
  readonly packetId: string;
  readonly runId: string;
  readonly caseId: string;
  readonly turnId: string;
  readonly actualArm: EvalArm;
  readonly blindedArm: "A" | "B";
}

export function makeBlindReviewPacket(input: {
  readonly packetId: string;
  readonly blindedArm: "A" | "B";
  readonly case: SyntheticClinicalCase;
  readonly turn: SyntheticTurn;
  readonly review: ClinicalReviewRecord;
  readonly patientMessage?: string;
  readonly conversationSoFar: readonly { readonly role: "patient" | "assistant"; readonly text: string }[];
  readonly assistantText: string;
  readonly evidenceMetadata: ClinicalBlindReviewPacket["evidenceMetadata"];
}): ClinicalBlindReviewPacket {
  if (input.review.caseId !== input.case.caseId || input.review.turnId !== input.turn.turnId) throw new TypeError("blind packet review, case, and turn do not match");
  const { schemaVersion: _schemaVersion, recordType: _recordType, reviewId: _reviewId, runId: _runId, caseId: _caseId, turnId: _turnId, blindedArm: _blindedArm, ...adjudication } = input.review;
  const { patientPlan: _patientPlan, ...reviewableTurn } = input.turn;
  const patientMessage = input.patientMessage ?? input.turn.patientMessage;
  return {
    schemaVersion: "huiyi-clinical-review-packet/v1", packetId: input.packetId, blindedArm: input.blindedArm,
    caseId: input.case.caseId, split: input.case.split, scenarioFamily: input.case.scenarioFamily,
    complexity: input.case.complexity, synthetic: true, turnId: input.turn.turnId,
    conversationSoFar: input.conversationSoFar, patientMessage,
    referenceFactsForAdjudication: input.case.facts.filter((fact) => new Set([
      ...input.turn.requiredHistoricalFactIds, ...input.turn.requiredCurrentFactIds, ...input.turn.expectedRiskSignalIds,
    ]).has(fact.factId)),
    expectedCriteria: { ...reviewableTurn, patientMessage }, assistantText: input.assistantText,
    evidenceMetadata: input.evidenceMetadata, adjudication,
  };
}

export function mergeBlindedReviews(input: {
  readonly packets: readonly ClinicalBlindReviewPacket[];
  readonly key: readonly ClinicalReviewKeyEntry[];
}): ClinicalReviewRecord[] {
  const keyByPacket = new Map(input.key.map((entry) => [entry.packetId, entry]));
  if (keyByPacket.size !== input.key.length) throw new TypeError("review key packet IDs must be unique");
  const seen = new Set<string>();
  return input.packets.map((packet) => {
    if (packet.schemaVersion !== "huiyi-clinical-review-packet/v1" || packet.synthetic !== true) throw new TypeError("invalid or non-synthetic blind review packet");
    if (seen.has(packet.packetId)) throw new TypeError(`duplicate review packet ${packet.packetId}`);
    seen.add(packet.packetId);
    const key = keyByPacket.get(packet.packetId);
    if (!key || key.caseId !== packet.caseId || key.turnId !== packet.turnId) throw new TypeError(`blind review key does not match packet ${packet.packetId}`);
    if (packet.blindedArm !== "A" && packet.blindedArm !== "B") throw new TypeError(`invalid blinded arm for packet ${packet.packetId}`);
    if (packet.blindedArm !== key.blindedArm) throw new TypeError(`blinded arm was changed for packet ${packet.packetId}`);
    const adjudication = packet.adjudication as unknown as Record<string, unknown>;
    const allowedAdjudicationKeys = new Set(["status", "reviewerId", "taskChecks", "historyFacts", "medicalClaims", "riskChecks", "complexityPoints", "draftReview", "notes"]);
    if (Object.keys(adjudication).some((field) => !allowedAdjudicationKeys.has(field))) throw new TypeError(`blind packet contains protected or unknown adjudication fields for ${packet.packetId}`);
    const review: ClinicalReviewRecord = {
      schemaVersion: CLINICAL_EVAL_SCHEMA,
      recordType: "human-review",
      reviewId: `review-${key.runId}`,
      runId: key.runId,
      caseId: key.caseId,
      turnId: key.turnId,
      blindedArm: key.blindedArm,
      status: adjudication.status as ClinicalReviewRecord["status"],
      reviewerId: adjudication.reviewerId as string | null,
      taskChecks: adjudication.taskChecks as ClinicalReviewRecord["taskChecks"],
      historyFacts: adjudication.historyFacts as ClinicalReviewRecord["historyFacts"],
      medicalClaims: adjudication.medicalClaims as ClinicalReviewRecord["medicalClaims"],
      riskChecks: adjudication.riskChecks as ClinicalReviewRecord["riskChecks"],
      complexityPoints: adjudication.complexityPoints as ClinicalReviewRecord["complexityPoints"],
      draftReview: adjudication.draftReview as ClinicalReviewRecord["draftReview"],
      notes: adjudication.notes as string,
    };
    validateReview(review);
    return review;
  });
}
