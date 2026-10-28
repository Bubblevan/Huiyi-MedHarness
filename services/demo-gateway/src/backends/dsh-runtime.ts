import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry, type Agent, type AgentHandle } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmRuntime, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore, type SessionEvent, type TurnEndReason } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import * as Spawn from "@deepseek-ai/dsh-subagent-spawn-in-process";
import { applyWithIdentity } from "../../../../src/index.js";
import { MemoryClient } from "../../../../src/memory/client.js";
import type { MemoryLifecycle } from "../../../../src/memory/lifecycle.js";
import type { MemoryItem, MemoryRecallEvidenceRecord, MemorySnapshot } from "../../../../src/memory/contracts.js";
import { MetadataMemoryTrace } from "../../../../src/memory/trace.js";
import type { MemoryTraceSink } from "../../../../src/memory/trace.js";
import type { CollaborationTraceSink } from "../../../../src/collaboration/trace.js";
import type { MedicalEvidenceClientPort } from "../../../../src/rag/contracts.js";
import { RagClient } from "../../../../src/rag/client.js";
import type { PatientContext } from "../contracts.js";
import { createHash } from "node:crypto";
import { readAppMode } from "../app-mode.js";

export interface DshDemoAgent {
  readonly id: string;
  followup(message: ReturnType<typeof createUserMessage>): void;
  cancel(cause: { readonly kind: "user" }): void;
  whenIdle(): Promise<void>;
}

export interface DshToolResultObservation {
  readonly tool: string;
  readonly callId: string;
  readonly failed: boolean;
  readonly content: unknown;
}

export interface DshTurnObservation {
  readonly reason: TurnEndReason;
  readonly toolResults: readonly DshToolResultObservation[];
}

export interface DshDemoObserver {
  readonly textDelta: (text: string) => void;
  readonly toolStarted: (input: { readonly name: string; readonly callId: string }) => void;
  readonly toolCompleted: (input: DshToolResultObservation) => void;
  readonly turnEnded: (reason: TurnEndReason) => void;
  readonly usage?: (usage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens?: number }, scope: "root" | "subagent", sessionId: string) => void;
}

export interface DshDemoRuntimePort {
  createAgent(sessionId: string, patient: PatientContext): Promise<{ readonly agent: DshDemoAgent; dispose(): Promise<void> }>;
  createUserMessage(text: string): ReturnType<typeof createUserMessage>;
  observe(agent: DshDemoAgent, observer: DshDemoObserver): () => void;
  flushMemory?(): Promise<void>;
  dispose(): Promise<void>;
}

export interface DshCapabilities {
  readonly memory: boolean;
  readonly rag: boolean;
  readonly collaboration: boolean;
}

export interface DshWebRuntimeOptions {
  readonly capabilities?: Partial<DshCapabilities>;
  readonly syntheticAmaMemory?: boolean;
  readonly collaborationTrace?: CollaborationTraceSink;
  readonly memoryTrace?: MemoryTraceSink;
  /** Evaluation-only: match recalled item content to a known synthetic fact catalog in process. */
  readonly matchSyntheticRecallFactIds?: (patient: PatientContext, item: MemoryItem) => readonly string[];
  /** Receives allowlisted recall metadata only; never receives recalled content. */
  readonly onMemoryRecallEvidence?: (record: MemoryRecallEvidenceRecord) => void;
  readonly evidenceClient?: MedicalEvidenceClientPort;
}

interface ModelConfiguration {
  readonly providerName: string;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly api: "openai-completions";
  readonly displayName: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/** In-process composition of the pinned DSH runtime and Huiyi capabilities. */
export class DshWebRuntime implements DshDemoRuntimePort {
  private ctx?: Context;
  private startPromise?: Promise<void>;
  private memoryLifecycle?: MemoryLifecycle;
  private readonly patientsByAgentId = new Map<string, PatientContext>();
  private readonly model = readModelConfiguration();
  private readonly capabilities: DshCapabilities;
  private readonly syntheticAmaMemory: boolean;
  private readonly collaborationTrace: CollaborationTraceSink;
  private readonly memoryTrace?: MemoryTraceSink;
  private readonly matchSyntheticRecallFactIds?: DshWebRuntimeOptions["matchSyntheticRecallFactIds"];
  private readonly onMemoryRecallEvidence?: DshWebRuntimeOptions["onMemoryRecallEvidence"];
  private readonly evidenceClient?: MedicalEvidenceClientPort;

