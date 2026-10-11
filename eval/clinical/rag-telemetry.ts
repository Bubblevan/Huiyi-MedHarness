import type { RagRetrievalTelemetry } from "../../services/demo-gateway/src/contracts.js";

/** Deduplicate exact safe-metadata copies emitted by more than one gateway event. */
export function uniqueRagRetrievalTelemetry(
  references: readonly RagRetrievalTelemetry[],
): RagRetrievalTelemetry[] {
  const byFingerprint = new Map<string, RagRetrievalTelemetry>();
  for (const telemetry of references) {
    const fingerprint = JSON.stringify(Object.entries(telemetry).sort(([left], [right]) => left.localeCompare(right)));
    byFingerprint.set(fingerprint, telemetry);
  }
  return [...byFingerprint.values()];
}
