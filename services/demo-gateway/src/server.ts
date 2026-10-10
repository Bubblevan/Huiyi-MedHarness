import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DemoEvent } from "./contracts.js";
import { createEvent, parseDemoEvent, validateChatInput } from "./contracts.js";
import { DshDemoBackend } from "./backends/dsh.js";
import type { DemoBackend } from "./backends/backend.js";
import { readModelConfiguration } from "./backends/dsh-runtime.js";
import { FixtureDemoBackend } from "./backends/fixture.js";
import { getPatient } from "./fixtures.js";

export interface DemoServerOptions {
  backend?: DemoBackend;
  backendName?: "fixture" | "dsh";
  host?: string;
  port?: number;
  log?: (metadata: Record<string, string | number>) => void;
}

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};

async function readJson(request: IncomingMessage, maxBytes = 16_384): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new RangeError("Request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function decodePathSegment(value: string): string | undefined {
  try { return decodeURIComponent(value); }
  catch { return undefined; }
}

function isJsonContentType(request: IncomingMessage): boolean {
  const value = request.headers["content-type"];
  return typeof value === "string" && /^application\/json(?:\s*;|$)/i.test(value.trim());
}

function sendEvent(response: ServerResponse, event: DemoEvent): boolean {
  try {
    const validEvent = parseDemoEvent(event);
    return response.write(`event: ${validEvent.event}\ndata: ${JSON.stringify(validEvent)}\n\n`);
  } catch {
    return false;
  }
}

export function createDemoServer(options: DemoServerOptions = {}): Server {
  const production = process.env.HUIYI_APP_ENV?.trim().toLowerCase() === "production" || process.env.NODE_ENV === "production";
  if (production && process.env.HUIYI_DEMO_SYNTHETIC_AMA_MEMORY?.trim() === "1") {
    throw new Error("Synthetic patient AMA memory is disabled in production");
  }
  const backendName = options.backendName ?? (production || process.env.HUIYI_DEMO_BACKEND === "dsh" ? "dsh" : "fixture");
  if (production && backendName === "fixture") {
    throw new Error("Fixture backend is disabled in production");
  }
  const backend: DemoBackend = options.backend ?? (backendName === "dsh" ? new DshDemoBackend() : new FixtureDemoBackend());
  const activeRuns = new Map<string, { controller: AbortController; sessionId: string; startedAt: number; settled: Promise<void>; settle: () => void }>();
  const log = options.log ?? ((metadata: Record<string, string | number>) => process.stdout.write(`${JSON.stringify(metadata)}\n`));

  const server = createServer((request, response) => {
    const requestId = randomUUID();
    const handleRequest = async (): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";

    if (method === "GET" && url.pathname === "/api/health") {
      const modelConfiguration = backendName === "dsh" ? readModelConfiguration() : undefined;
      json(response, 200, {
        status: "ok",
        backend: backendName,
        ...(modelConfiguration ? {
          modelBackend: process.env.HUIYI_DEMO_MODEL_BACKEND?.trim() || "vllm",
          providerName: modelConfiguration.providerName,
          modelName: modelConfiguration.modelId,
        } : {}),
      });
      return;
    }
    const patientMatch = url.pathname.match(/^\/api\/demo\/patients\/([^/]+)$/);
    if (method === "GET" && patientMatch) {
      if (production) { json(response, 404, { error: "NOT_FOUND" }); return; }
      const patientId = decodePathSegment(patientMatch[1] ?? "");
      if (patientId === undefined) { json(response, 400, { error: "INVALID_PATH" }); return; }
      const patient = getPatient(patientId);
      if (!patient) { json(response, 404, { error: "INVALID_FIXTURE_PATIENT" }); return; }
      json(response, 200, patient);
      return;
    }
    const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (method === "POST" && cancelMatch) {
      const runId = decodePathSegment(cancelMatch[1] ?? "");
      if (runId === undefined) { json(response, 400, { error: "INVALID_PATH" }); return; }
      const run = activeRuns.get(runId);
      if (!run) { json(response, 404, { error: "RUN_NOT_FOUND" }); return; }
      run.controller.abort();
      backend.cancel(runId);
      await run.settled;
      json(response, 202, {
        runId,
        status: "cancelled",
        event: createEvent("run.cancelled", runId, run.sessionId, { reason: "client_cancelled" }),
      });
      return;
    }
    if (method === "POST" && url.pathname === "/api/chat") {
      if (production) {
        json(response, 503, { error: "PATIENT_CONTEXT_ADAPTER_REQUIRED" });
        return;
      }
      if (!isJsonContentType(request)) {
        json(response, 415, { error: "UNSUPPORTED_MEDIA_TYPE" });
        return;
      }
      let input;
      try { input = validateChatInput(await readJson(request)); }
      catch (error) {
        json(response, error instanceof RangeError ? 413 : 400, { error: "INVALID_REQUEST" });
        return;
      }
      if (!getPatient(input.patientId)) { json(response, 422, { error: "INVALID_FIXTURE_PATIENT" }); return; }
      const runId = randomUUID();
      const controller = new AbortController();
      const startedAt = Date.now();
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => { settle = resolve; });
      const runState = { controller, sessionId: input.sessionId, startedAt, settled, settle };
      activeRuns.set(runId, runState);
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-run-id": runId,
      });
      response.flushHeaders();
      response.on("close", () => {
        if (!response.writableEnded) controller.abort();
      });

      let status = "completed";
      let errorCode = "";
      try {
        for await (const event of backend.run(input, { runId, signal: controller.signal })) {
          if (response.destroyed) break;
          if (!sendEvent(response, event)) {
            status = "failed";
            errorCode = "INVALID_EVENT";
            break;
          }
          if (event.event === "run.failed") { status = "failed"; errorCode = event.data.code; }
          if (event.event === "run.cancelled") status = "cancelled";
        }
      } catch (error) {
        status = "failed";
        errorCode = error instanceof Error && error.message.startsWith("BACKEND_UNAVAILABLE") ? "BACKEND_UNAVAILABLE" : "BACKEND_FAILURE";
        if (!response.destroyed) sendEvent(response, {
          version: 1, event: "run.failed", runId, sessionId: input.sessionId,
          timestamp: new Date().toISOString(), data: { code: errorCode as "BACKEND_UNAVAILABLE" | "BACKEND_FAILURE" },
        });
      } finally {
        if (controller.signal.aborted && status === "completed") status = "cancelled";
        activeRuns.delete(runId);
        if (!response.destroyed) response.end();
        const sessionHash = createHash("sha256").update(input.sessionId, "utf8").digest("hex").slice(0, 16);
        try {
          log({ requestId, sessionHash, runId, event: "run.terminal", duration: Date.now() - startedAt, backend: backendName, status, ...(errorCode ? { errorCode } : {}) });
        } finally {
          runState.settle();
        }
      }
      return;
    }
    json(response, 404, { error: "NOT_FOUND" });
    };
    void handleRequest().catch(() => {
      if (response.destroyed) return;
      if (response.headersSent) response.end();
      else json(response, 500, { error: "INTERNAL_ERROR" });
    });
  });
  server.on("close", () => { void Promise.resolve().then(() => backend.dispose?.()).catch(() => undefined); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.HUIYI_DEMO_GATEWAY_PORT ?? "8320");
  const host = "127.0.0.1";
  const server = createDemoServer({ port, host });
  server.listen(port, host, () => process.stdout.write(`Huiyi demo gateway listening on http://${host}:${port}\n`));
}
