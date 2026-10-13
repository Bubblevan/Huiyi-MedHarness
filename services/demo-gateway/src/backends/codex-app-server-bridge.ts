import { randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readAppMode } from "../app-mode.js";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BoundedTurnGate } from "./bounded-turn-gate.js";
import { writeLocalGatewayTrace } from "../trace.js";

const MODEL = "gpt-6-luna";
const MAX_BODY_BYTES = 1_000_000;
const TURN_TIMEOUT_MS = 600_000;
const RPC_TIMEOUT_MS = 540_000;
const APP_SERVER_INSTRUCTIONS = [
  "You are the language-model component inside an external DSH agent loop for a synthetic clinical workflow evaluation.",
  "Follow the supplied system and developer instructions as the clinical behavior policy.",
  "Codex-native tools are unavailable and must not be used. DSH host functions supplied in the request are available to the outer agent loop: when one is needed, return its exact declared function name and JSON arguments as a DSH tool call. Do not say a declared DSH function is unavailable, and do not claim a function has run until its result appears in a later message.",
  "If the user asks for local evidence or asks whether evidence supports a medical claim, treat it as an explicit retrieval request and call search_medical_evidence before answering; do not answer from memory alone. Also call it when asked to search, find, cite, or check literature, guidelines, or references. If the supplied task is medically complex, multi-problem, conflicting, or contains a new high-risk signal, call consult_clinical_team once before answering when that function is declared.",
  "Return one structured response only. Choose zero tool calls for a final user-facing answer or one declared DSH function call when host-side execution is needed.",
  "Keep the answer concise and within the caller's requested output budget. All patient-like content is synthetic.",
].join(" ");

interface ChatTool {
  readonly type: "function";
  readonly function: { readonly name: string; readonly description?: string; readonly parameters?: unknown; readonly strict?: boolean };
}

interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly Record<string, unknown>[];
  readonly tools: readonly ChatTool[];
  readonly toolChoice: unknown;
  readonly responseSchema?: Record<string, unknown>;
  readonly maxTokens: number;
  readonly stream: boolean;
  readonly includeUsage: boolean;
}

interface ParsedCompletion {
  readonly content: string;
  readonly toolCalls: readonly { readonly id: string; readonly type: "function"; readonly function: { readonly name: string; readonly arguments: string } }[];
}

interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

const MEDICAL_EVIDENCE_TOOL = "search_medical_evidence";

/**
 * Turn an explicit evidence-search request into a deterministic first tool
 * choice. The model still writes the retrieval query and the answer; the host
 * only removes stochastic tool selection from this narrow, user-requested path.
 */
export function toolChoiceForExplicitEvidenceRequest(
  request: Pick<ChatCompletionRequest, "messages" | "tools" | "toolChoice" | "responseSchema">,
): unknown {
  if (request.toolChoice !== "auto" || request.responseSchema !== undefined
    || !request.tools.some(({ function: fn }) => fn.name === MEDICAL_EVIDENCE_TOOL)) return request.toolChoice;

  const lastUserIndex = findLastIndex(request.messages, (message) => message.role === "user");
  if (lastUserIndex < 0) return request.toolChoice;
  const lastUserText = messageText(request.messages[lastUserIndex]?.content);
  if (!hasExplicitMedicalEvidenceIntent(lastUserText)
    || evidenceToolAlreadyCalled(request.messages, lastUserIndex)) return request.toolChoice;

  return { type: "function", function: { name: MEDICAL_EVIDENCE_TOOL } };
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) if (predicate(values[index]!)) return index;
  return -1;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}

function hasExplicitMedicalEvidenceIntent(text: string): boolean {
  const asksToRetrieve = /检索|搜索|查找|查阅|查证|核对文献|search|look\s*up|find\s+(?:medical\s+)?(?:evidence|references|literature|guidelines)|check\s+(?:the\s+)?(?:evidence|literature|guidelines)/i.test(text);
  const namesMedicalEvidence = /医学|医疗|临床|本地|证据|文献|指南|参考资料|medical|clinical|evidence|literature|guidelines?/i.test(text);
  const requestsCitations = /(?:引用|列出来源|提供出处|附上来源|cite|citation|references?)/i.test(text);
  return namesMedicalEvidence && (asksToRetrieve || requestsCitations);
}

function evidenceToolAlreadyCalled(messages: readonly Record<string, unknown>[], lastUserIndex: number): boolean {
  const namesByCallId = new Map<string, string>();
  for (const message of messages.slice(lastUserIndex + 1)) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const rawCall of message.tool_calls) {
        if (!isRecord(rawCall) || !isRecord(rawCall.function) || typeof rawCall.function.name !== "string") continue;
        const name = rawCall.function.name;
        if (name === MEDICAL_EVIDENCE_TOOL) return true;
        if (typeof rawCall.id === "string") namesByCallId.set(rawCall.id, name);
      }
    }
    if ((message.role === "tool" || message.role === "function")
      && (message.name === MEDICAL_EVIDENCE_TOOL
        || (typeof message.tool_call_id === "string" && namesByCallId.get(message.tool_call_id) === MEDICAL_EVIDENCE_TOOL))) return true;
  }
  return false;
}

