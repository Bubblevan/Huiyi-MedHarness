import type { CohortSplit, SyntheticClinicalCase } from "./contracts.js";

const SPLITS: readonly CohortSplit[] = ["development", "validation", "held-out"];

export interface SyntheticCohortSplitCoverage {
  readonly patients: number;
  readonly turns: number;
  readonly facts: number;
  readonly scenarioFamilies: Readonly<Record<string, number>>;
  readonly complexity: Readonly<Record<string, number>>;
  readonly expectedTasks: Readonly<Record<string, number>>;
  readonly turnsWithRiskSignals: number;
  readonly turnsRequiringHistoricalFacts: number;
  readonly adaptiveFollowUpCaps: Readonly<Record<string, number>>;
}

export interface SyntheticCohortCoverage {
  readonly patients: number;
  readonly turns: number;
  readonly facts: number;
  readonly reviewStatus: Readonly<Record<string, number>>;
  readonly splits: Readonly<Record<CohortSplit, SyntheticCohortSplitCoverage>>;
}

/** Aggregate cohort design coverage without emitting patient IDs, prose, or fact values. */
export function summarizeSyntheticCohort(cases: readonly SyntheticClinicalCase[]): SyntheticCohortCoverage {
  const splits = Object.fromEntries(SPLITS.map((split) => {
    const selected = cases.filter((item) => item.split === split);
    const turns = selected.flatMap((item) => item.turns);
    return [split, {
      patients: selected.length,
      turns: turns.length,
      facts: selected.reduce((sum, item) => sum + item.facts.length, 0),
      scenarioFamilies: countBy(selected.map((item) => item.scenarioFamily)),
      complexity: countBy(selected.map((item) => item.complexity)),
      expectedTasks: countBy(turns.flatMap((turn) => turn.expectedTaskIds)),
      turnsWithRiskSignals: turns.filter((turn) => turn.expectedRiskSignalIds.length > 0).length,
      turnsRequiringHistoricalFacts: turns.filter((turn) => turn.requiredHistoricalFactIds.length > 0).length,
      adaptiveFollowUpCaps: countBy(turns.flatMap((turn) => turn.patientPlan ? [String(turn.patientPlan.maxFollowUpMessages)] : [])),
    } satisfies SyntheticCohortSplitCoverage];
  })) as Record<CohortSplit, SyntheticCohortSplitCoverage>;

  return {
    patients: cases.length,
    turns: cases.reduce((sum, item) => sum + item.turns.length, 0),
    facts: cases.reduce((sum, item) => sum + item.facts.length, 0),
    reviewStatus: countBy(cases.map((item) => item.clinicalReviewStatus)),
    splits,
  };
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}
