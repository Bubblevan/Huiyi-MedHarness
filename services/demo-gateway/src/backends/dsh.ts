import { randomUUID } from "node:crypto";
import { createEvent, type ChatInput, type DemoEvent, type PatientContext } from "../contracts.js";
import { getPatient } from "../fixtures.js";
import type { DemoBackend } from "./backend.js";
import { DshWebRuntime, type DshDemoAgent, type DshDemoRuntimePort, type DshTurnObservation } from "./dsh-runtime.js";

interface SessionEntry {
  readonly handle: { readonly agent: DshDemoAgent; dispose(): Promise<void> };
  readonly patient: PatientContext;
  busyRunId?: string;
  lastUsedAt: number;
}

export interface DshDemoBackendOptions {
  readonly runtime?: DshDemoRuntimePort;
  readonly maxSessions?: number;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

const safeRunFailure = (error: unknown): "BACKEND_UNAVAILABLE" | "SESSION_CAPACITY" =>
  error instanceof Error && error.name === "DshSessionCapacityError" ? "SESSION_CAPACITY" : "BACKEND_UNAVAILABLE";

type ModelFailureCode = Extract<DemoEvent, { event: "run.failed" }> ["data"]["code"];

function failureForTurn(reason: DshTurnObservation["reason"]): ModelFailureCode {
  if (reason.kind !== "error") return "TURN_INCOMPLETE";
  switch (reason.error.code) {
    case "NO_ADAPTER": return "MODEL_ROUTE_UNAVAILABLE";
    case "UNKNOWN_MODEL": return "MODEL_UNKNOWN";
    case "MISSING_CREDENTIAL": return "MODEL_CREDENTIAL_MISSING";
    case "INVALID_CREDENTIAL": return "MODEL_CREDENTIAL_INVALID";
    case "INVALID_CONFIG": return "MODEL_CONFIG_INVALID";
    case "AUTH": return "MODEL_AUTH_FAILED";
    case "TIMEOUT": return "MODEL_TIMEOUT";
    case "RATE_LIMIT": return "MODEL_RATE_LIMIT";
    default: return "MODEL_FAILURE";
  }
}

function emitCollaborationEvents(
  event: DshTurnObservation["toolResults"][number],
  emit: (event: DemoEvent) => void,
  runId: string,
  sessionId: string,
): void {
  if (event.tool !== "consult_clinical_team" || event.failed) return;
  const value = parseJsonText(event.content);
  if (!isRecord(value) || !isRecord(value.plan) || !isRecord(value.execution)) return;
  const complexity = value.complexity;
  if (complexity !== "basic" && complexity !== "intermediate" && complexity !== "advanced") return;
  const specialists = Array.isArray(value.plan.specialists) ? value.plan.specialists : [];
  const teams = Array.isArray(value.plan.teams) ? value.plan.teams : [];
  const specialistRoles = specialists
    .map((specialist) => isRecord(specialist) ? boundedText(specialist.role, 80) : "")
    .filter(Boolean)
    .slice(0, 6);
  const completedChildRuns = nonNegativeInteger(value.execution.childRuns);
  const failedChildRuns = nonNegativeInteger(value.execution.failedChildRuns);
  emit(createEvent("agent.classified", runId, sessionId, { complexity, simulated: false }));
  emit(createEvent("collaboration.completed", runId, sessionId, {
    complexity,
    specialistRoles,
    teamCount: Math.min(3, teams.length),
    completedChildRuns: Math.max(0, completedChildRuns - failedChildRuns),
    failedChildRuns,
    degraded: value.execution.degraded === true || failedChildRuns > 0,
  }));
}

function emitEvidenceEvents(
  event: DshTurnObservation["toolResults"][number],
  emit: (event: DemoEvent) => void,
  runId: string,
  sessionId: string,
): void {
  if (event.tool !== "search_medical_evidence") return;
  const value = parseJsonText(event.content);
  const hits = isRecord(value) && Array.isArray(value.hits) ? value.hits : [];
  const safeHits = hits.flatMap((hit, index) => {
    if (!isRecord(hit)) return [];
    const evidenceId = boundedText(hit.evidenceId, 80);
    const title = boundedText(hit.title, 300);
    const snippet = boundedText(hit.snippet, 1_000);
    if (!evidenceId || !title || !snippet) return [];
    return [{
      evidenceId,
      rank: Number.isInteger(hit.rank) && (hit.rank as number) > 0 ? hit.rank as number : index + 1,
      source: boundedText(hit.sourceType, 120) || boundedText(hit.source, 120) || "Prepared medical corpus",
      title,
      snippet,
    }];
  }).slice(0, 5);
  for (const hit of safeHits) emit(createEvent("evidence.item", runId, sessionId, hit));
  emit(createEvent("evidence.completed", runId, sessionId, { count: safeHits.length }));
}

function parseJsonText(content: unknown): unknown {
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").trim().slice(0, maxLength);
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

/**
 * Web adapter over the native DSH Agent/Session/AgentLoop composition.
 * The map below owns only AgentHandle capabilities; DSH's Session remains the
 * sole conversation transcript and AgentLoop owner.
 */
export class DshDemoBackend implements DemoBackend {
  private readonly runtime: DshDemoRuntimePort;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly pendingSessions = new Map<string, Promise<SessionEntry>>();
  private readonly activeRuns = new Map<string, SessionEntry>();
  private readonly maxSessions: number;
  private sessionMutation: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: DshDemoBackendOptions = {}) {
    this.runtime = options.runtime ?? new DshWebRuntime();
    this.maxSessions = options.maxSessions ?? parseMaxSessions(process.env.HUIYI_DEMO_MAX_SESSIONS);
  }

  cancel(runId: string): void {
    this.activeRuns.get(runId)?.handle.agent.cancel({ kind: "user" });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.activeRuns.values()) entry.handle.agent.cancel({ kind: "user" });
    await Promise.all([...this.sessions.values()].map((entry) => entry.handle.dispose().catch(() => undefined)));
    this.sessions.clear();
    await this.runtime.dispose();
  }

