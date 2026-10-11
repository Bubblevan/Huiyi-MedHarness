export interface CodexBridgeConcurrencyAttestation {
  readonly status: "matched" | "mismatch";
  readonly modelMatches: boolean;
  readonly routeMatches: boolean;
  readonly healthy: boolean;
  readonly boundedConcurrency: boolean;
  readonly maxConcurrentTurns: number | null;
}

/** Validate the bridge's sanitized /healthz payload without retaining runtime details. */
export function attestCodexBridgeHealth(value: unknown, expectedModel: string): CodexBridgeConcurrencyAttestation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { status: "mismatch", modelMatches: false, routeMatches: false, healthy: false, boundedConcurrency: false, maxConcurrentTurns: null };
  }
  const health = value as Record<string, unknown>;
  const modelMatches = health.model === expectedModel;
  const routeMatches = health.route === "codex-app-server";
  const healthy = health.status === "ok";
  const max = health.maxConcurrentTurns;
  const counters = [health.activeTurns, health.queuedTurns, health.peakConcurrentTurns];
  const boundedConcurrency = Number.isSafeInteger(max) && (max as number) >= 1 && (max as number) <= 4
    && counters.every((counter) => Number.isSafeInteger(counter) && (counter as number) >= 0 && (counter as number) <= (max as number))
    && (health.activeTurns as number) <= (max as number)
    && (health.peakConcurrentTurns as number) >= (health.activeTurns as number);
  return {
    status: modelMatches && routeMatches && healthy && boundedConcurrency ? "matched" : "mismatch",
    modelMatches,
    routeMatches,
    healthy,
    boundedConcurrency,
    maxConcurrentTurns: Number.isSafeInteger(max) && (max as number) >= 1 && (max as number) <= 4 ? max as number : null,
  };
}