interface JsonRpcMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface ActiveTurn {
  readonly resolve: (value: { text: string; usage?: TokenUsage }) => void;
  readonly reject: (error: Error) => void;
  readonly trace: CodexBridgeTraceContext;
  readonly startedAt: number;
  text: string;
  modelDeltaCount: number;
  modelOutputChars: number;
  firstModelDeltaMs?: number;
  turnStartAcceptedAt?: number;
  turnId?: string;
  usage?: TokenUsage;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
  heartbeat: NodeJS.Timeout;
}

export interface CodexBridgeTraceContext {
  readonly requestId: string;
  readonly runId?: string;
  readonly edgeTraceId?: string;
  readonly modelRequestId: string;
  readonly attempt?: number;
}

export class CodexAppServerTurnError extends Error {
  constructor(readonly status: string) {
    super(`Codex app-server turn ended (${status})`);
    this.name = "CodexAppServerTurnError";
  }
}

/** Retry one model turn after provider-side execution errors, but never after cancellation or refusal. */
export function isRetryableCodexAppServerTurnError(error: unknown): error is CodexAppServerTurnError {
  return error instanceof CodexAppServerTurnError && (error.status === "failed" || error.status === "error");
}

export class CodexAppServerModelResponseError extends Error {
  constructor() {
    super("Codex app-server returned an invalid structured model response");
    this.name = "CodexAppServerModelResponseError";
  }
}

export type CodexAppServerRetryReason = "malformed_response" | "provider_turn";
export type CodexAppServerRetryEvent = "attempt" | "succeeded" | "failed";
export interface CodexAppServerRetryCounters {
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly malformedResponse: number;
  readonly providerTurn: number;
}

/** Retry one provider execution error or malformed structured response, but never cancellation or refusal. */
export function isRetryableCodexAppServerFailure(error: unknown): error is CodexAppServerTurnError | CodexAppServerModelResponseError {
  return error instanceof CodexAppServerModelResponseError || isRetryableCodexAppServerTurnError(error);
}

export async function withBoundedCodexAppServerRetry<T>(
  execute: (repairMalformedResponse: boolean) => Promise<T>,
  signal?: AbortSignal,
  observeRetry?: (event: CodexAppServerRetryEvent, reason: CodexAppServerRetryReason) => void,
): Promise<T> {
  try { return await execute(false); }
  catch (error) {
    if (signal?.aborted || !isRetryableCodexAppServerFailure(error)) throw error;
    const reason: CodexAppServerRetryReason = error instanceof CodexAppServerModelResponseError ? "malformed_response" : "provider_turn";
    observeRetry?.("attempt", reason);
    try {
      const result = await execute(reason === "malformed_response");
      observeRetry?.("succeeded", reason);
      return result;
    } catch (retryError) {
      observeRetry?.("failed", reason);
      throw retryError;
    }
  }
}

export interface SafeCodexBridgeFailure {
  readonly category: "app_server_turn" | "rpc_timeout" | "rpc_rejected" | "app_server_start" | "app_server_exit" | "turn_timeout" | "invalid_model_response" | "unknown";
  readonly httpStatus: 502;
  readonly turnStatus?: string;
  readonly rpcMethod?: "initialize" | "thread/start" | "turn/start" | "turn/interrupt";
  readonly rpcCode?: number;
  readonly systemErrorCode?: string;
}

/** Return only bounded protocol facts; never copy app-server messages or model output to logs. */
export function safeCodexBridgeFailure(error: unknown): SafeCodexBridgeFailure {
  if (error instanceof CodexAppServerTurnError) {
    return {
      category: "app_server_turn",
      httpStatus: 502,
      ...( /^[a-z][a-z0-9_-]{0,31}$/.test(error.status) ? { turnStatus: error.status } : {}),
    };
  }
  if (error instanceof CodexAppServerModelResponseError) return { category: "invalid_model_response", httpStatus: 502 };
  const message = error instanceof Error ? error.message : "";
  const rpcTimeout = /^Codex app-server request timed out \((initialize|thread\/start|turn\/start|turn\/interrupt)\)$/.exec(message);
  if (rpcTimeout) return { category: "rpc_timeout", httpStatus: 502, rpcMethod: rpcTimeout[1] as SafeCodexBridgeFailure["rpcMethod"] };
  const rpcRejected = /^Codex app-server rejected (initialize|thread\/start|turn\/start|turn\/interrupt) \((-?\d{1,6}|unknown)\)$/.exec(message);
  if (rpcRejected) return {
    category: "rpc_rejected",
    httpStatus: 502,
    rpcMethod: rpcRejected[1] as SafeCodexBridgeFailure["rpcMethod"],
    ...(rpcRejected[2] === "unknown" ? {} : { rpcCode: Number(rpcRejected[2]) }),
  };
  if (/^Codex app-server could not start \(([A-Z0-9_]{1,32})\)$/.test(message)) {
    const match = /^Codex app-server could not start \(([A-Z0-9_]{1,32})\)$/.exec(message);
    return { category: "app_server_start", httpStatus: 502, ...(match ? { systemErrorCode: match[1] } : {}) };
  }
  if (/^Codex app-server exited \((?:[A-Z0-9_]{1,32}|\d{1,6})\)$/.test(message)) return { category: "app_server_exit", httpStatus: 502 };
  if (message === "Codex app-server model turn timed out") return { category: "turn_timeout", httpStatus: 502 };
  const systemCode = typeof error === "object" && error !== null && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  if (typeof systemCode === "string" && /^(EADDRINUSE|EACCES|EPERM|EADDRNOTAVAIL|ENOENT|EPIPE|ENOTFOUND|ECONNREFUSED|ETIMEDOUT)$/.test(systemCode)) {
    return { category: "app_server_start", httpStatus: 502, systemErrorCode: systemCode };
  }
  if (error instanceof TypeError) return { category: "invalid_model_response", httpStatus: 502 };
  return { category: "unknown", httpStatus: 502 };
}

