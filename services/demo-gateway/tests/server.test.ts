import { afterEach, describe, expect, it } from "vitest";
import { createDemoServer } from "../src/server.js";
import { FixtureDemoBackend } from "../src/backends/fixture.js";

const servers: Array<{ close: () => Promise<void>; baseUrl: string }> = [];

async function start(delayMs = 0) {
  const server = createDemoServer({ backend: new FixtureDemoBackend({ delayMs }), log: () => undefined });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP address");
  const instance = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
  servers.push(instance);
  return instance;
}

function decodeSse(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body.trim().split("\n\n").filter(Boolean).map((block) => {
    const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
    const envelope = JSON.parse(dataLine?.slice(6) ?? "{}") as { data?: Record<string, unknown> };
    return { event: block.split("\n")[0]?.slice("event: ".length) ?? "", data: envelope.data ?? {} };
  });
}

afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

describe("Demo Gateway HTTP/SSE boundary", () => {
  it("serves health and synthetic patient context", async () => {
    const app = await start();
    const health = await fetch(`${app.baseUrl}/api/health`).then((response) => response.json());
    expect(health).toEqual({ status: "ok", backend: "fixture" });
    const patient = await fetch(`${app.baseUrl}/api/demo/patients/patient-htn`).then((response) => response.json());
    expect(patient).toMatchObject({ patientId: "patient-htn", displayName: "张某", memory: { items: 6 } });
    expect(await fetch(`${app.baseUrl}/api/demo/patients/missing`).then((response) => response.status)).toBe(404);
  });

  it("streams ordered deltas whose concatenation is the deterministic answer", async () => {
    const app = await start();
    const response = await fetch(`${app.baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s-1", patientId: "patient-htn", message: "如何记录血压？" }) });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = decodeSse(await response.text());
    const names = events.map(({ event }) => event);
    expect(names[0]).toBe("run.started");
    expect(names.indexOf("context.memory")).toBeLessThan(names.indexOf("evidence.started"));
    expect(names.at(-1)).toBe("run.completed");
    const answer = events.filter(({ event }) => event === "assistant.delta").map(({ data }) => data.text).join("");
    expect(answer).toContain("记录下来");
    expect(events.filter(({ event }) => event === "assistant.delta").length).toBeGreaterThan(3);
  });

  it("reports fixture failure after a partial stream", async () => {
    const app = await start();
    const response = await fetch(`${app.baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s-2", patientId: "patient-htn", message: "失败场景", scenario: "failure" }) });
    const events = decodeSse(await response.text());
    expect(events.map(({ event }) => event)).toContain("assistant.delta");
    expect(events.at(-1)?.data).toMatchObject({ code: "FIXTURE_FAILURE" });
  });

  it("stops later deltas when the run is cancelled", async () => {
    const app = await start(80);
    const response = await fetch(`${app.baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s-3", patientId: "patient-complex", message: "cancel test" }) });
    const runId = response.headers.get("x-run-id");
    expect(runId).toBeTruthy();
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response body missing");
    await reader.read();
    const cancellation = await fetch(`${app.baseUrl}/api/runs/${runId}/cancel`, { method: "POST" });
    expect(cancellation.status).toBe(202);
    expect(await cancellation.json()).toMatchObject({ status: "cancelled", event: { event: "run.cancelled", data: { reason: "client_cancelled" } } });
    const rest: Uint8Array[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      rest.push(next.value);
    }
    const remaining = new TextDecoder().decode(Buffer.concat(rest.map((chunk) => Buffer.from(chunk))));
    expect(remaining).toContain("run.cancelled");
    expect(remaining).not.toContain("run.completed");
    expect(await fetch(`${app.baseUrl}/api/runs/${runId}/cancel`, { method: "POST" }).then((item) => item.status)).toBe(404);
  });

  it("rejects invalid requests and maps an unavailable DSH adapter safely", async () => {
    const app = await start();
    expect(await fetch(`${app.baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((response) => response.status)).toBe(400);
    expect(await fetch(`${app.baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s", patientId: "unknown", message: "hello" }) }).then((response) => response.status)).toBe(422);

    const dsh = createDemoServer({ backendName: "dsh", log: () => undefined });
    await new Promise<void>((resolve) => dsh.listen(0, "127.0.0.1", resolve));
    const address = dsh.address();
    if (!address || typeof address === "string") throw new Error("Expected ephemeral address");
    const dshUrl = `http://127.0.0.1:${address.port}`;
    const answer = await fetch(`${dshUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s", patientId: "patient-htn", message: "hello" }) }).then((response) => response.text());
    expect(answer).toContain("BACKEND_UNAVAILABLE");
    await new Promise<void>((resolve, reject) => dsh.close((error) => error ? reject(error) : resolve()));
  });
});
