import type { CollaborationTraceRecord } from "../../src/collaboration/trace.js";

/** Retain allowlisted task/lifecycle metadata only; never serialize case hashes, prompts, model output, roles, or child IDs. */
export function summarizeCollaborationTrace(records: readonly CollaborationTraceRecord[]): {
  readonly childRunCount: number;
  readonly children: readonly {
    readonly task: CollaborationTraceRecord["task"];
    readonly complexity: CollaborationTraceRecord["complexity"];
    readonly status: CollaborationTraceRecord["status"];
    readonly durationMs: number;
    readonly stopReason?: NonNullable<CollaborationTraceRecord["stopReason"]>;
    readonly failureClass?: string;
    readonly validationCode?: string;
    readonly round?: number;
  }[];
} {
  const children = records.filter((record) => record.event === "child");
  return {
    childRunCount: children.length,
    children: children.map((record) => ({
      task: record.task,
      complexity: record.complexity,
      status: record.status,
      durationMs: record.durationMs,
      ...(record.stopReason ? { stopReason: record.stopReason } : {}),
      ...(record.failureClass ? { failureClass: record.failureClass } : {}),
      ...(record.validationCode ? { validationCode: record.validationCode } : {}),
      ...(record.round === undefined ? {} : { round: record.round }),
    })),
  };
}
