import { afterEach, describe, expect, it } from "vitest";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { DshDemoBackend } from "../src/backends/dsh.js";
import { DshWebRuntime, type DshDemoAgent, type DshDemoObserver, type DshDemoRuntimePort } from "../src/backends/dsh-runtime.js";
import { getPatient } from "../src/fixtures.js";
import type { DemoEvent } from "../src/contracts.js";

const patient = getPatient("patient-complex");
if (!patient) throw new Error("Synthetic test patient fixture missing");

class FakeAgent implements DshDemoAgent {
  readonly sentMessages: string[] = [];
  private observer?: DshDemoObserver;
  private idle = Promise.resolve();
  private resolveIdle: () => void = () => undefined;

  private pendingCompletion?: () => void;

  constructor(readonly id: string, private readonly autoComplete = true) {}

  observe(observer: DshDemoObserver | undefined): void { this.observer = observer; }

  followup(message: ReturnType<typeof createUserMessage>): void {
    const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    this.sentMessages.push(text);
    this.idle = new Promise<void>((resolve) => { this.resolveIdle = resolve; });
    const finish = () => {
      if (this.sentMessages.at(-1) === "cancel") return;
      this.observer?.textDelta("DSH answer");
      const evidence = {
        hits: [{ evidenceId: "ev-9", rank: 1, sourceType: "local-corpus", title: "Reference", snippet: "A short evidence passage." }],
      };
      this.observer?.toolStarted({ name: "search_medical_evidence", callId: "rag-call" });
      this.observer?.toolCompleted({ tool: "search_medical_evidence", callId: "rag-call", failed: false, content: [{ type: "text", text: JSON.stringify(evidence) }] });
      const collaboration = {
        complexity: "intermediate",
        plan: { specialists: [{ id: "s1", role: "cardiology" }], teams: [] },
        execution: { childRuns: 2, failedChildRuns: 0, degraded: false },
        specialistFindings: [{ summary: "private finding that must not enter the event" }],
      };
      this.observer?.toolStarted({ name: "consult_clinical_team", callId: "collab-call" });
      this.observer?.toolCompleted({ tool: "consult_clinical_team", callId: "collab-call", failed: false, content: [{ type: "text", text: JSON.stringify(collaboration) }] });
      this.observer?.turnEnded({ kind: "completed" });
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

  constructor(private readonly autoComplete = true) {}

  async createAgent(sessionId: string) {
    const agent = new FakeAgent(sessionId, this.autoComplete);
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

async function collect(backend: DshDemoBackend, sessionId = "web-session", patientId = patient.patientId) {
  const events: DemoEvent[] = [];
  for await (const event of backend.run({ sessionId, patientId, message: "请整理合成病例。" }, { runId: `run-${Math.random()}`, signal: new AbortController().signal })) {
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
    expect(events.map((event) => event.event)).toContain("collaboration.completed");
    expect(events.at(-1)?.event).toBe("run.completed");
    expect(JSON.stringify(events)).not.toContain("private finding");
    expect(events.find((event) => event.event === "collaboration.completed")).toMatchObject({
      data: { complexity: "intermediate", specialistRoles: ["cardiology"], completedChildRuns: 2, degraded: false },
    });
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
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fake DSH Agent state");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}
