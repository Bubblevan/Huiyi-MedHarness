import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MAX_TRACE_BYTES = 20 * 1024 * 1024;
const traceKeys = new Set([
  "event", "requestId", "edgeTraceId", "runId", "sessionHash", "modelRequestId",
  "backend", "modelBackend", "providerName", "modelName", "route", "stage",
  "status", "outcome", "errorCode", "errorCategory", "rpcMethod", "rpcCode",
  "systemErrorCode", "turnStatus", "eventName", "lastEvent", "reason",
  "durationMs", "elapsedMs", "queueWaitMs", "firstByteMs", "firstEventMs",
  "firstAssistantDeltaMs", "firstModelDeltaMs", "threadStartMs", "turnStartMs",
  "httpStatus", "contentType", "messageCount", "toolCount", "eventCount",
  "assistantDeltaCount", "assistantChars", "toolStartedCount", "toolCompletedCount",
  "evidenceItemCount", "modelDeltaCount", "modelOutputChars", "outputChars", "emittedBytes", "sseBytes", "sseEventCount", "sseDataBytes",
  "activeTurns", "queuedTurns", "maxConcurrentTurns", "retryCount", "retryReason",
  "attempt", "turnIdPresent", "runIdPresent", "hasVisibleText", "usagePresent",
  "rootInputTokens", "rootOutputTokens", "rootTotalTokens", "subagentInputTokens",
  "subagentOutputTokens", "subagentTotalTokens", "subagentSessionCount",
]);

const tracePath = resolve(process.env.HUIYI_DEMO_TRACE_PATH?.trim() || join(
  process.env.LOCALAPPDATA?.trim() || join(homedir(), ".local", "share"),
  "HuiyiMedHarness", "traces", "gateway-trace.jsonl",
));

export function localGatewayTracePath(): string {
  return tracePath;
}

/** Appends only explicitly allowlisted operational metadata; prompt and answer fields are discarded. */
export function writeLocalGatewayTrace(fields: Readonly<Record<string, unknown>>): void {
  try {
    const event = typeof fields.event === "string" ? fields.event.slice(0, 80) : "trace.unknown";
    const safe: Record<string, string | number | boolean> = { timestamp: new Date().toISOString(), event };
    for (const [key, value] of Object.entries(fields)) {
      if (key === "event" || !traceKeys.has(key)) continue;
      if (typeof value === "string" && value.length <= 120) safe[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
      else if (typeof value === "boolean") safe[key] = value;
    }
    const line = `${JSON.stringify(safe)}\n`;
    mkdirSync(dirname(tracePath), { recursive: true });
    if (existsSync(tracePath) && statSync(tracePath).size + Buffer.byteLength(line) > MAX_TRACE_BYTES) {
      const previous = `${tracePath}.1`;
      if (existsSync(previous)) unlinkSync(previous);
      renameSync(tracePath, previous);
      try { chmodSync(previous, 0o600); } catch { /* Windows ACLs inherit from the user profile. */ }
    }
    appendFileSync(tracePath, line, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(tracePath, 0o600); } catch { /* Windows ACLs inherit from the user profile. */ }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code.replace(/[^A-Z0-9_]/g, "").slice(0, 32) || "UNKNOWN"
      : "UNKNOWN";
    try { process.stderr.write(`${JSON.stringify({ event: "gateway.trace.write_failed", errorCode: code })}\n`); } catch { /* tracing never breaks a request */ }
  }
}
