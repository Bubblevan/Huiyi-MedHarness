import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient, CodexAppServerModelResponseError, CodexAppServerTurnError, decodeJsonSchemaResponseFormat, isRetryableCodexAppServerFailure, isRetryableCodexAppServerTurnError, parseStructuredCompletion, safeCodexBridgeErrorBody, safeCodexBridgeFailure, startCodexAppServerBridge, structuredCompletionSchema, withBoundedCodexAppServerRetry } from "../src/backends/codex-app-server-bridge.js";
import { readModelConfiguration } from "../src/backends/dsh-runtime.js";

describe("local Codex app-server model route", () => {
  it("declares the GPT-6 Luna model and a loopback-only OpenAI-compatible bridge", () => {
    const config = readModelConfiguration({ HUIYI_DEMO_MODEL_BACKEND: "codex-app-server" });
    expect(config.modelId).toBe("gpt-6-luna");
    expect(config.api).toBe("openai-completions");
    expect(config.baseUrl).toBe("http://127.0.0.1:8333/v1");
    expect(config.apiKeyEnv).toBe("HUIYI_CODEX_BRIDGE_API_KEY");
  });

  it("logs only allowlisted app-server failure facts", () => {
    expect(safeCodexBridgeFailure(new CodexAppServerTurnError("failed"))).toEqual({
      category: "app_server_turn", httpStatus: 502, turnStatus: "failed",
    });
    expect(safeCodexBridgeFailure(new Error("Codex app-server rejected turn/start (-32001)"))).toEqual({
      category: "rpc_rejected", httpStatus: 502, rpcMethod: "turn/start", rpcCode: -32001,
    });
    expect(safeCodexBridgeFailure(new Error("Codex app-server rejected initialize (unknown)"))).toEqual({
      category: "rpc_rejected", httpStatus: 502, rpcMethod: "initialize",
    });
    expect(safeCodexBridgeFailure(Object.assign(new Error("port bind failed"), { code: "EADDRINUSE" }))).toEqual({
      category: "app_server_start", httpStatus: 502, systemErrorCode: "EADDRINUSE",
    });
    expect(safeCodexBridgeFailure(new CodexAppServerModelResponseError())).toEqual({ category: "invalid_model_response", httpStatus: 502 });
    const unknown = JSON.stringify(safeCodexBridgeFailure(new Error("private model output and patient canary")));
    expect(unknown).toBe(JSON.stringify({ category: "unknown", httpStatus: 502 }));
    expect(unknown).not.toContain("patient canary");
  });

  it("retries only bounded provider execution errors, not cancellation or refusal", () => {
    expect(isRetryableCodexAppServerTurnError(new CodexAppServerTurnError("failed"))).toBe(true);
    expect(isRetryableCodexAppServerTurnError(new CodexAppServerTurnError("error"))).toBe(true);
    expect(isRetryableCodexAppServerTurnError(new CodexAppServerTurnError("interrupted"))).toBe(false);
    expect(isRetryableCodexAppServerTurnError(new CodexAppServerTurnError("refusal"))).toBe(false);
    expect(isRetryableCodexAppServerTurnError(new Error("upstream failed"))).toBe(false);
    expect(isRetryableCodexAppServerFailure(new CodexAppServerModelResponseError())).toBe(true);
    expect(isRetryableCodexAppServerFailure(new CodexAppServerTurnError("interrupted"))).toBe(false);
    expect(isRetryableCodexAppServerFailure(new CodexAppServerTurnError("refusal"))).toBe(false);
    expect(isRetryableCodexAppServerFailure(new Error("upstream failed"))).toBe(false);
  });

  it("replays a malformed structured response once with repair guidance and never retries after cancellation", async () => {
    const recovered = vi.fn<(repairMalformedResponse: boolean) => Promise<string>>()
      .mockRejectedValueOnce(new CodexAppServerModelResponseError())
      .mockResolvedValueOnce("valid completion");
    await expect(withBoundedCodexAppServerRetry(recovered)).resolves.toBe("valid completion");
    expect(recovered).toHaveBeenCalledTimes(2);
    expect(recovered).toHaveBeenNthCalledWith(1, false);
    expect(recovered).toHaveBeenNthCalledWith(2, true);

    const turnRetry = vi.fn<(repairMalformedResponse: boolean) => Promise<string>>()
      .mockRejectedValueOnce(new CodexAppServerTurnError("failed"))
      .mockResolvedValueOnce("provider recovered");
    await expect(withBoundedCodexAppServerRetry(turnRetry)).resolves.toBe("provider recovered");
    expect(turnRetry).toHaveBeenCalledTimes(2);
    expect(turnRetry).toHaveBeenNthCalledWith(2, false);

    const controller = new AbortController();
    const cancelled = vi.fn(async (_repairMalformedResponse: boolean) => {
      controller.abort();
      throw new CodexAppServerModelResponseError();
    });
    await expect(withBoundedCodexAppServerRetry(cancelled, controller.signal)).rejects.toBeInstanceOf(CodexAppServerModelResponseError);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it.each(["malformed", "provider", "provider-fails"] as const)("tracks %s retry outcomes without retaining model content", async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "huiyi-codex-bridge-test-"));
    const fakeServer = join(directory, "fake-app-server.mjs");
    await writeFile(fakeServer, `
      import { createInterface } from "node:readline";
      let threadNumber = 0;
      let turnNumber = 0;
      const scenario = process.argv[2];
      const instructionsByThread = new Map();
      const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
      for await (const line of createInterface({ input: process.stdin })) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.method === "initialize") write({ jsonrpc: "2.0", id: message.id, result: {} });
        else if (message.method === "thread/start") {
          const threadId = "fake-thread-" + (++threadNumber);
          instructionsByThread.set(threadId, message.params.developerInstructions ?? "");
          write({ jsonrpc: "2.0", id: message.id, result: { thread: { id: threadId } } });
        } else if (message.method === "turn/start") {
          const threadId = message.params.threadId;
          const attempt = ++turnNumber;
          write({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "fake-turn-" + attempt } } });
          if (scenario !== "malformed" && attempt === 1) {
            write({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { status: "error" } } });
            continue;
          }
          if (scenario === "provider-fails" && attempt === 2) {
            write({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { status: "failed" } } });
            continue;
          }
          const repairWasSupplied = (instructionsByThread.get(threadId) ?? "").includes("previous completion did not match the required structured response schema");
          const text = scenario === "malformed" && attempt === 1 ? "not-json" : JSON.stringify({ content: repairWasSupplied ? "repair-guidance-applied-on-attempt-2" : "provider-recovered-without-repair", tool_calls: [] });
          write({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId, delta: text } });
          write({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { status: "completed" } } });
        }
      }
    `, "utf8");

    const client = new CodexAppServerClient(process.execPath, 1, [fakeServer, scenario]);
    let bridge: Awaited<ReturnType<typeof startCodexAppServerBridge>> | undefined;
    try {
      const request = {
        model: "gpt-6-luna",
        messages: [{ role: "user", content: "synthetic bridge test" }],
        tools: [], toolChoice: "auto", maxTokens: 64, stream: false, includeUsage: false,
      } as const;
      if (scenario === "provider-fails") {
        await expect(client.complete(request)).rejects.toMatchObject({ status: "failed" });
        expect(client.retryCounters).toEqual({ attempts: 1, successes: 0, failures: 1, malformedResponse: 0, providerTurn: 1 });
      } else {
        const result = await client.complete(request);
        expect(result.completion.content).toBe(scenario === "malformed" ? "repair-guidance-applied-on-attempt-2" : "provider-recovered-without-repair");
        expect(result.completion.toolCalls).toEqual([]);
        expect(client.retryCounters).toEqual(scenario === "malformed"
          ? { attempts: 1, successes: 1, failures: 0, malformedResponse: 1, providerTurn: 0 }
          : { attempts: 1, successes: 1, failures: 0, malformedResponse: 0, providerTurn: 1 });
      }
      bridge = await startCodexAppServerBridge({ host: "127.0.0.1", port: await unusedLoopbackPort(), apiKey: "bridge-test-key", client });
      const healthResponse = await fetch(`http://127.0.0.1:${bridge.port}/healthz`);
      expect(healthResponse.ok).toBe(true);
      expect(await healthResponse.json()).toMatchObject({
        status: "ok", model: "gpt-6-luna", route: "codex-app-server",
        retryCounters: client.retryCounters,
      });
    } finally {
      if (bridge) await bridge.close();
      else await client.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes only allowlisted failure diagnostics through the OpenAI-compatible error body", () => {
    const body = safeCodexBridgeErrorBody(safeCodexBridgeFailure(new Error("Codex app-server rejected turn/start (-32001)")));
    expect(body).toEqual({
      error: {
        message: "Codex app-server model request failed",
        type: "upstream_error",
        code: "CODEX_RPC_REJECTED",
        diagnostic: { category: "rpc_rejected", rpcMethod: "turn/start", rpcCode: -32001 },
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/patient|prompt|transcript|model output/i);
  });

  it("refuses a remote bridge URL and model override", () => {
    expect(() => readModelConfiguration({
      HUIYI_DEMO_MODEL_BACKEND: "codex-app-server",
      HUIYI_CODEX_BRIDGE_URL: "https://example.test/v1",
    })).toThrow(/loopback HTTP/);
    expect(() => readModelConfiguration({
      HUIYI_DEMO_MODEL_BACKEND: "codex-app-server",
      HUIYI_DEMO_CODEX_MODEL: "gpt-6-sol",
    })).toThrow(/only allows gpt-6-luna/);
  });

  it("constrains structured output to one declared DSH tool call", () => {
    const schema = structuredCompletionSchema(["search_medical_evidence", "consult_clinical_team"]);
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    const properties = schema.properties as Record<string, unknown>;
    expect((properties.tool_calls as { maxItems: number }).maxItems).toBe(1);
  });

  it("passes a strict JSON response schema into the structured completion schema", () => {
    const responseSchema = {
      type: "object",
      properties: { queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 } },
      required: ["queries"],
      additionalProperties: false,
    };
    const decoded = decodeJsonSchemaResponseFormat({
      type: "json_schema",
      json_schema: { name: "rag_query_plan", strict: true, schema: responseSchema },
    });
    expect(decoded).toEqual(responseSchema);
    expect((structuredCompletionSchema([], "auto", decoded).properties as Record<string, unknown>).content).toEqual(responseSchema);
    expect(parseStructuredCompletion(JSON.stringify({ content: { queries: ["blood pressure follow-up"] }, tool_calls: [] }), [], true).content)
      .toBe('{"queries":["blood pressure follow-up"]}');
    expect(() => decodeJsonSchemaResponseFormat({ type: "json_object" })).toThrow(/strict JSON schema/);
    expect(() => decodeJsonSchemaResponseFormat({
      type: "json_schema", json_schema: { name: "bad schema", strict: true, schema: responseSchema },
    })).toThrow(/strict object schema/);
  });

  it("translates a required or named OpenAI tool choice into a constrained DSH response schema", () => {
    const required = structuredCompletionSchema(["search_medical_evidence", "consult_clinical_team"], "required");
    const requiredCalls = (required.properties as Record<string, { minItems: number }>).tool_calls;
    expect(requiredCalls.minItems).toBe(1);

    const named = structuredCompletionSchema(["search_medical_evidence", "consult_clinical_team"], {
      type: "function", function: { name: "search_medical_evidence" },
    });
    const namedCalls = (named.properties as Record<string, unknown>).tool_calls as {
      items: { properties: { function: { properties: { name: { enum: string[] } } } } };
    };
    expect(namedCalls.items.properties.function.properties.name.enum).toEqual(["search_medical_evidence"]);
    expect(() => structuredCompletionSchema(["search_medical_evidence"], {
      type: "function", function: { name: "not_declared" },
    })).toThrow(/undeclared/);
  });

  it("accepts declared function output and rejects undeclared or malformed calls", () => {
    const valid = JSON.stringify({
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "search_medical_evidence", arguments: "{\"query\":\"guideline\"}" } }],
    });
    expect(parseStructuredCompletion(valid, ["search_medical_evidence"]).toolCalls[0]?.function.name).toBe("search_medical_evidence");
    expect(() => parseStructuredCompletion(valid, [])).toThrow(/undeclared/);
    expect(() => parseStructuredCompletion(JSON.stringify({ content: "", tool_calls: [] }), [])).toThrow(/neither text nor/);
    expect(() => parseStructuredCompletion(JSON.stringify({
      content: "",
      tool_calls: [{ id: "call_2", type: "function", function: { name: "search_medical_evidence", arguments: "[]" } }],
    }), ["search_medical_evidence"])).toThrow(/invalid DSH tool arguments/);
  });
});

async function unusedLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => { server.off("error", rejectListen); resolveListen(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate an ephemeral loopback port for bridge test");
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return port;
}