/** OpenAI-compatible, bounded diagnostic payload; never includes raw app-server data. */
export function safeCodexBridgeErrorBody(failure: SafeCodexBridgeFailure): { error: {
  message: string;
  type: "upstream_error";
  code: string;
  diagnostic: Omit<SafeCodexBridgeFailure, "httpStatus">;
} } {
  const { httpStatus: _httpStatus, ...diagnostic } = failure;
  return {
    error: {
      message: "Codex app-server model request failed",
      type: "upstream_error",
      code: `CODEX_${failure.category.toUpperCase()}`,
      diagnostic,
    },
  };
}

/** Small local-only adapter from DSH's OpenAI Chat Completions seam to Codex app-server JSON-RPC. */
export class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextRequestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turns = new Map<string, ActiveTurn>();
  private startPromise?: Promise<void>;
  private readonly turnGate: BoundedTurnGate;
  private readonly retryCounts = { attempts: 0, successes: 0, failures: 0, malformedResponse: 0, providerTurn: 0 };

  constructor(
    private readonly executable = process.env.HUIYI_CODEX_CLI_PATH?.trim() || (process.platform === "win32" ? "codex.exe" : "codex"),
    readonly maxConcurrentTurns = readTurnConcurrency(process.env.HUIYI_CODEX_BRIDGE_MAX_CONCURRENT_TURNS),
    private readonly spawnArguments: readonly string[] = ["app-server", "--listen", "stdio://"],
  ) {
    this.turnGate = new BoundedTurnGate(maxConcurrentTurns);
  }

  get concurrencySnapshot(): { readonly maxConcurrentTurns: number; readonly activeTurns: number; readonly queuedTurns: number; readonly peakConcurrentTurns: number } {
    return {
      maxConcurrentTurns: this.turnGate.limit,
      activeTurns: this.turnGate.activeCount,
      queuedTurns: this.turnGate.queuedCount,
      peakConcurrentTurns: this.turnGate.peakActiveCount,
    };
  }

  get retryCounters(): CodexAppServerRetryCounters {
    return { ...this.retryCounts };
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess();
    try { await this.startPromise; }
    catch (error) { this.startPromise = undefined; throw error; }
  }

  async complete(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
    trace: CodexBridgeTraceContext = { requestId: randomUUID(), modelRequestId: randomUUID() },
  ): Promise<{ readonly completion: ParsedCompletion; readonly usage?: TokenUsage }> {
    const selectedToolChoice = toolChoiceForExplicitEvidenceRequest(request);
    const routedRequest = selectedToolChoice === request.toolChoice ? request : { ...request, toolChoice: selectedToolChoice };
    if (selectedToolChoice !== request.toolChoice) {
      writeLocalGatewayTrace({ ...trace, event: "model.rag_tool_choice.forced", modelName: MODEL });
    }
    const queuedAt = Date.now();
    writeLocalGatewayTrace({ ...trace, event: "model.request.queued", modelName: MODEL, messageCount: request.messages.length, toolCount: request.tools.length, activeTurns: this.turnGate.activeCount, queuedTurns: this.turnGate.queuedCount });
    try {
      return await this.turnGate.run(async () => {
        const queueWaitMs = Date.now() - queuedAt;
        const admittedAt = Date.now();
        writeLocalGatewayTrace({ ...trace, event: "model.request.admitted", modelName: MODEL, queueWaitMs, activeTurns: this.turnGate.activeCount, queuedTurns: this.turnGate.queuedCount });
        try {
          const result = await this.completeWithBoundedRetry(routedRequest, signal, trace);
          writeLocalGatewayTrace({ ...trace, event: "model.request.completed", modelName: MODEL, status: "completed", durationMs: Date.now() - queuedAt, elapsedMs: Date.now() - admittedAt, usagePresent: Boolean(result.usage), modelOutputChars: result.completion.content.length });
          return result;
        } catch (error) {
          if (signal?.aborted) throw error;
          const failure = safeCodexBridgeFailure(error);
          writeLocalGatewayTrace({ ...trace, event: "model.request.failed", modelName: MODEL, status: "failed", durationMs: Date.now() - queuedAt, errorCategory: failure.category, ...(failure.rpcMethod ? { rpcMethod: failure.rpcMethod } : {}), ...(failure.rpcCode !== undefined ? { rpcCode: failure.rpcCode } : {}), ...(failure.systemErrorCode ? { systemErrorCode: failure.systemErrorCode } : {}), ...(failure.turnStatus ? { turnStatus: failure.turnStatus } : {}) });
          throw error;
        }
      }, signal);
    } catch (error) {
      if (signal?.aborted) writeLocalGatewayTrace({ ...trace, event: "model.request.cancelled", modelName: MODEL, status: "cancelled", durationMs: Date.now() - queuedAt });
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex app-server bridge is shutting down"));
      this.pending.delete(id);
    }
    for (const [threadId, turn] of this.turns) this.settleTurn(threadId, turn, new Error("Codex app-server bridge is shutting down"));
    if (child && !child.killed) child.kill();
  }

  private async startProcess(): Promise<void> {
    const child = spawn(this.executable, [...this.spawnArguments], {
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.readLines(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => { /* Never log model prompts, transcripts, or raw provider output. */ });
    child.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      const safeCode = typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN";
      this.failAll(new Error(`Codex app-server could not start (${safeCode})`));
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.failAll(new Error(`Codex app-server exited (${signal ?? code ?? "unknown"})`));
    });
    const initialized = await this.rpc("initialize", {
      clientInfo: { name: "huiyi-medharness-codex-bridge", title: "Huiyi MedHarness Codex bridge", version: "0.1.0" },
      capabilities: {},
    });
    if (!isRecord(initialized)) throw new Error("Codex app-server returned an invalid initialize response");
    this.notify("initialized", {});
  }

  private async completeExclusive(request: ChatCompletionRequest, signal: AbortSignal | undefined, repairMalformedResponse: boolean, trace: CodexBridgeTraceContext): Promise<{ readonly completion: ParsedCompletion; readonly usage?: TokenUsage }> {
    signal?.throwIfAborted();
    const threadStartAt = Date.now();
    await this.start();
    const developerMessages = request.messages
      .filter((message) => message.role === "system" || message.role === "developer")
      .map((message) => JSON.stringify(message.content ?? ""));
    const toolCatalog = request.tools.map(({ function: fn }) => ({
      name: fn.name,
      description: fn.description ?? "",
      parameters: fn.parameters ?? {},
    }));
    const toolInstructions = toolCatalog.length
      ? `The following are exact DSH host functions. A function call requests execution by the DSH host, not a Codex-native tool. If the user explicitly requests a listed function's operation, call that function instead of saying it is unavailable. Return arguments as a JSON object encoded in the function.arguments string. Available DSH functions: ${JSON.stringify(toolCatalog)}`
      : "No DSH host functions are available in this request.";
    const conversation = request.messages.filter((message) => message.role !== "system" && message.role !== "developer");
    const threadResult = await this.rpc("thread/start", {
      model: MODEL,
      cwd: tmpdir(),
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      developerInstructions: [
        APP_SERVER_INSTRUCTIONS,
        ...developerMessages,
        toolInstructions,
        ...(repairMalformedResponse ? ["The previous completion did not match the required structured response schema. Return exactly one valid response matching the supplied schema. Do not add Markdown, commentary, or extra fields; do not omit required fields. If requesting a DSH host function, encode its arguments as a JSON object string and use only the declared function name."] : []),
      ].join("\n\n"),
    });
    const threadStartMs = Date.now() - threadStartAt;
    writeLocalGatewayTrace({ ...trace, event: "model.thread.started", modelName: MODEL, threadStartMs, status: "completed" });
    const thread = isRecord(threadResult) && isRecord(threadResult.thread) ? threadResult.thread : undefined;
    const threadId = thread && typeof thread.id === "string" ? thread.id : undefined;
    if (!threadId) throw new Error("Codex app-server did not return a thread id");

    const prompt = JSON.stringify({
      dshConversation: conversation,
      dshTools: request.tools,
      dshToolChoice: request.toolChoice,
      maxOutputTokens: request.maxTokens,
      responseContract: request.responseSchema
        ? "Return only an object matching the supplied schema. The content field must be a JSON object matching the requested response schema, and tool_calls must be empty."
        : "Return only an object with a concise content string and tool_calls array. If dshToolChoice is required or names a function, return exactly one matching DSH tool call and no final answer. For auto, use zero calls for a final answer or one declared DSH function call with JSON-object arguments encoded as a string.",
    });
    const schema = structuredCompletionSchema(request.tools.map((tool) => tool.function.name), request.toolChoice, request.responseSchema);
    const result = await new Promise<{ text: string; usage?: TokenUsage }>((resolveTurn, rejectTurn) => {
      let active!: ActiveTurn;
      active = {
        resolve: resolveTurn,
        reject: rejectTurn,
        trace,
        startedAt: Date.now(),
        text: "",
        modelDeltaCount: 0,
        modelOutputChars: 0,
        heartbeat: setInterval(() => {
          const stage = active.firstModelDeltaMs === undefined
            ? active.turnStartAcceptedAt === undefined ? "turn_start_pending" : "waiting_for_first_model_delta"
            : "model_streaming";
          writeLocalGatewayTrace({ ...active.trace, event: "model.turn.heartbeat", modelName: MODEL, elapsedMs: Date.now() - active.startedAt, firstModelDeltaMs: active.firstModelDeltaMs ?? -1, modelDeltaCount: active.modelDeltaCount, modelOutputChars: active.modelOutputChars, stage, turnIdPresent: Boolean(active.turnId), activeTurns: this.turnGate.activeCount, queuedTurns: this.turnGate.queuedCount });
        }, 15_000),
        timer: setTimeout(() => {
          void this.rpc("turn/interrupt", { threadId }).catch(() => undefined);
          this.settleTurn(threadId, active, new Error("Codex app-server model turn timed out"));
        }, TURN_TIMEOUT_MS),
        ...(signal ? { signal } : {}),
      };
      active.heartbeat.unref();
      if (signal) {
        active.abortListener = () => {
          void this.rpc("turn/interrupt", { threadId }).catch(() => undefined);
          this.settleTurn(threadId, active, new Error("Codex app-server model turn was cancelled"));
        };
        signal.addEventListener("abort", active.abortListener, { once: true });
      }
      this.turns.set(threadId, active);
      void this.rpc("turn/start", {
        threadId,
        model: MODEL,
        effort: "low",
        input: [{ type: "text", text: prompt, text_elements: [] }],
        outputSchema: schema,
      }).then((turnResult) => {
        active.turnStartAcceptedAt = Date.now();
        if (isRecord(turnResult) && isRecord(turnResult.turn) && typeof turnResult.turn.id === "string") active.turnId = turnResult.turn.id;
        writeLocalGatewayTrace({ ...trace, event: "model.turn_start.accepted", modelName: MODEL, turnStartMs: active.turnStartAcceptedAt - active.startedAt, turnIdPresent: Boolean(active.turnId), stage: active.firstModelDeltaMs === undefined ? "waiting_for_first_model_delta" : "model_streaming" });
      }).catch((error: unknown) => this.settleTurn(threadId, active, normalizeError(error)));
    });

    let completion: ParsedCompletion;
    try { completion = parseStructuredCompletion(result.text, request.tools.map((tool) => tool.function.name), request.responseSchema !== undefined); }
    catch { throw new CodexAppServerModelResponseError(); }
    return { completion, ...(result.usage ? { usage: result.usage } : {}) };
  }

  private async completeWithBoundedRetry(
    request: ChatCompletionRequest,
    signal: AbortSignal | undefined,
    trace: CodexBridgeTraceContext,
  ): Promise<{ readonly completion: ParsedCompletion; readonly usage?: TokenUsage }> {
    // Each attempt uses an ephemeral thread and replays the same DSH transcript;
    // host-side tools run only after this method returns, so no tool side effect
    // is repeated by the retry.
    let attempt = 1;
    return withBoundedCodexAppServerRetry((repairMalformedResponse) =>
      this.completeExclusive(request, signal, repairMalformedResponse, { ...trace, attempt: attempt++ }), signal, (event, reason) => {
      if (event === "attempt") {
        this.retryCounts.attempts += 1;
        this.retryCounts[reason === "malformed_response" ? "malformedResponse" : "providerTurn"] += 1;
      } else if (event === "succeeded") this.retryCounts.successes += 1;
      else this.retryCounts.failures += 1;
      writeLocalGatewayTrace({ ...trace, event: `model.retry.${event}`, modelName: MODEL, attempt: 2, retryCount: this.retryCounts.attempts, retryReason: reason, status: event });
    });
  }

  private readLines(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try { message = JSON.parse(line) as JsonRpcMessage; }
      catch { continue; }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`Codex app-server rejected ${pending.method} (${message.error.code ?? "unknown"})`));
        else pending.resolve(message.result);
        continue;
      }
      if (typeof message.method !== "string" || !isRecord(message.params)) continue;
      const params = message.params;
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      if (!threadId) continue;
      const active = this.turns.get(threadId);
      if (!active) continue;
      if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
        active.text += params.delta;
        active.modelDeltaCount += 1;
        active.modelOutputChars += params.delta.length;
        if (active.firstModelDeltaMs === undefined) {
          active.firstModelDeltaMs = Date.now() - active.startedAt;
          writeLocalGatewayTrace({ ...active.trace, event: "model.first_delta", modelName: MODEL, firstModelDeltaMs: active.firstModelDeltaMs, modelDeltaCount: active.modelDeltaCount, modelOutputChars: active.modelOutputChars, stage: "model_streaming" });
        }
      }
      else if (message.method === "thread/tokenUsage/updated" && isRecord(params.tokenUsage) && isRecord(params.tokenUsage.last)) {
        const usage = params.tokenUsage.last;
        if (isNonNegativeInteger(usage.inputTokens) && isNonNegativeInteger(usage.outputTokens)) {
          active.usage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: isNonNegativeInteger(usage.totalTokens) ? usage.totalTokens : usage.inputTokens + usage.outputTokens };
        }
      } else if (message.method === "turn/completed") {
        const turn = isRecord(params.turn) ? params.turn : undefined;
        const status = turn && typeof turn.status === "string" ? turn.status : typeof params.status === "string" ? params.status : "unknown";
        if (status === "completed") this.settleTurn(threadId, active);
        else this.settleTurn(threadId, active, new CodexAppServerTurnError(status));
      }
    }
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) return Promise.reject(new Error("Codex app-server is unavailable"));
    const id = ++this.nextRequestId;
    return new Promise((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRpc(new Error(`Codex app-server request timed out (${method})`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { method, resolve: resolveRpc, reject: rejectRpc, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error(`Codex app-server write failed (${method})`));
      });
    });
  }

  private notify(method: string, params: unknown): void {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private settleTurn(threadId: string, turn: ActiveTurn, error?: Error): void {
    if (this.turns.get(threadId) !== turn) return;
    this.turns.delete(threadId);
    clearTimeout(turn.timer);
    clearInterval(turn.heartbeat);
    if (turn.signal && turn.abortListener) turn.signal.removeEventListener("abort", turn.abortListener);
    const cancelled = Boolean(error && turn.signal?.aborted);
    const failure = error && !cancelled ? safeCodexBridgeFailure(error) : undefined;
    writeLocalGatewayTrace({
      ...turn.trace,
      event: "model.turn.terminal",
      modelName: MODEL,
      status: cancelled ? "cancelled" : error ? "failed" : "completed",
      durationMs: Date.now() - turn.startedAt,
      firstModelDeltaMs: turn.firstModelDeltaMs ?? -1,
      modelDeltaCount: turn.modelDeltaCount,
      modelOutputChars: turn.modelOutputChars,
      turnIdPresent: Boolean(turn.turnId),
      ...(error ? { errorCategory: failure?.category ?? "unknown" } : {}),
      ...(failure?.turnStatus ? { turnStatus: failure.turnStatus } : {}),
      ...(failure?.rpcMethod ? { rpcMethod: failure.rpcMethod } : {}),
      ...(failure?.rpcCode !== undefined ? { rpcCode: failure.rpcCode } : {}),
    });
    if (error) turn.reject(error);
    else turn.resolve({ text: turn.text, ...(turn.usage ? { usage: turn.usage } : {}) });
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const [threadId, turn] of this.turns) this.settleTurn(threadId, turn, error);
  }
}

