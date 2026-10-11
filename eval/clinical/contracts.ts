import type { RagRetrievalTelemetry } from "../../services/demo-gateway/src/contracts.js";

export const CLINICAL_EVAL_SCHEMA = "huiyi-clinical-eval/v1" as const;
export const CLINICAL_EVAL_GENERATOR = "synthetic-longitudinal-v2" as const;
export const LEGACY_CLINICAL_EVAL_GENERATOR = "synthetic-longitudinal-v1" as const;
export const TARGET_TURNS_PER_PATIENT = 8;

export type CohortSplit = "development" | "validation" | "held-out";
export type EvalArm = "single-agent" | "integrated";
export type PatientSimulationMode = "scripted" | "adaptive";
export type PatientQuestionIntent = "chief-concern" | "timeline" | "prior-history" | "medication" | "allergy" | "source" | "preference" | "safety";

export interface SyntheticPatientDisclosure {
  readonly factIds: readonly string[];
  readonly triggers: readonly PatientQuestionIntent[];
}

export interface SyntheticPatientPlan {
  readonly openingMessage: string;
  readonly initialFactIds: readonly string[];
  readonly disclosures: readonly SyntheticPatientDisclosure[];
  readonly maxFollowUpMessages: number;
}

export interface IsolationProbeRecord {
  readonly schemaVersion: typeof CLINICAL_EVAL_SCHEMA;
  readonly recordType: "cross-patient-memory-isolation-probe";
  readonly probeId: string;
  readonly status: "pass" | "fail" | "indeterminate";
  readonly createdAt: string;
  readonly wallTimeMs: number;
  readonly ownRecallMatched: { readonly patientA: boolean; readonly patientB: boolean };
  readonly crossPatientCanaryLeak: boolean;
  readonly cleanup: { readonly patientA: "verified" | "failed"; readonly patientB: "verified" | "failed" };
  readonly scope: "local Health Engine synthetic AMA memory namespace only; not authorization or production isolation";
}

export interface SyntheticFact {
  readonly factId: string;
  readonly encounterId: string;
  readonly category: "history" | "current" | "preference" | "risk";
  readonly label: string;
  readonly value: string;
  readonly synthetic: true;
}

export interface SyntheticTurn {
  readonly turnId: string;
  readonly encounterId: string;
  readonly patientMessage: string;
  /** Optional deterministic interview plan; omitted in legacy cohort snapshots. */
  readonly patientPlan?: SyntheticPatientPlan;
  readonly expectedTaskIds: readonly string[];
  readonly requiredHistoricalFactIds: readonly string[];
  readonly requiredCurrentFactIds: readonly string[];
  readonly expectedRiskSignalIds: readonly string[];
  readonly expectedComplexityPointIds: readonly string[];
  readonly evidenceTopics: readonly string[];
}

export interface SyntheticClinicalCase {
  readonly schemaVersion: typeof CLINICAL_EVAL_SCHEMA;
  readonly generatorVersion: typeof CLINICAL_EVAL_GENERATOR | typeof LEGACY_CLINICAL_EVAL_GENERATOR;
  readonly synthetic: true;
  readonly clinicalReviewStatus: "pending" | "approved";
  readonly caseId: string;
  readonly seed: number;
  readonly split: CohortSplit;
  readonly scenarioFamily: string;
  readonly complexity: "basic" | "complex";
  readonly patient: {
    readonly patientId: string;
    readonly age: number;
    readonly gender: "female" | "male";
    readonly displayName: string;
    readonly privateIsolationCanary: string;
  };
  readonly facts: readonly SyntheticFact[];
  readonly turns: readonly SyntheticTurn[];
  readonly fhirBundle: FhirBundle;
}

export interface FhirBundle {
  readonly resourceType: "Bundle";
  readonly type: "collection";
  readonly timestamp: string;
  readonly meta: { readonly tag: readonly { readonly system: string; readonly code: string; readonly display: string }[] };
  readonly entry: readonly { readonly fullUrl: string; readonly resource: Record<string, unknown> }[];
}

