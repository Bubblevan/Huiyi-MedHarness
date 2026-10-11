import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { DshDemoBackend, dshAgentSessionId, type DshDemoBackendOptions } from "../src/backends/dsh.js";
import { DshWebRuntime, type DshDemoAgent, type DshDemoObserver, type DshDemoRuntimePort, type DshTurnObservation } from "../src/backends/dsh-runtime.js";
import { getPatient } from "../src/demo-seed/patients.js";
import type { DemoEvent } from "../src/contracts.js";

const patient = getPatient("patient-complex");
if (!patient) throw new Error("Synthetic test patient fixture missing");
const patientId = patient.patientId;

interface FakeUsageEvent {
  readonly scope: "root" | "subagent";
  readonly sessionId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

class FakeAgent implements DshDemoAgent {
  readonly sentMessages: string[] = [];
  private observer?: DshDemoObserver;
  private idle = Promise.resolve();
  private resolveIdle: () => void = () => undefined;

  private pendingCompletion?: () => void;

  constructor(
    readonly id: string,
    private readonly autoComplete = true,
    private readonly usageEvents: readonly FakeUsageEvent[] = [],
    private readonly terminalReason: DshTurnObservation["reason"] = { kind: "completed" },
  ) {}

  observe(observer: DshDemoObserver | undefined): void { this.observer = observer; }

  followup(message: ReturnType<typeof createUserMessage>): void {
    const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    this.sentMessages.push(text);
    this.idle = new Promise<void>((resolve) => { this.resolveIdle = resolve; });
    const finish = () => {
      if (this.sentMessages.at(-1) === "cancel") return;
      for (const usage of this.usageEvents) this.observer?.usage?.(usage, usage.scope, usage.sessionId);
      this.observer?.textDelta("DSH answer");
      const evidence = {
        query: "private synthetic patient query",
        mode: "iterative",
        corpusVersion: "corpus-v1",
        retrieval: {
          rounds: 2, generatedQueries: 4, uniqueDocuments: 8, candidateCount: 12, returnedEvidenceCount: 1,
          retrievalCalls: 4, plannerCalls: 2, retrievalLatencyMs: 100, plannerLatencyMs: 200, latencyMs: 300,
          estimatedContextTokens: 500, plannerModel: "gpt-6-luna", plannerPromptVersion: "v1",
          plannerInputTokens: 1000, plannerOutputTokens: 20, generatedQueryHashes: ["a"], degraded: false,
        },
        hits: [{ evidenceId: "ev-9", rank: 1, sourceType: "local-corpus", title: "Reference", snippet: "A short evidence passage." }],
      };
      this.observer?.toolStarted({ name: "search_medical_evidence", callId: "rag-call" });
      this.observer?.toolCompleted({ tool: "search_medical_evidence", callId: "rag-call", failed: false, content: [{ type: "text", text: JSON.stringify(evidence) }] });
      const collaboration = {
        complexity: "intermediate",
        plan: { specialists: [{ id: "s1", role: "cardiology" }], teams: [] },
        context: {
          externalEvidenceHitCount: 1,
          externalEvidenceStatus: "retrieved",
          externalEvidenceRetrieval: {
            mode: "single", corpusVersion: "corpus-v1", rounds: 1, generatedQueries: 0,
            uniqueDocuments: 1, candidateCount: 1, returnedEvidenceCount: 1, retrievalCalls: 1,
            plannerCalls: 0, retrievalLatencyMs: 100, plannerLatencyMs: 0, latencyMs: 100,
            estimatedContextTokens: 50, plannerModel: "gpt-6-luna", plannerPromptVersion: "",
            degraded: false,
          },
        },
        execution: { childRuns: 2, failedChildRuns: 0, degraded: false },
        specialistFindings: [{ summary: "private finding that must not enter the event" }],
      };
      this.observer?.toolStarted({ name: "consult_clinical_team", callId: "collab-call" });
      this.observer?.toolCompleted({ tool: "consult_clinical_team", callId: "collab-call", failed: false, content: [{ type: "text", text: JSON.stringify(collaboration) }] });
      this.observer?.turnEnded(this.terminalReason);
      this.resolveIdle();
    };
    if (this.autoComplete) queueMicrotask(finish);
    else this.pendingCompletion = finish;
  }

  complete(): void { this.pendingCompletion?.(); this.pendingCompletion = undefined; }