  constructor(options: DshWebRuntimeOptions = {}) {
    this.capabilities = {
      memory: options.capabilities?.memory ?? true,
      rag: options.capabilities?.rag ?? true,
      collaboration: options.capabilities?.collaboration ?? true,
    };
    this.syntheticAmaMemory = options.syntheticAmaMemory ?? (readAppMode() === "clinical-evaluation" || process.env.HUIYI_DEMO_SYNTHETIC_AMA_MEMORY?.trim() === "1");
    this.collaborationTrace = options.collaborationTrace ?? { record: () => undefined };
    this.memoryTrace = options.memoryTrace;
    this.matchSyntheticRecallFactIds = options.matchSyntheticRecallFactIds;
    this.onMemoryRecallEvidence = options.onMemoryRecallEvidence;
    this.evidenceClient = options.evidenceClient;
    if (this.syntheticAmaMemory && !this.capabilities.memory) throw new TypeError("Synthetic AMA memory requires the memory capability");
  }

  async createAgent(sessionId: string, patient: PatientContext): Promise<{ readonly agent: DshDemoAgent; dispose(): Promise<void> }> {
    await this.start();
    const ctx = this.ctx;
    if (!ctx) throw new Error("DSH runtime has been disposed");
    const handle: AgentHandle = await ctx.agents.create({
      sessionId: SessionId(sessionId),
      agentOptions: { provider: this.model.providerName, model: this.model.modelId, maxTokens: this.model.maxTokens },
      setup: (agentCtx) => {
        agentCtx.systemPrompt.section({
          name: "huiyi-demo-synthetic-patient-memory",
          order: 230,
          text: renderSyntheticPatientSnapshot(patient),
        });
        agentCtx.systemPrompt.section({
          name: "huiyi-demo-clinical-response-policy",
          order: 270,
          text: this.renderResponsePolicy(),
        });
      },
    });
    this.patientsByAgentId.set(handle.agent.id, patient);
    let disposed = false;
    return {
      agent: handle.agent,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await this.memoryLifecycle?.endSession(handle.agent.id);
        this.patientsByAgentId.delete(handle.agent.id);
        await handle.dispose();
      },
    };
  }