export function structuredCompletionSchema(
  toolNames: readonly string[],
  toolChoice: unknown = "auto",
  contentSchema?: Record<string, unknown>,
): Record<string, unknown> {
  const uniqueNames = [...new Set(toolNames)];
  const requestedName = selectedToolName(toolChoice);
  if (requestedName && !uniqueNames.includes(requestedName)) throw new TypeError("tool_choice names an undeclared DSH function");
  const required = toolChoice === "required" || requestedName !== undefined;
  if (required && uniqueNames.length === 0) throw new TypeError("tool_choice requires a declared DSH function");
  const nameSchema: Record<string, unknown> = uniqueNames.length
    ? { type: "string", enum: requestedName ? [requestedName] : uniqueNames }
    : { type: "string" };
  return {
    type: "object",
    properties: {
      content: contentSchema ?? { type: "string" },
      tool_calls: {
        minItems: required ? 1 : 0,
        type: "array",
        maxItems: uniqueNames.length ? 1 : 0,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { type: "string", enum: ["function"] },
            function: {
              type: "object",
              properties: { name: nameSchema, arguments: { type: "string" } },
              required: ["name", "arguments"],
              additionalProperties: false,
            },
          },
          required: ["id", "type", "function"],
          additionalProperties: false,
        },
      },
    },
    required: ["content", "tool_calls"],
    additionalProperties: false,
  };
}

