import type { SyntheticClinicalCase } from "./contracts.js";

/** Match recalled AMA text to the synthetic gold catalog without returning or persisting the text. */
export function matchSyntheticRecallFactIds(syntheticCase: SyntheticClinicalCase, recalledText: string): string[] {
  const normalizedText = normalize(recalledText);
  if (!normalizedText) return [];
  const eligibleFacts = syntheticCase.facts.filter((fact) => fact.value !== syntheticCase.patient.privateIsolationCanary)
    .map((fact) => ({ fact, normalizedValue: normalize(fact.value) }))
    .filter(({ normalizedValue }) => normalizedValue.length >= 8);
  const valueCounts = new Map<string, number>();
  for (const candidate of eligibleFacts) valueCounts.set(candidate.normalizedValue, (valueCounts.get(candidate.normalizedValue) ?? 0) + 1);
  return eligibleFacts
    .filter(({ normalizedValue }) => valueCounts.get(normalizedValue) === 1 && normalizedText.includes(normalizedValue))
    .map(({ fact }) => fact.factId);
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}