  createUserMessage(text: string): ReturnType<typeof createUserMessage> {
    return createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] });
  }

  observe(agent: DshDemoAgent, observer: DshDemoObserver): () => void {
    const dshAgent = agent as Agent;
    const runtimeCtx = this.ctx;
    if (!runtimeCtx) throw new Error("DSH runtime has not been started");
    const pendingTools = new Map<string, string>();
    // Observe on the shared runtime context so usage events from direct child
    // sessions bubble to the root run observer. The assistant-stream listener
    // below stays agent-scoped, so child prose is never sent to the UI.
    const disposeSession = runtimeCtx.on("session/event", (session, event: SessionEvent) => {
      const isRoot = session.id === dshAgent.id;
      const isChild = session.header?.origin === "subagent" && session.header.parentSession === dshAgent.id;
      if (!isRoot && !isChild) return;
      if (event.type === "assistant/message" && event.data.usage) observer.usage?.(event.data.usage, isRoot ? "root" : "subagent", session.id);
      else if (isRoot && event.type === "turn/end") observer.turnEnded(event.data.reason);
      else if (isRoot && event.type === "tool/call") {
        pendingTools.set(event.data.callId, event.data.name);
        observer.toolStarted({ name: event.data.name, callId: event.data.callId });
      } else if (isRoot && event.type === "tool/result") {
        const name = pendingTools.get(event.data.message.toolCallId);
        if (!name) return;
        pendingTools.delete(event.data.message.toolCallId);
        observer.toolCompleted({
          tool: name,
          callId: event.data.message.toolCallId,
          failed: event.data.message.isError === true,
          content: event.data.message.content,
        });
      }
    });
    const disposeStream = dshAgent.ctx.on("agent/assistant-stream", (payload) => {
      if (payload.agent.id !== dshAgent.id || payload.frame.type !== "chunk") return;
      const chunk = payload.frame.chunk;
      if (chunk.type === "text-delta") observer.textDelta(chunk.text);
    });
    return () => {
      disposeSession();
      disposeStream();
    };
  }

  async dispose(): Promise<void> {
    await this.flushMemory();
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = undefined;
      this.patientsByAgentId.clear();
      await ctx.fiber.dispose();
    }
  }

  async flushMemory(): Promise<void> {
    await this.memoryLifecycle?.flush();
  }

  private async start(): Promise<void> {
    if (this.ctx) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startContext();
    try { await this.startPromise; }
    catch (error) { this.startPromise = undefined; throw error; }
  }

  private async startContext(): Promise<void> {
    const syntheticAmaMemory = this.syntheticAmaMemory;
    const production = readAppMode() === "production";
    if (syntheticAmaMemory && production) {
      throw new Error("Synthetic AMA memory is disabled in production");
    }

    const ctx = new Context();
    new TypertRegistry(ctx);
    new SessionStore(ctx);
    new SessionProjectionRegistry(ctx);
    new AgentRegistry(ctx);
    new LlmRuntime(ctx);
    new SystemPrompt(ctx, { includeHarnessIdentity: false });
    new ToolRuntime(ctx, { mode: "native", maxParallelSubCalls: 1 });
    new AgentLoop(ctx, AgentLoop.Config({ agents: [], maxParallelToolCalls: 1 }));
    new SubagentRuntime(ctx, SubagentRuntime.Config({ maxDepth: 1, maxActiveSubagents: 8 }));

    const spawnPlugin = Object.assign(Spawn.apply, { inject: Spawn.inject, Config: Spawn.Config });
    await ctx.plugin(spawnPlugin, { providerName: "spawn" });
    const piAiPlugin = Object.assign(PiAi.apply, { inject: PiAi.inject, Config: PiAi.Config });
    await ctx.plugin(piAiPlugin, {
      providers: {
        [this.model.providerName]: {
          displayName: this.model.displayName,
          api: this.model.api,
          baseURL: this.model.baseUrl,
          apiKeyEnv: this.model.apiKeyEnv,
          models: [{ id: this.model.modelId, name: this.model.modelId, contextWindow: this.model.contextWindow }],
        },
      },
    });
    ctx.on("agent/request", async (_request, next) => ({ ...(await next()), temperature: 0 }));

    this.memoryLifecycle = applyWithIdentity(
      ctx,
      (agent) => {
        if (!syntheticAmaMemory) return undefined;
        const patient = this.patientsByAgentId.get(agent.id);
        return patient ? syntheticPatientMemoryId(patient.patientId, patient.tenantId) : undefined;
      },
      this.evidenceClient ?? new RagClient(),
      {
        memory: {
          readOnly: !syntheticAmaMemory,
          automaticRecallFirstTurnOnly: syntheticAmaMemory && readAppMode() === "clinical-evaluation",
          commitBatchTurns: syntheticAmaMemory && readAppMode() === "clinical-evaluation" ? readMemoryCommitBatchTurns() : 1,
          ...(syntheticAmaMemory && this.onMemoryRecallEvidence ? {
            matchRecallFactIds: (snapshot: MemorySnapshot) => {
              const patient = this.patientsByAgentId.get(snapshot.sessionId);
              if (!patient || !this.matchSyntheticRecallFactIds) return new Map<number, readonly string[]>();
              return new Map(snapshot.items.map((item, index) => [index, this.matchSyntheticRecallFactIds!(patient, item)] as const));
            },
            onRecallEvidence: (record: MemoryRecallEvidenceRecord) => this.onMemoryRecallEvidence!(record),
          } : {}),
        },
        memoryClient: new MemoryClient(),
        memoryTrace: syntheticAmaMemory ? this.memoryTrace ?? new MetadataMemoryTrace() : { record: () => undefined },
        collaborationTrace: this.collaborationTrace,
        capabilities: this.capabilities,
        ...(!syntheticAmaMemory ? {
          collaborationCaseContext: ({ agentId, turn }: { readonly agentId: string; readonly turn: number }) => {
            const patient = this.patientsByAgentId.get(agentId);
            return patient ? { patientMemory: toSyntheticMemorySnapshot(patient, agentId, turn) } : undefined;
          },
        } : {}),
      },
    );
    this.ctx = ctx;
  }

  private renderResponsePolicy(): string {
    const instructions = [
      "This is an isolated synthetic clinical-workflow evaluation. All supplied case material is fictional and must not be treated as verified medical history.",
      this.capabilities.memory ? "Use patient-scoped memory only for information actually disclosed in prior turns; preserve source and uncertainty. Treat an explicit current-turn statement as what the patient reports now, not as independently verified fact; do not mark it unknown after disclosure or attribute it to a prior encounter unless that source contains it." : "Do not assume access to longitudinal memory beyond this active conversation.",
      this.capabilities.rag ? "When the user asks for local evidence, asks whether evidence supports a medical claim, or asks to search, find, cite, or check literature, guidelines, or references, treat it as a retrieval request and call search_medical_evidence before answering. For each medical statement you attribute to retrieved evidence, append a clickable Markdown citation using the exact visible token and returned ID in this form: `[evidence:<evidenceId>](#evidence:<evidenceId>)`. After a successful search that returned one or more hits, always end with a short `检索来源` line listing the exact clickable token for every returned hit, even when a hit is irrelevant or does not support the claim; label those hits `未作为支持依据` and do not present them as support. Never invent, abbreviate, or reuse an ID that was not returned; if no source was returned, say that no source was found. These IDs identify retrieved sources but do not by themselves establish that a source supports a claim." : "No external evidence retrieval tool is available in this comparison arm; state when evidence has not been checked.",
      this.capabilities.collaboration ? "For medically complex, multi-problem, conflicting, or newly high-risk cases, call consult_clinical_team once before answering; it is bounded support and you own the final response." : "Do not claim specialist collaboration or multi-agent review.",
      "Separate known information from missing or conflicting details, avoid unsupported inferences, and make drafts subject to clinician review. This evaluation is not clinical advice.",
    ];
    return instructions.join(" ");
  }
}