function selectedToolName(toolChoice: unknown): string | undefined {
  if (!isRecord(toolChoice) || toolChoice.type !== "function" || !isRecord(toolChoice.function)) return undefined;
  return typeof toolChoice.function.name === "string" ? toolChoice.function.name : undefined;
}

export function parseStructuredCompletion(raw: string, allowedTools: readonly string[], jsonObjectContent = false): ParsedCompletion {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new TypeError("Codex app-server returned a non-JSON model result"); }
  if (!isRecord(parsed) || !Array.isArray(parsed.tool_calls) || parsed.tool_calls.length > 1
    || (jsonObjectContent ? !isRecord(parsed.content) : typeof parsed.content !== "string")) {
    throw new TypeError("Codex app-server returned an invalid structured model result");
  }
  const content = jsonObjectContent ? JSON.stringify(parsed.content) : parsed.content as string;
  const toolCalls = parsed.tool_calls.map((value) => {
    if (!isRecord(value) || typeof value.id !== "string" || value.type !== "function" || !isRecord(value.function)
      || typeof value.function.name !== "string" || typeof value.function.arguments !== "string"
      || !allowedTools.includes(value.function.name)) throw new TypeError("Codex app-server returned an undeclared DSH tool call");
    try {
      const args = JSON.parse(value.function.arguments) as unknown;
      if (!isRecord(args)) throw new TypeError("arguments must be an object");
    } catch { throw new TypeError("Codex app-server returned invalid DSH tool arguments"); }
    return {
      id: value.id,
      type: "function" as const,
      function: { name: value.function.name, arguments: value.function.arguments },
    };
  });
  if (!content.trim() && toolCalls.length === 0) throw new TypeError("Codex app-server returned neither text nor a DSH tool call");
  return { content, toolCalls };
}