  async *run(input: ChatInput, context: { runId: string; signal: AbortSignal }): AsyncIterable<DemoEvent> {
    const { runId, signal } = context;
    const scenario = input.patientId === "patient-complex" ? "complex" : "simple";
    const startedAt = Date.now();
    const emit = <K extends Parameters<typeof createEvent>[0]>(event: K, data: Parameters<typeof createEvent<K>>[3]) =>
      createEvent(event, runId, input.sessionId, data);
    yield emit("run.started", { backend: "dsh", scenario });

    if (signal.aborted) {
      yield emit("run.cancelled", { reason: "client_cancelled" });
      return;
    }

    const patient = getPatient(input.patientId);
    if (!patient) {
      yield emit("run.failed", { code: "BACKEND_FAILURE" });
      return;
    }

    let entry: SessionEntry;
    try {
      entry = await this.getSession(input.sessionId, patient);
    } catch (error) {
      yield emit("run.failed", { code: safeRunFailure(error) });
      return;
    }

    if (this.disposed) {
      yield emit("run.failed", { code: "BACKEND_UNAVAILABLE" });
      return;
    }
    if (entry.busyRunId) {
      yield emit("run.failed", { code: "SESSION_BUSY" });
      return;
    }

    entry.busyRunId = runId;
    entry.lastUsedAt = Date.now();
    this.activeRuns.set(runId, entry);
    yield emit("context.patient", { patientId: input.patientId });
    yield emit("context.memory", { itemCount: patient.memory.items });

    const queue = new AsyncQueue<DemoEvent>();
    const emitQueued = (event: DemoEvent): void => queue.push(event);
    const toolStartedAt = new Map<string, number>();
    let hasVisibleText = false;
    let turnReason: DshTurnObservation["reason"] | undefined;
    const stopObserving = this.runtime.observe(entry.handle.agent, {
      textDelta: (text) => {
        if (text && !signal.aborted) {
          hasVisibleText = true;
          emitQueued(emit("assistant.delta", { text }));
        }
      },
      toolStarted: (tool) => {
        toolStartedAt.set(tool.callId, Date.now());
        if (tool.name === "search_medical_evidence") emitQueued(emit("evidence.started", { queryLabel: "本地医学参考语料" }));
        emitQueued(emit("tool.started", { tool: tool.name }));
      },
      toolCompleted: (tool) => {
        const durationMs = Math.max(0, Date.now() - (toolStartedAt.get(tool.callId) ?? Date.now()));
        toolStartedAt.delete(tool.callId);
        if (tool.tool === "search_medical_evidence") emitEvidenceEvents(tool, emitQueued, runId, input.sessionId);
        emitCollaborationEvents(tool, emitQueued, runId, input.sessionId);
        emitQueued(emit("tool.completed", { tool: tool.tool, durationMs, status: tool.failed ? "failed" : "completed" }));
      },
      turnEnded: (reason) => { turnReason = reason; },
    });
    const onAbort = (): void => entry.handle.agent.cancel({ kind: "user" });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    let taskSettled = false;
    const task = (async (): Promise<void> => {
      try {
        if (!signal.aborted) {
          entry.handle.agent.followup(this.runtime.createUserMessage(input.message));
          await entry.handle.agent.whenIdle();
        }
        if (signal.aborted || turnReason?.kind === "aborted") {
          emitQueued(emit("run.cancelled", { reason: "client_cancelled" }));
        } else if (turnReason?.kind === "completed" && hasVisibleText) {
          emitQueued(emit("run.completed", { durationMs: Date.now() - startedAt }));
        } else {
          const code = turnReason ? failureForTurn(turnReason) : "TURN_INCOMPLETE";
          emitQueued(emit("run.failed", { code }));
        }
      } catch {
        emitQueued(emit("run.failed", { code: "MODEL_FAILURE" }));
      } finally {
        taskSettled = true;
        signal.removeEventListener("abort", onAbort);
        stopObserving();
        this.activeRuns.delete(runId);
        if (entry.busyRunId === runId) entry.busyRunId = undefined;
        entry.lastUsedAt = Date.now();
        queue.close();
      }
    })();

    try {
      for await (const event of queue) yield event;
      await task;
    } finally {
      if (!taskSettled) {
        entry.handle.agent.cancel({ kind: "user" });
        await task;
      }
    }
  }