function readMemoryCommitBatchTurns(): number {
  const raw = process.env.HUIYI_MEMORY_COMMIT_BATCH_TURNS;
  if (raw === undefined || raw.trim() === "") return 1;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 8) {
    throw new TypeError("HUIYI_MEMORY_COMMIT_BATCH_TURNS must be an integer between 1 and 8");
  }
  return value;
}

export function syntheticPatientMemoryId(patientId: string, tenantId = "local-demo"): string {
  const digest = createHash("sha256").update(`huiyi-synthetic\0${tenantId}\0${patientId}`).digest("hex");
  return `synthetic-demo:${digest}`;
}

export function readModelConfiguration(env: NodeJS.ProcessEnv = process.env): ModelConfiguration {
  const modelBackend = env.HUIYI_DEMO_MODEL_BACKEND?.trim() || "vllm";
  if (modelBackend !== "vllm" && modelBackend !== "deepseek-api" && modelBackend !== "codex-app-server") {
    throw new TypeError("HUIYI_DEMO_MODEL_BACKEND must be vllm, deepseek-api, or codex-app-server");
  }
  const isDeepSeek = modelBackend === "deepseek-api";
  const isCodex = modelBackend === "codex-app-server";
  const providerName = env.HUIYI_DEMO_PROVIDER?.trim() || (isDeepSeek ? "huiyi-demo-deepseek-api" : isCodex ? "huiyi-demo-local-codex" : "huiyi-demo-local-qwen");
  const modelId = isDeepSeek
    ? env.HUIYI_DEMO_DEEPSEEK_MODEL?.trim() || "deepseek-flash"
    : isCodex ? env.HUIYI_DEMO_CODEX_MODEL?.trim() || "gpt-6-luna" : env.HUIYI_DEMO_MODEL?.trim() || "Qwen/Qwen3-8B";
  const apiKeyEnv = isDeepSeek ? "DEEPSEEK_API_KEY" : isCodex ? "HUIYI_CODEX_BRIDGE_API_KEY" : "HUIYI_LOCAL_QWEN_API_KEY";
  const displayName = isDeepSeek ? "Huiyi Demo DeepSeek API" : isCodex ? "Huiyi Local Codex App Server" : "Huiyi Demo Local Qwen";

  let baseUrl: string;
  if (isDeepSeek) {
    if (!env.DEEPSEEK_API_KEY?.trim()) {
      throw new Error("DEEPSEEK_API_KEY is required when HUIYI_DEMO_MODEL_BACKEND=deepseek-api");
    }
    if (env.HUIYI_DEMO_MODEL_BASE_URL?.trim()) {
      throw new TypeError("HUIYI_DEMO_MODEL_BASE_URL cannot be overridden in DeepSeek API mode");
    }
    baseUrl = "https://api.deepseek.com";
  } else if (isCodex) {
    if (modelId !== "gpt-6-luna") throw new TypeError("The local Codex app-server bridge only allows gpt-6-luna");
    const configuredBridge = env.HUIYI_CODEX_BRIDGE_URL?.trim() || "http://127.0.0.1:8333/v1";
    const parsedUrl = new URL(configuredBridge);
    if (parsedUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsedUrl.hostname)
      || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || !parsedUrl.pathname.replace(/\/$/, "").endsWith("/v1")) {
      throw new TypeError("The Codex app-server bridge URL must be a loopback HTTP /v1 URL");
    }
    if (!env.HUIYI_CODEX_BRIDGE_API_KEY) env.HUIYI_CODEX_BRIDGE_API_KEY = "local-only";
    baseUrl = parsedUrl.toString().replace(/\/$/, "");
  } else {
    const configuredBaseUrl = env.HUIYI_DEMO_MODEL_BASE_URL?.trim() || "http://127.0.0.1:8000/v1";
    const parsedUrl = new URL(configuredBaseUrl);
    if (parsedUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsedUrl.hostname)
      || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
      throw new TypeError("The local demo model endpoint must be a loopback HTTP URL");
    }
    baseUrl = parsedUrl.toString().replace(/\/$/, "");
    if (!env.HUIYI_LOCAL_QWEN_API_KEY) env.HUIYI_LOCAL_QWEN_API_KEY = "local-only";
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(providerName) || !modelId || modelId.length > 160) {
    throw new TypeError("The demo model route is invalid");
  }
  return {
    providerName,
    modelId,
    baseUrl,
    apiKeyEnv,
    api: "openai-completions",
    displayName,
    contextWindow: positiveInteger(env.HUIYI_DEMO_CONTEXT_WINDOW, 40960, 32768),
    maxTokens: positiveInteger(env.HUIYI_DEMO_MAX_TOKENS, 768, 4096),
  };
}