export async function startCodexAppServerBridge(options: { host?: string; port?: number; apiKey?: string; client?: CodexAppServerClient } = {}): Promise<{ close(): Promise<void>; host: string; port: number }> {
  if (readAppMode() === "production") {
    throw new Error("The local Codex app-server bridge is development-only");
  }
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new TypeError("The Codex app-server bridge must bind to loopback");
  const port = options.port ?? readPort(process.env.HUIYI_CODEX_BRIDGE_PORT, 8333);
  const apiKey = options.apiKey ?? process.env.HUIYI_CODEX_BRIDGE_API_KEY ?? "local-only";
  if (!apiKey || apiKey.length > 512) throw new TypeError("HUIYI_CODEX_BRIDGE_API_KEY must be a non-empty local credential");
  const client = options.client ?? new CodexAppServerClient();
  await client.start();

  const server = createServer((request, response) => { void handleBridgeRequest(request, response, client, apiKey); });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => { server.off("error", rejectListen); resolveListen(); });
  });
  return {
    host,
    port,
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
      await client.dispose();
    },
  };
}

async function handleBridgeRequest(request: IncomingMessage, response: ServerResponse, client: CodexAppServerClient, apiKey: string): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/healthz") {
    writeJson(response, 200, {
      status: "ok", model: MODEL, route: "codex-app-server",
      rpcTimeoutMs: RPC_TIMEOUT_MS,
      ...client.concurrencySnapshot,
      retryCounters: client.retryCounters,
    });
    return;
  }
  if (!authorized(request, apiKey)) { writeJson(response, 401, { error: { message: "Unauthorized", type: "authentication_error" } }); return; }
  if (request.method === "GET" && url.pathname === "/v1/models") {
    writeJson(response, 200, { object: "list", data: [{ id: MODEL, object: "model", owned_by: "local-codex-app-server" }] });
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    writeJson(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
    return;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    writeJson(response, 415, { error: { message: "Content-Type must be application/json", type: "invalid_request_error" } });
    return;
  }
  const requestId = traceHeader(request.headers["x-huiyi-request-id"]) ?? randomUUID();
  const runId = traceHeader(request.headers["x-huiyi-run-id"]);
  const edgeTraceId = traceHeader(request.headers["x-huiyi-trace-id"]);
  const modelRequestId = randomUUID();
  const trace: CodexBridgeTraceContext = { requestId, modelRequestId, ...(runId ? { runId } : {}), ...(edgeTraceId ? { edgeTraceId } : {}) };
  const controller = new AbortController();
  response.on("close", () => { if (!response.writableEnded) controller.abort(); });
  try {
    const requestValue = await readJson(request);
    const decoded = decodeChatCompletionRequest(requestValue);
    writeLocalGatewayTrace({ ...trace, event: "bridge.request.accepted", modelName: MODEL, messageCount: decoded.messages.length, toolCount: decoded.tools.length, status: "accepted" });
    const result = await client.complete(decoded, controller.signal, trace);
    if (controller.signal.aborted) return;
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const finishReason = result.completion.toolCalls.length ? "tool_calls" : "stop";
    const usage = result.usage ? {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.totalTokens,
    } : undefined;
    writeLocalGatewayTrace({ ...trace, event: "bridge.response.ready", modelName: MODEL, status: "completed", outputChars: result.completion.content.length, toolCount: result.completion.toolCalls.length, usagePresent: Boolean(result.usage), stage: "response_ready" });
    if (!decoded.stream) {
      writeJson(response, 200, {
        id, object: "chat.completion", created, model: MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: result.completion.content || null, ...(result.completion.toolCalls.length ? { tool_calls: result.completion.toolCalls } : {}) }, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      });
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    writeSse(response, { id, object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    if (result.completion.content) writeSse(response, { id, object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta: { content: result.completion.content }, finish_reason: null }] });
    if (result.completion.toolCalls.length) {
      const toolCall = result.completion.toolCalls[0]!;
      writeSse(response, { id, object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }] });
    }
    writeSse(response, { id, object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
    if (decoded.includeUsage && usage) writeSse(response, { id, object: "chat.completion.chunk", created, model: MODEL, choices: [], usage });
    response.end("data: [DONE]\n\n");
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) {
      writeLocalGatewayTrace({ ...trace, event: "bridge.request.cancelled", modelName: MODEL, status: "cancelled" });
      return;
    }
    const status = error instanceof RangeError ? 413 : error instanceof TypeError && !(error instanceof CodexAppServerModelResponseError) ? 400 : 502;
    let safeFailure: SafeCodexBridgeFailure | undefined;
    if (status === 502) {
      safeFailure = safeCodexBridgeFailure(error);
      process.stderr.write(`${JSON.stringify({ event: "codex_bridge.model_request_failed", ...safeFailure })}\n`);
    }
    writeLocalGatewayTrace({ ...trace, event: "bridge.request.failed", modelName: MODEL, status: "failed", httpStatus: status, ...(safeFailure ? { errorCategory: safeFailure.category, ...(safeFailure.rpcMethod ? { rpcMethod: safeFailure.rpcMethod } : {}), ...(safeFailure.rpcCode !== undefined ? { rpcCode: safeFailure.rpcCode } : {}), ...(safeFailure.systemErrorCode ? { systemErrorCode: safeFailure.systemErrorCode } : {}), ...(safeFailure.turnStatus ? { turnStatus: safeFailure.turnStatus } : {}) } : {}) });
    const message = status === 502 ? "Codex app-server model request failed" : error instanceof Error ? error.message : "Invalid model request";
    writeJson(response, status, safeFailure
      ? safeCodexBridgeErrorBody(safeFailure)
      : { error: { message, type: "invalid_request_error" } });
  }
}

