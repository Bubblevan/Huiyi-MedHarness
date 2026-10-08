import { describe, expect, it } from "vitest";
import { createEvent, DEMO_EVENTS, parseDemoEvent, type DemoEventName, type EventDataMap } from "../src/contracts.js";

const data: { [K in DemoEventName]: EventDataMap[K] } = {
  "run.started": { backend: "fixture", scenario: "simple" },
  "context.patient": { patientId: "patient-htn" },
  "context.memory": { itemCount: 6 },
  "evidence.started": { queryLabel: "synthetic" },
  "evidence.item": { evidenceId: "ev-001", rank: 1, source: "Demo evidence fixture", title: "Synthetic", snippet: "Synthetic snippet" },
  "evidence.completed": { count: 1 },
  "agent.classified": { complexity: "simple", simulated: false },
  "specialist.started": { specialist: "心内科", simulated: true },
  "specialist.completed": { specialist: "心内科", durationMs: 10, simulated: true },
  "tool.started": { tool: "search_demo_evidence" },
  "tool.completed": { tool: "search_demo_evidence", durationMs: 10, status: "completed" },
  "assistant.delta": { text: "chunk" },
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
  });
});