  cancel(): void {
    this.pendingCompletion = undefined;
    this.observer?.turnEnded({ kind: "aborted", reason: { kind: "user" } });
    this.resolveIdle();
  }

  whenIdle(): Promise<void> { return this.idle; }
}

class FakeRuntime implements DshDemoRuntimePort {
  readonly agents: FakeAgent[] = [];
  created = 0;
  disposed = 0;
  runtimeDisposed = 0;
  memoryFlushed = 0;

  constructor(
    private readonly autoComplete = true,
    private readonly usageEvents: readonly FakeUsageEvent[] = [],
    private readonly terminalReason: DshTurnObservation["reason"] = { kind: "completed" },
  ) {}

  async createAgent(sessionId: string) {
    const agent = new FakeAgent(sessionId, this.autoComplete, this.usageEvents, this.terminalReason);
    this.agents.push(agent);
    this.created += 1;
    return { agent, dispose: async () => { this.disposed += 1; } };
  }

  createUserMessage(text: string) { return createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] }); }
  observe(agent: DshDemoAgent, observer: DshDemoObserver) {
    const fake = agent as FakeAgent;
    fake.observe(observer);
    return () => fake.observe(undefined);
  }
  async flushMemory(): Promise<void> { this.memoryFlushed += 1; }
  async dispose(): Promise<void> { this.runtimeDisposed += 1; }
}

class GatedRuntime extends FakeRuntime {
  private releaseGate!: () => void;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
  private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });

  constructor() { super(false); }

  override async createAgent(sessionId: string) {
    this.markStarted();
    await this.gate;
    return super.createAgent(sessionId);
  }

  release(): void { this.releaseGate(); }
}

const backends: DshDemoBackend[] = [];

async function collect(backend: DshDemoBackend, sessionId = "web-session", patientIdForRun = patientId) {
  const events: DemoEvent[] = [];
  for await (const event of backend.run({ sessionId, patientId: patientIdForRun, message: "请整理合成病例。" }, { runId: `run-${Math.random()}`, signal: new AbortController().signal })) {
    events.push(event);
  }
  return events;
}

afterEach(async () => { await Promise.all(backends.splice(0).map((backend) => backend.dispose())); });