function traceHeader(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value.length === 1 ? value[0] : undefined : value;
  return candidate && /^[A-Za-z0-9_-]{8,80}$/.test(candidate) ? candidate : undefined;
}

function decodeChatCompletionRequest(value: unknown): ChatCompletionRequest {
  if (!isRecord(value) || value.model !== MODEL || !Array.isArray(value.messages) || value.messages.length > 100) {
    throw new TypeError("A gpt-6-luna model and at most 100 chat messages are required");
  }
  if (value.messages.some((message) => !isRecord(message) || !["system", "developer", "user", "assistant", "tool"].includes(String(message.role)))) {
    throw new TypeError("Chat messages contain an unsupported role or shape");
  }
  const rawTools = value.tools === undefined ? [] : value.tools;
  if (!Array.isArray(rawTools) || rawTools.length > 32 || rawTools.some((tool) => !isRecord(tool) || tool.type !== "function" || !isRecord(tool.function) || typeof tool.function.name !== "string")) {
    throw new TypeError("Only up to 32 DSH function tools are supported");
  }
  const names = rawTools.map((tool) => (tool as ChatTool).function.name);
  if (new Set(names).size !== names.length || names.some((name) => name.length > 64)) throw new TypeError("DSH function names must be unique and at most 64 characters");
  const responseSchema = decodeJsonSchemaResponseFormat(value.response_format);
  const toolChoice = value.tool_choice ?? "auto";
  if (responseSchema && (rawTools.length > 0 || (value.tool_choice !== undefined && toolChoice !== "auto"))) {
    throw new TypeError("JSON schema response format cannot be combined with DSH tools");
  }
  const maxTokens = value.max_tokens === undefined ? 768 : value.max_tokens;
  if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw new TypeError("max_tokens must be between 1 and 4096");
  if (value.stream !== undefined && typeof value.stream !== "boolean") throw new TypeError("stream must be a boolean");
  const streamOptions = isRecord(value.stream_options) ? value.stream_options : undefined;
  return {
    model: MODEL,
    messages: value.messages as readonly Record<string, unknown>[],
    tools: rawTools as readonly ChatTool[],
    toolChoice,
    ...(responseSchema ? { responseSchema } : {}),
    maxTokens,
    stream: value.stream === true,
    includeUsage: streamOptions?.include_usage === true,
  };
}