function positiveInteger(raw: string | undefined, fallback: number, maximum: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

export function renderSyntheticPatientSnapshot(patient: PatientContext): string {
  const conditions = patient.conditions.length ? patient.conditions.join("、") : "未提供";
  const medications = patient.medications.length ? patient.medications.join("、") : "未提供";
  const allergies = patient.allergies.length ? patient.allergies.join("、") : "未提供";
  return [
    "Synthetic Patient Memory Snapshot (fictional demo context; not AMA memory)",
    `Patient: ${patient.displayName}; age ${patient.age}; sex ${patient.sex}.`,
    `Conditions: ${conditions}.`,
    `Medications: ${medications}.`,
    `Allergies: ${allergies}.`,
    ...(patient.encounterHistory ?? []).map((item, index) =>
      `Prior encounter ${index + 1} (${item.encounterId}; ${item.label}; ${item.status}): ${item.summary}`),
    `Longitudinal note: ${patient.memory.summary}`,
  ].join("\n");
}

function toSyntheticMemorySnapshot(patient: PatientContext, sessionId: string, turn: number): MemorySnapshot {
  const memoryNamespace = syntheticPatientMemoryId(patient.patientId, patient.tenantId);
  return {
    snapshotId: `${memoryNamespace}:${turn}`,
    userId: memoryNamespace,
    sessionId,
    turn,
    items: [
      { kind: "fact", source: "synthetic-demo-fixture", content: `Synthetic patient profile: ${patient.displayName}, age ${patient.age}, sex ${patient.sex}.` },
      { kind: "fact", source: "synthetic-demo-fixture", content: `Synthetic conditions: ${patient.conditions.join("; ") || "not supplied"}.` },
      { kind: "fact", source: "synthetic-demo-fixture", content: `Synthetic medications: ${patient.medications.join("; ") || "not supplied"}.` },
      { kind: "fact", source: "synthetic-demo-fixture", content: `Synthetic allergies: ${patient.allergies.join("; ") || "not supplied"}.` },
      { kind: "episode", source: "synthetic-demo-fixture", content: patient.memory.summary },
    ],
  };
}
