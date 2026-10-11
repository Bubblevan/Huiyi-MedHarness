import { randomUUID } from "node:crypto";
import { CLINICAL_EVAL_SCHEMA, type IsolationProbeRecord } from "./contracts.js";
import { MemoryClient } from "../../src/memory/client.js";
import { syntheticPatientMemoryId } from "../../services/demo-gateway/src/backends/dsh-runtime.js";

const SCOPE: IsolationProbeRecord["scope"] = "local Health Engine synthetic AMA memory namespace only; not authorization or production isolation";

export function assessIsolationProbe(input: {
  readonly ownRecallMatchedA: boolean;
  readonly ownRecallMatchedB: boolean;
  readonly crossPatientCanaryLeak: boolean;
  readonly cleanupVerifiedA: boolean;
  readonly cleanupVerifiedB: boolean;
}): IsolationProbeRecord["status"] {
  if (input.crossPatientCanaryLeak) return "fail";
  if (!input.cleanupVerifiedA || !input.cleanupVerifiedB || !input.ownRecallMatchedA || !input.ownRecallMatchedB) return "indeterminate";
  return "pass";
}

export async function runCrossPatientMemoryIsolationProbe(options: {
  readonly client?: MemoryClient;
  readonly now?: () => number;
  readonly id?: string;
} = {}): Promise<IsolationProbeRecord> {
  if (process.env.NODE_ENV === "production" || process.env.HUIYI_APP_ENV?.trim().toLowerCase() === "production") {
    throw new Error("cross-patient memory probe is disabled in production");
  }
  const client = options.client ?? new MemoryClient();
  const startedAt = options.now?.() ?? performance.now();
  const probeId = options.id ?? randomUUID();
  if (!/^[A-Za-z0-9-]{8,80}$/.test(probeId)) throw new TypeError("isolation probe ID must be an opaque token");
  const patientAId = syntheticPatientMemoryId(`isolation:${probeId}:A`);
  const patientBId = syntheticPatientMemoryId(`isolation:${probeId}:B`);
  const sessionA = `hce-iso-${probeId}-a`;
  const sessionB = `hce-iso-${probeId}-b`;
  const canaryA = `HUIYI_ISO_A_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const canaryB = `HUIYI_ISO_B_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  let ownRecallMatchedA = false;
  let ownRecallMatchedB = false;
  let crossPatientCanaryLeak = false;
  let cleanupVerifiedA = false;
  let cleanupVerifiedB = false;
  let operationalError = false;

  try {
    await client.health();
    const seedA = await client.commitTurn({ idempotencyKey: `${sessionA}:1`, userId: patientAId, sessionId: sessionA, turn: 1, userText: `Synthetic isolation probe A stores ${canaryA}.`, assistantText: `Synthetic acknowledgement for ${canaryA}.` });
    if (seedA.status !== "committed" && seedA.status !== "duplicate") throw new Error("synthetic isolation seed A did not commit");
    const endA = await client.sessionEnd({ userId: patientAId, sessionId: sessionA });
    if (!["completed", "duplicate", "skipped"].includes(endA.status)) throw new Error("synthetic isolation session A did not end cleanly");
    const seedB = await client.commitTurn({ idempotencyKey: `${sessionB}:1`, userId: patientBId, sessionId: sessionB, turn: 1, userText: `Synthetic isolation probe B stores ${canaryB}.`, assistantText: `Synthetic acknowledgement for ${canaryB}.` });
    if (seedB.status !== "committed" && seedB.status !== "duplicate") throw new Error("synthetic isolation seed B did not commit");
    const endB = await client.sessionEnd({ userId: patientBId, sessionId: sessionB });
    if (!["completed", "duplicate", "skipped"].includes(endB.status)) throw new Error("synthetic isolation session B did not end cleanly");
    const ownA = await client.recall({ userId: patientAId, sessionId: sessionA, turn: 2, query: canaryA, strong: true });
    const ownB = await client.recall({ userId: patientBId, sessionId: sessionB, turn: 2, query: canaryB, strong: true });
    const crossA = await client.recall({ userId: patientBId, sessionId: sessionB, turn: 2, query: canaryA, strong: true });
    const crossB = await client.recall({ userId: patientAId, sessionId: sessionA, turn: 2, query: canaryB, strong: true });
    ownRecallMatchedA = ownA.items.some((item) => item.content.includes(canaryA));
    ownRecallMatchedB = ownB.items.some((item) => item.content.includes(canaryB));
    crossPatientCanaryLeak = crossA.items.some((item) => item.content.includes(canaryA)) || crossB.items.some((item) => item.content.includes(canaryB));
  } catch {
    operationalError = true;
  } finally {
    const [forgetA, forgetB] = await Promise.allSettled([
      client.forget({ userId: patientAId, confirmation: "forget all patient memory" }),
      client.forget({ userId: patientBId, confirmation: "forget all patient memory" }),
    ]);
    const [statsA, statsB] = await Promise.allSettled([client.stats(patientAId), client.stats(patientBId)]);
    cleanupVerifiedA = forgetA.status === "fulfilled" && statsA.status === "fulfilled" && emptyStats(statsA.value);
    cleanupVerifiedB = forgetB.status === "fulfilled" && statsB.status === "fulfilled" && emptyStats(statsB.value);
  }

  const status = operationalError
    ? crossPatientCanaryLeak ? "fail" : "indeterminate"
    : assessIsolationProbe({ ownRecallMatchedA, ownRecallMatchedB, crossPatientCanaryLeak, cleanupVerifiedA, cleanupVerifiedB });
  const endedAt = options.now?.() ?? performance.now();
  return {
    schemaVersion: CLINICAL_EVAL_SCHEMA,
    recordType: "cross-patient-memory-isolation-probe",
    probeId,
    status,
    createdAt: new Date().toISOString(),
    wallTimeMs: Math.max(0, endedAt - startedAt),
    ownRecallMatched: { patientA: ownRecallMatchedA, patientB: ownRecallMatchedB },
    crossPatientCanaryLeak,
    cleanup: { patientA: cleanupVerifiedA ? "verified" : "failed", patientB: cleanupVerifiedB ? "verified" : "failed" },
    scope: SCOPE,
  };
}

function emptyStats(stats: { readonly records: { readonly raw: number; readonly facts: number; readonly episodes: number } }): boolean {
  return stats.records.raw === 0 && stats.records.facts === 0 && stats.records.episodes === 0;
}