export function decodeJsonSchemaResponseFormat(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.type !== "json_schema" || !isRecord(value.json_schema)) {
    throw new TypeError("Only strict JSON schema response_format is supported");
  }
  const format = value.json_schema;
  const schema = format.schema;
  if (typeof format.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(format.name)
    || format.strict !== true || !isRecord(schema) || schema.type !== "object"
    || schema.additionalProperties !== false || !isRecord(schema.properties) || !Array.isArray(schema.required)
    || schema.required.some((key) => typeof key !== "string" || !(key in schema.properties!))) {
    throw new TypeError("JSON schema response_format must use a strict object schema");
  }
  return schema;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RangeError("Request body too large");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new TypeError("Request body must be valid JSON"); }
}

function authorized(request: IncomingMessage, expectedKey: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(expectedKey);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) { response.end(); return; }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function writeSse(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Codex app-server request failed");
}

function readPort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError("HUIYI_CODEX_BRIDGE_PORT must be a valid TCP port");
  return port;
}

function readTurnConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 2;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4) {
    throw new TypeError("HUIYI_CODEX_BRIDGE_MAX_CONCURRENT_TURNS must be an integer from 1 to 4");
  }
  return limit;
}

async function main(): Promise<void> {
  const bridge = await startCodexAppServerBridge();
  writeLocalGatewayTrace({ event: "bridge.server.ready", route: "codex-app-server", modelName: MODEL, activeTurns: 0, maxConcurrentTurns: readTurnConcurrency(process.env.HUIYI_CODEX_BRIDGE_MAX_CONCURRENT_TURNS) });
  process.stdout.write(`${JSON.stringify({ status: "listening", host: bridge.host, port: bridge.port, model: MODEL })}\n`);
  const close = (): void => { void bridge.close().catch(() => undefined); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ status: "failed", diagnostic: safeCodexBridgeFailure(error) })}\n`);
    process.exitCode = 1;
  });
}