export interface ClinicalRunRecord {
  readonly schemaVersion: typeof CLINICAL_EVAL_SCHEMA;
  readonly recordType: "turn-run";
  readonly runId: string;
  readonly caseId: string;
  readonly turnId: string;
  readonly clinicalReviewStatus: "pending" | "approved";
  readonly arm: EvalArm;
  readonly model: string;
  readonly patientMessage: string;
  readonly patientSimulation?: {
    readonly mode: PatientSimulationMode;
    readonly assistantExchanges: number;
    readonly patientFollowUps: number;
    readonly maxPatientFollowUps: number;
    readonly disclosedFactIds: readonly string[];
    /** Facts disclosed within the current Encounter conversation only. */
    readonly encounterDisclosedFactIds?: readonly string[];
    /** All facts disclosed to this simulated patient-agent conversation through the end of this turn. */
    readonly cumulativeDisclosedFactIds?: readonly string[];
    /** Historical facts previously disclosed in a closed Encounter and therefore eligible for AMA rehydration. */
    readonly amaRecallEligibleFactIds?: readonly string[];
    readonly triggeredIntents: readonly PatientQuestionIntent[];
    readonly transcript: readonly { readonly role: "patient" | "assistant"; readonly text: string }[];
  };
  readonly assistantText: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly failureCode?: string;
  readonly failureDiagnostic?: {
    readonly category: "authentication" | "rate_limit" | "timeout" | "provider" | "unknown";
    readonly providerErrorCode?: string;
    readonly httpStatus?: number;
  };
  readonly wallTimeMs: number;
  readonly dshDurationMs?: number;
  readonly startedAt: string;
  readonly evidence: readonly { readonly evidenceId: string; readonly source: string; readonly title: string; readonly rank: number }[];
  readonly ragRetrievals?: readonly RagRetrievalTelemetry[];
  readonly toolCalls: readonly { readonly tool: string; readonly status: "started" | "completed" | "failed"; readonly durationMs?: number }[];
  readonly collaboration?: {
    readonly complexity: string;
    readonly childRuns: number;
    readonly failedChildRuns: number;
    readonly degraded: boolean;
  };
  readonly tokenUsage: {
    readonly scope: "dsh-agent-tree" | "unavailable";
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly rootInputTokens?: number;
    readonly rootOutputTokens?: number;
    readonly rootTotalTokens?: number;
    readonly subagentInputTokens?: number;
    readonly subagentOutputTokens?: number;
    readonly subagentTotalTokens?: number;
    readonly subagentSessionsObserved?: number;
    readonly subagentSessionsExpected?: number;
    readonly subagentAttributionComplete?: boolean;
  };
  readonly memoryUsage?: {
    readonly scope: "health-engine-ama";
    readonly traceRecords: number;
    readonly llmCalls: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly usageReports: number;
    readonly retrievalRounds: number;
    readonly failedOperations: number;
    readonly operationCounts: Readonly<Record<string, number>>;
    /** Fact IDs matched in returned AMA items; recalled text is never stored here. */
    readonly recalledFacts?: readonly ClinicalMemoryRecallFact[];
  };
}

export interface ClinicalMemoryRecallFact {
  readonly factId: string;
  readonly kind: "raw" | "fact" | "episode";
  readonly sourceId?: string;
  readonly operation: "automatic_recall" | "manual_recall";
  readonly turn: number;
  /** Exact synthetic fact value was present in the completed assistant response. */
  readonly echoedInAssistant?: boolean;
}

export interface ClinicalReviewRecord {
  readonly schemaVersion: typeof CLINICAL_EVAL_SCHEMA;
  readonly recordType: "human-review";
  readonly reviewId: string;
  readonly runId: string;
  readonly caseId: string;
  readonly turnId: string;
  readonly blindedArm: "A" | "B";
  status: "pending" | "adjudicated";
  reviewerId: string | null;
  taskChecks: Record<string, boolean | null>;
  historyFacts: Record<string, "correct" | "omitted" | "incorrect" | "not-applicable" | null>;
  medicalClaims: {
    total: number | null;
    evidenceSupported: number | null;
    unsupported: number | null;
    cited: number | null;
    citationValid: number | null;
  };
  riskChecks: Record<string, "recognized-and-escalated" | "recognized-not-escalated" | "missed" | null>;
  complexityPoints: Record<string, boolean | null>;
  draftReview: {
    readonly exported: boolean;
    structured: boolean | null;
    clinicianApproved: boolean | null;
    reviewerId: string | null;
    reviewedAt: string | null;
  };
  notes: string;
}
