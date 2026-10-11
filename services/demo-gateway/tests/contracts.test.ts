import { describe, expect, it } from "vitest";
import { createEvent, DEMO_EVENTS, parseDemoEvent, validateChatInput, type DemoEventName, type EventDataMap } from "../src/contracts.js";

const data: { [K in DemoEventName]: EventDataMap[K] } = {
  "run.started": { backend: "fixture", scenario: "simple" },
  "context.patient": { patientId: "patient-htn" },
  "context.memory": { itemCount: 6 },
  "evidence.started": { queryLabel: "synthetic" },
  "evidence.item": { evidenceId: "ev-001", rank: 1, source: "Demo evidence fixture", title: "Synthetic", snippet: "Synthetic snippet" },
  "evidence.completed": { count: 1, retrieval: {
    mode: "iterative", rounds: 2, generatedQueries: 4, uniqueDocuments: 7, candidateCount: 12,
    returnedEvidenceCount: 1, retrievalCalls: 4, plannerCalls: 2, retrievalLatencyMs: 120.5,
    plannerLatencyMs: 500.5, latencyMs: 621, estimatedContextTokens: 900,
    plannerModel: "gpt-6-luna", plannerPromptVersion: "v1", corpusVersion: "corpus-v1", degraded: false,
    plannerInputTokens: 20, plannerOutputTokens: 10,
  } },
  "agent.classified": { complexity: "simple", simulated: false },
  "specialist.started": { specialist: "心内科", simulated: true },
  "specialist.completed": { specialist: "心内科", durationMs: 10, simulated: true },
  "tool.started": { tool: "search_demo_evidence" },
  "tool.completed": { tool: "search_demo_evidence", durationMs: 10, status: "completed" },
  "collaboration.completed": { complexity: "intermediate", specialistRoles: ["cardiology"], teamCount: 0, completedChildRuns: 2, failedChildRuns: 0, degraded: false },
  "assistant.delta": { text: "chunk" },
  "draft.updated": { draftId: "draft-1", version: 1, status: "preliminary" },
  "draft.save_failed": { code: "DRAFT_SAVE_FAILED" },
  "run.completed": { durationMs: 100 },
  "run.cancelled": { reason: "client_cancelled" },
  "run.failed": { code: "FIXTURE_FAILURE" },
};

describe("Huiyi demo event contract", () => {
  it("round trips every discriminated event and validates its payload", () => {
    expect(Object.keys(data)).toEqual(DEMO_EVENTS);
    for (const event of DEMO_EVENTS) {
      const parsed = parseDemoEvent(createEvent(event, "run-1", "session-1", data[event]));
      expect(parsed.event).toBe(event);
      expect(parsed.version).toBe(1);
    }
  });

  it("rejects malformed envelopes and payloads at runtime", () => {
    expect(() => parseDemoEvent({ version: 2 })).toThrow(/envelope/);
    expect(() => parseDemoEvent({ ...createEvent("assistant.delta", "r", "s", { text: "x" }), data: { text: 42 } })).toThrow(/Invalid data/);
    expect(() => parseDemoEvent({
      ...createEvent("run.failed", "r", "s", { code: "MODEL_FAILURE" }),
      data: { code: "MODEL_FAILURE", diagnostic: { category: "provider", message: "raw provider response" } },
    })).toThrow(/Invalid data/);
  });

  it("accepts bounded provider failure metadata without retaining raw messages", () => {
    const parsed = parseDemoEvent(createEvent("run.failed", "r", "s", {
      code: "MODEL_RATE_LIMIT",
      diagnostic: { category: "rate_limit", providerErrorCode: "RATE_LIMIT", httpStatus: 429 },
    }));
    expect(parsed).toMatchObject({ data: { diagnostic: { category: "rate_limit", providerErrorCode: "RATE_LIMIT", httpStatus: 429 } } });
  });

  it("validates RAG telemetry using counters only", () => {
    const retrieval = data["evidence.completed"].retrieval!;
    expect(parseDemoEvent(createEvent("evidence.completed", "r", "s", { count: 1, retrieval })))
      .toMatchObject({ data: { retrieval: { plannerCalls: 2 } } });
    expect(() => parseDemoEvent(createEvent("evidence.completed", "r", "s", {
      count: 1, retrieval: { ...retrieval, candidateCount: -1 },
    }))).toThrow(/Invalid data/);
    expect(() => parseDemoEvent(createEvent("evidence.completed", "r", "s", {
      count: 1, retrieval: { ...retrieval, query: "patient-identifying text" },
    } as never))).toThrow(/Invalid data/);
  });

  it("accepts the documented Unicode message limit but rejects malformed or smuggled fields", () => {
    const message = "医".repeat(4000);
    expect(validateChatInput({ sessionId: "session-1", patientId: "patient-htn", message }).message).toBe(message);
    expect(() => validateChatInput({ sessionId: "", patientId: "patient-htn", message: "valid" })).toThrow(/Invalid chat request/);
    expect(() => validateChatInput({ sessionId: "session-1", patientId: "patient-htn", message: "valid", systemPrompt: "override" })).toThrow(/Invalid chat request/);
    expect(() => validateChatInput({ sessionId: "bad\nsession", patientId: "patient-htn", message: "valid" })).toThrow(/Invalid chat request/);
  });
});