  private async getSession(browserSessionId: string, patient: PatientContext): Promise<SessionEntry> {
    if (this.disposed) throw new Error("DshRuntimeDisposedError");
    const key = JSON.stringify([browserSessionId, patient.patientId]);
    const current = this.sessions.get(key);
    if (current) return current;
    const pending = this.pendingSessions.get(key);
    if (pending) return pending;

    const creation = this.withSessionMutation(async () => {
      const raced = this.sessions.get(key);
      if (raced) return raced;
      if (this.disposed) throw new Error("DshRuntimeDisposedError");
      while (this.sessions.size >= this.maxSessions) {
        const candidate = [...this.sessions.entries()]
          .filter(([, entry]) => !entry.busyRunId)
          .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
        if (!candidate) {
          const error = new Error("Demo DSH session capacity is exhausted");
          error.name = "DshSessionCapacityError";
          throw error;
        }
        this.sessions.delete(candidate[0]);
        await candidate[1].handle.dispose();
      }
      const handle = await this.runtime.createAgent(`huiyi-demo-${randomUUID()}`, patient);
      const entry: SessionEntry = { handle, patient, lastUsedAt: Date.now() };
      this.sessions.set(key, entry);
      return entry;
    });
    this.pendingSessions.set(key, creation);
    try { return await creation; }
    finally { this.pendingSessions.delete(key); }
  }

  private async withSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionMutation;
    let release!: () => void;
    this.sessionMutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }
}

function parseMaxSessions(raw: string | undefined): number {
  if (!raw) return 16;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 128 ? value : 16;
}