describe("native DSH demo backend", () => {
  it("streams only user-visible text and metadata-safe RAG/collaboration summaries", async () => {
    const runtime = new FakeRuntime();
    const backend = new DshDemoBackend({ runtime });
    backends.push(backend);
    const events = await collect(backend);
    expect(events.map((event) => event.event)).toContain("assistant.delta");
    expect(events.map((event) => event.event)).toContain("evidence.item");
    expect(events.find((event) => event.event === "evidence.completed")).toMatchObject({
      data: { retrieval: { mode: "iterative", retrievalCalls: 4, plannerCalls: 2, plannerModel: "gpt-6-luna", corpusVersion: "corpus-v1" } },
    });
    expect(events.map((event) => event.event)).toContain("collaboration.completed");
    expect(events.at(-1)?.event).toBe("run.completed");
    expect(JSON.stringify(events)).not.toContain("private finding");
    expect(JSON.stringify(events)).not.toContain("private synthetic patient query");
    expect(events.find((event) => event.event === "collaboration.completed")).toMatchObject({
      data: {
        complexity: "intermediate", specialistRoles: ["cardiology"], completedChildRuns: 2, degraded: false,
        externalEvidence: { status: "retrieved", hitCount: 1, retrieval: { mode: "single", retrievalCalls: 1, corpusVersion: "corpus-v1" } },
      },
    });
  });

  it("aggregates root and unique subagent token usage without leaking session IDs", async () => {
    const reported: Array<{ runId: string; usage: Parameters<NonNullable<DshDemoBackendOptions["observeTokenUsage"]>>[1] }> = [];
    const runtime = new FakeRuntime(true, [
      { scope: "root", sessionId: "root-id", inputTokens: 100, outputTokens: 10 },
      { scope: "subagent", sessionId: "child-a", inputTokens: 40, outputTokens: 4 },
      { scope: "subagent", sessionId: "child-a", inputTokens: 20, outputTokens: 2 },
      { scope: "subagent", sessionId: "child-b", inputTokens: 30, outputTokens: 3 },
    ]);
    const backend = new DshDemoBackend({ runtime, observeTokenUsage: (runId, usage) => reported.push({ runId, usage }) });
    backends.push(backend);

    await collect(backend, "usage-session");

    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      usage: {
        rootInputTokens: 100, rootOutputTokens: 10, rootTotalTokens: 110,
        subagentInputTokens: 90, subagentOutputTokens: 9, subagentTotalTokens: 99,
        subagentSessionCount: 2,
      },
    });
    expect(JSON.stringify(reported)).not.toContain("child-a");
    expect(JSON.stringify(reported)).not.toContain("child-b");
  });

  it("reports only safe provider failure metadata and never serializes the raw error message", async () => {
    const runtime = new FakeRuntime(true, [], {
      kind: "error",
      error: {
        code: "RATE_LIMIT",
        status: 429,
        message: "private model response and patient canary must not be recorded",
        requestId: "sensitive-request-id",
      },
    });
    const backend = new DshDemoBackend({ runtime });
    backends.push(backend);

    const events = await collect(backend, "failure-session");
    const failed = events.find((event) => event.event === "run.failed");

    expect(failed).toMatchObject({
      event: "run.failed",
      data: { code: "MODEL_RATE_LIMIT", diagnostic: { category: "rate_limit", providerErrorCode: "RATE_LIMIT", httpStatus: 429 } },
    });
    expect(JSON.stringify(events)).not.toContain("private model response");
    expect(JSON.stringify(events)).not.toContain("sensitive-request-id");
  });

  it("reuses the DSH Agent for turns in the same browser session", async () => {
    const runtime = new FakeRuntime();
    const backend = new DshDemoBackend({ runtime });
    backends.push(backend);
    await collect(backend, "same-session");
    await collect(backend, "same-session");
    expect(runtime.created).toBe(1);
    expect(runtime.agents[0]?.sentMessages).toHaveLength(2);
  });

  it("keeps patient contexts isolated even when a browser reuses its session id", async () => {
    const runtime = new FakeRuntime();
    const backend = new DshDemoBackend({ runtime });
    backends.push(backend);
    await collect(backend, "same-browser-session", "patient-complex");
    await collect(backend, "same-browser-session", "patient-htn");
    expect(runtime.created).toBe(2);
    expect(runtime.agents[0]?.sentMessages).toHaveLength(1);
    expect(runtime.agents[1]?.sentMessages).toHaveLength(1);
  });

  it("accepts caller-owned synthetic patient contexts and explicitly closes an encounter session", async () => {
    const runtime = new FakeRuntime();
    const customPatient = { ...patient, patientId: "synthetic-eval-pseudonym-01" };
    const backend = new DshDemoBackend({ runtime, resolvePatient: (patientId) => patientId === customPatient.patientId ? customPatient : undefined });
    backends.push(backend);
    const events = await collect(backend, "clinical-encounter-1", customPatient.patientId);
    expect(events).toContainEqual(expect.objectContaining({ event: "context.patient", data: { patientId: customPatient.patientId } }));
    expect(runtime.agents[0]?.id).toBe(dshAgentSessionId("clinical-encounter-1", customPatient.patientId, customPatient.encounterId));
    expect(runtime.memoryFlushed).toBe(1);
    await backend.closeSession("clinical-encounter-1", customPatient.patientId);
    expect(runtime.disposed).toBe(1);
    expect(runtime.memoryFlushed).toBe(2);
    await collect(backend, "clinical-encounter-2", customPatient.patientId);
    expect(runtime.created).toBe(2);
  });

  it("rejects overlapping turns on one DSH session and caps active session creation", async () => {
    const runtime = new FakeRuntime(false);
    const backend = new DshDemoBackend({ runtime, maxSessions: 1 });
    backends.push(backend);
    const firstEvents: DemoEvent[] = [];
    const firstRun = (async () => {
      for await (const event of backend.run(
        { sessionId: "busy-session", patientId: patient.patientId, message: "hold" },
        { runId: "busy-run", signal: new AbortController().signal },
      )) firstEvents.push(event);
    })();
    await waitFor(() => runtime.agents[0]?.sentMessages.length === 1);

    const overlapping = await collect(backend, "busy-session");
    expect(overlapping.at(-1)).toMatchObject({ event: "run.failed", data: { code: "SESSION_BUSY" } });
    const overCapacity = await collect(backend, "another-session");
    expect(overCapacity.at(-1)).toMatchObject({ event: "run.failed", data: { code: "SESSION_CAPACITY" } });

    runtime.agents[0]?.complete();
    await firstRun;
    expect(firstEvents.at(-1)?.event).toBe("run.completed");
    expect(runtime.created).toBe(1);
  });

  it("evicts and disposes the least-recently-used idle session at the configured cap", async () => {
    const runtime = new FakeRuntime();
    const backend = new DshDemoBackend({ runtime, maxSessions: 1 });
    backends.push(backend);
    await collect(backend, "first-session");
    await collect(backend, "second-session");
    expect(runtime.created).toBe(2);
    expect(runtime.disposed).toBe(1);
    await backend.dispose();
    expect(runtime.disposed).toBe(2);
  });

  it("disposes a child Agent created concurrently with backend shutdown", async () => {
    const runtime = new GatedRuntime();
    const backend = new DshDemoBackend({ runtime });
    backends.push(backend);
    const iterator = backend.run(
      { sessionId: "late-session", patientId: patient.patientId, message: "request" },
      { runId: "late-run", signal: new AbortController().signal },
    )[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.event).toBe("run.started");
    const next = iterator.next();
    await runtime.started;
    const disposal = backend.dispose();
    runtime.release();
    await disposal;
    expect((await next).value).toMatchObject({ event: "run.failed", data: { code: "BACKEND_UNAVAILABLE" } });
    expect(runtime.disposed).toBe(1);
    expect(runtime.runtimeDisposed).toBe(1);
  });

  it("maps caller cancellation onto the native DSH agent and disposes its handle", async () => {
    const runtime = new FakeRuntime();
    const backend = new DshDemoBackend({ runtime });
    backends.push(backend);
    const controller = new AbortController();
    const iterator = backend.run({ sessionId: "cancel-session", patientId: patient.patientId, message: "cancel" }, { runId: "cancel-run", signal: controller.signal })[Symbol.asyncIterator]();
    const pending = (async () => {
      const events: DemoEvent[] = [];
      while (true) {
        const item = await iterator.next();
        if (item.done) return events;
        events.push(item.value);
      }
    })();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    backend.cancel("cancel-run");
    controller.abort();
    const events = await pending;
    expect(events.at(-1)?.event).toBe("run.cancelled");
    await backend.dispose();
    expect(runtime.disposed).toBe(1);
  });

  it("composes a real DSH AgentHandle without contacting a model", async () => {
    const runtime = new DshWebRuntime();
    const handle = await runtime.createAgent(`composition-${Date.now()}`, patient);
    expect(handle.agent.id).toContain("composition-");
    await handle.dispose();
    await runtime.dispose();
  });

  it("attributes direct subagent usage to its root run without observing child prose", () => {
    const sessionListeners: ((...args: unknown[]) => void)[] = [];
    const rootContext = {
      on: (eventName: string, listener: (...args: unknown[]) => void) => {
        if (eventName === "session/event") sessionListeners.push(listener);
        return () => undefined;
      },
    } as unknown as Context;
    const streamContext = {
      on: (eventName: string) => () => undefined,
    } as unknown as Context;
    const runtime = new DshWebRuntime();
    (runtime as unknown as { ctx: Context }).ctx = rootContext;
    const observer: DshDemoObserver = {
      textDelta: () => undefined,
      toolStarted: () => undefined,
      toolCompleted: () => undefined,
      turnEnded: () => undefined,
      usage: vi.fn(),
    };
    const agent = { id: "root-session", ctx: streamContext } as unknown as DshDemoAgent;
    runtime.observe(agent, observer);

    const emit = (session: unknown, usage: { inputTokens: number; outputTokens: number }) => {
      sessionListeners[0]?.(session, { type: "assistant/message", data: { usage } });
    };
    emit({ id: "root-session" }, { inputTokens: 100, outputTokens: 10 });
    emit({ id: "child-session", header: { origin: "subagent", parentSession: "root-session" } }, { inputTokens: 40, outputTokens: 4 });
    emit({ id: "unrelated-child", header: { origin: "subagent", parentSession: "another-root" } }, { inputTokens: 900, outputTokens: 90 });

    expect(observer.usage).toHaveBeenNthCalledWith(1, { inputTokens: 100, outputTokens: 10 }, "root", "root-session");
    expect(observer.usage).toHaveBeenNthCalledWith(2, { inputTokens: 40, outputTokens: 4 }, "subagent", "child-session");
    expect(observer.usage).toHaveBeenCalledTimes(2);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fake DSH Agent state");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}
