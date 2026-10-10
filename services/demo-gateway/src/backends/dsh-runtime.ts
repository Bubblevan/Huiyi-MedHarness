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
import type { MemorySnapshot } from "../../../../src/memory/contracts.js";
import { MetadataMemoryTrace } from "../../../../src/memory/trace.js";
import { RagClient } from "../../../../src/rag/client.js";
import type { PatientContext } from "../contracts.js";
import { createHash } from "node:crypto";

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
}

export interface DshDemoRuntimePort {
  createAgent(sessionId: string, patient: PatientContext): Promise<{ readonly agent: DshDemoAgent; dispose(): Promise<void> }>;
  createUserMessage(text: string): ReturnType<typeof createUserMessage>;
  observe(agent: DshDemoAgent, observer: DshDemoObserver): () => void;
  dispose(): Promise<void>;
}

interface ModelConfiguration {
  readonly providerName: string;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly displayName: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/** In-process composition of the pinned DSH runtime and Huiyi capabilities. */
export class DshWebRuntime implements DshDemoRuntimePort {
  private ctx?: Context;
  private startPromise?: Promise<void>;
  private readonly patientsByAgentId = new Map<string, PatientContext>();
  private readonly model = readModelConfiguration();

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
          text: "This is a local demonstration with a synthetic patient. Treat the supplied patient snapshot as fictional contextual history and keep it separate from external medical evidence. Use the local search_medical_evidence tool when medical evidence would materially help; do not claim retrieval or citations unless that tool returns sources. consult_clinical_team is bounded decision support when a complex case benefits from distinct perspectives. You own the final user-facing answer. Be clear about uncertainty and encourage clinician review; this demo is not a diagnosis or a substitute for care.",
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
    const pendingTools = new Map<string, string>();
    const disposeSession = dshAgent.ctx.on("session/event", (session, event: SessionEvent) => {
      if (session.id !== dshAgent.id) return;
      if (event.type === "turn/end") observer.turnEnded(event.data.reason);
      else if (event.type === "tool/call") {
        pendingTools.set(event.data.callId, event.data.name);
        observer.toolStarted({ name: event.data.name, callId: event.data.callId });
      } else if (event.type === "tool/result") {
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
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = undefined;
      this.patientsByAgentId.clear();
      await ctx.fiber.dispose();
    }
  }

  private async start(): Promise<void> {
    if (this.ctx) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startContext();
    try { await this.startPromise; }
    catch (error) { this.startPromise = undefined; throw error; }
  }

  private async startContext(): Promise<void> {
    const syntheticAmaMemory = process.env.HUIYI_DEMO_SYNTHETIC_AMA_MEMORY?.trim() === "1";
    const production = process.env.HUIYI_APP_ENV?.trim().toLowerCase() === "production" || process.env.NODE_ENV === "production";
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
          api: "openai-completions",
          baseURL: this.model.baseUrl,
          apiKeyEnv: this.model.apiKeyEnv,
          models: [{ id: this.model.modelId, name: this.model.modelId, contextWindow: this.model.contextWindow }],
        },
      },
    });
    ctx.on("agent/request", async (_request, next) => ({ ...(await next()), temperature: 0 }));

    applyWithIdentity(
      ctx,
      (agent) => {
        if (!syntheticAmaMemory) return undefined;
        const patient = this.patientsByAgentId.get(agent.id);
        return patient ? syntheticPatientMemoryId(patient.patientId) : undefined;
      },
      new RagClient(),
      {
        memory: { readOnly: !syntheticAmaMemory },
        memoryClient: new MemoryClient(),
        memoryTrace: syntheticAmaMemory ? new MetadataMemoryTrace() : { record: () => undefined },
        collaborationTrace: { record: () => undefined },
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
}

function syntheticPatientMemoryId(patientId: string): string {
  const digest = createHash("sha256").update(`huiyi-demo-synthetic\0${patientId}`).digest("hex");
  return `synthetic-demo:${digest}`;
}

export function readModelConfiguration(env: NodeJS.ProcessEnv = process.env): ModelConfiguration {
  const modelBackend = env.HUIYI_DEMO_MODEL_BACKEND?.trim() || "vllm";
  if (modelBackend !== "vllm" && modelBackend !== "deepseek-api") {
    throw new TypeError("HUIYI_DEMO_MODEL_BACKEND must be vllm or deepseek-api");
  }
  const isDeepSeek = modelBackend === "deepseek-api";
  const providerName = env.HUIYI_DEMO_PROVIDER?.trim() || (isDeepSeek ? "huiyi-demo-deepseek-api" : "huiyi-demo-local-qwen");
  const modelId = isDeepSeek
    ? env.HUIYI_DEMO_DEEPSEEK_MODEL?.trim() || "deepseek-flash"
    : env.HUIYI_DEMO_MODEL?.trim() || "Qwen/Qwen3-8B";
  const apiKeyEnv = isDeepSeek ? "DEEPSEEK_API_KEY" : "HUIYI_LOCAL_QWEN_API_KEY";
  const displayName = isDeepSeek ? "Huiyi Demo DeepSeek API" : "Huiyi Demo Local Qwen";

  let baseUrl: string;
  if (isDeepSeek) {
    if (!env.DEEPSEEK_API_KEY?.trim()) {
      throw new Error("DEEPSEEK_API_KEY is required when HUIYI_DEMO_MODEL_BACKEND=deepseek-api");
    }
    if (env.HUIYI_DEMO_MODEL_BASE_URL?.trim()) {
      throw new TypeError("HUIYI_DEMO_MODEL_BASE_URL cannot be overridden in DeepSeek API mode");
    }
    baseUrl = "https://api.deepseek.com";
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

function renderSyntheticPatientSnapshot(patient: PatientContext): string {
  const conditions = patient.conditions.length ? patient.conditions.join("、") : "未提供";
  const medications = patient.medications.length ? patient.medications.join("、") : "未提供";
  const allergies = patient.allergies.length ? patient.allergies.join("、") : "未提供";
  return [
    "Synthetic Patient Memory Snapshot (fictional demo context; not AMA memory)",
    `Patient: ${patient.displayName}; age ${patient.age}; sex ${patient.sex}.`,
    `Conditions: ${conditions}.`,
    `Medications: ${medications}.`,
    `Allergies: ${allergies}.`,
    `Longitudinal note: ${patient.memory.summary}`,
  ].join("\n");
}

function toSyntheticMemorySnapshot(patient: PatientContext, sessionId: string, turn: number): MemorySnapshot {
  return {
    snapshotId: `demo-fixture:${patient.patientId}:${turn}`,
    userId: `demo-fixture:${patient.patientId}`,
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
