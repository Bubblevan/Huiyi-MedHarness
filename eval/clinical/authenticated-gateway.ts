import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createDemoServer } from "../../services/demo-gateway/src/server.js";
import { DshDemoBackend, dshAgentSessionId } from "../../services/demo-gateway/src/backends/dsh.js";
import { DshWebRuntime, type DshCapabilities } from "../../services/demo-gateway/src/backends/dsh-runtime.js";
import { ClinicalEvaluationAuth, type EvaluationAccountInput } from "../../services/demo-gateway/src/clinical-evaluation/auth.js";
import {
  SyntheticEvaluationDataset,
  type PatientAccessScope,
  type SyntheticEncounter,
  type SyntheticPatientRecord,
} from "../../services/demo-gateway/src/clinical-evaluation/dataset.js";
import { parseDemoEvent, type DemoEvent } from "../../services/demo-gateway/src/contracts.js";
import { MetadataMemoryTrace } from "../../src/memory/trace.js";
import type { MemoryTraceRecord } from "../../src/memory/contracts.js";
import type { CollaborationTraceSink } from "../../src/collaboration/trace.js";
import type { MedicalEvidenceClientPort } from "../../src/rag/contracts.js";
import type { ClinicalRunRecord, EvalArm, SyntheticClinicalCase } from "./contracts.js";

const EVALUATION_ORIGIN = "http://127.0.0.1:5173";

export interface SyntheticEvaluationIdentity extends PatientAccessScope {
  readonly patientId: string;
}

function caseOrdinal(item: SyntheticClinicalCase): number {
  const match = item.caseId.match(/(\d+)$/);
  if (!match) throw new TypeError(`synthetic case ID has no numeric assignment suffix: ${item.caseId}`);
  const ordinal = Number(match[1]);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new TypeError(`invalid synthetic case assignment: ${item.caseId}`);
  return ordinal;
}

export function syntheticEvaluationIdentity(item: SyntheticClinicalCase, tenantPrefix: string): SyntheticEvaluationIdentity {
  const ordinal = caseOrdinal(item);
  const tenantNumber = ordinal % 2 === 1 ? 1 : 2;
  const cohort = Math.floor((ordinal - 1) / 2) % 2 === 0 ? "a" : "b";
  const patientNumber = item.patient.patientId.match(/(\d+)$/)?.[1];
  if (!patientNumber) throw new TypeError(`synthetic patient ID has no numeric assignment suffix: ${item.patient.patientId}`);
  return {
    patientId: `SYN-P-${patientNumber.padStart(4, "0")}`,
    tenantId: `${tenantPrefix}-tenant-${tenantNumber}`,
    accessGroup: `cohort-${cohort}`,
    role: "clinician",
  };
}

function patientRecord(item: SyntheticClinicalCase, tenantPrefix: string): SyntheticPatientRecord {
  const identity = syntheticEvaluationIdentity(item, tenantPrefix);
  const encounterIds = [...new Set(item.turns.map((turn) => turn.encounterId))];
  if (!encounterIds.length || encounterIds.length > 20) throw new TypeError(`case ${item.caseId} has an invalid Encounter plan`);
  const encounters: SyntheticEncounter[] = encounterIds.map((encounterId, encounterIndex) => {
    const turns = item.turns.filter((turn) => turn.encounterId === encounterId);
    return {
      encounterId,
      label: encounterIndex === encounterIds.length - 1 ? "当前模拟复诊" : `既往模拟就诊 ${encounterIndex + 1}`,
      status: encounterIndex === encounterIds.length - 1 ? "in-progress" : "finished",
      summary: "病例事实仅通过授权后的本次合成咨询逐步披露。",
      turnPlan: turns.map((turn, index) => ({
        turn: index + 1,
        patientMessage: turn.patientMessage,
        factToDisclose: [...turn.requiredHistoricalFactIds, ...turn.requiredCurrentFactIds]
          .map((factId) => item.facts.find((fact) => fact.factId === factId))
          .filter((fact): fact is NonNullable<typeof fact> => Boolean(fact))
          .map((fact) => `${fact.label}: ${fact.value}`)
          .join("；"),
      })),
    };
  });
  const latest = encounters.at(-1)!;
  return {
    patientId: identity.patientId,
    tenantId: identity.tenantId,
    accessGroup: identity.accessGroup,
    synthetic: true,
    displayName: item.patient.displayName,
    age: item.patient.age,
    sex: item.patient.gender === "female" ? "女" : "男",
    encounterId: latest.encounterId,
    encounter: latest.label,
    conditions: [],
    medications: [],
    allergies: [],
    memory: { summary: "", items: 0, updatedLabel: "未加载" },
    suggestedQuestion: "请整理已知信息、待核实项和需要医生审核的内容。",
    encounters,
  };
}

function accountSet(tenantPrefix: string): EvaluationAccountInput[] {
  return [1, 2].flatMap((tenantNumber) => ["a", "b"].map((cohort) => ({
    username: `eval-${tenantNumber}-${cohort}`,
    password: randomUUID() + randomUUID(),
    subjectId: `${tenantPrefix}-subject-${tenantNumber}-${cohort}`,
    displayName: `合成评测用户 ${tenantNumber}-${cohort}`,
    tenantId: `${tenantPrefix}-tenant-${tenantNumber}`,
    accessGroup: `cohort-${cohort}`,
    role: "clinician" as const,
  })));
}

export async function readDemoEventStream(input: {
  readonly response: Response;
  readonly expectedRunId: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly events: readonly DemoEvent[]; readonly incomplete?: "timeout" | "aborted" | "stream-error" }> {
  if (!input.response.body) throw new TypeError("Gateway SSE response has no body");
  const reader = input.response.body.getReader();
  const decoder = new TextDecoder();
  const events: DemoEvent[] = [];
  let pending = "";
  try {
    while (true) {
      const result = await reader.read();
      pending += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
      if (pending.length > 1_000_000) throw new RangeError("Gateway SSE frame buffer exceeded its safety limit");
      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop() ?? "";
      for (const block of blocks) appendSseEvent(block, input.expectedRunId, events);
      if (result.done) {
        appendSseEvent(pending, input.expectedRunId, events);
        return { events };
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    const reason = input.signal?.reason;
    if (input.signal?.aborted) {
      return { events, incomplete: reason instanceof Error && reason.name === "TimeoutError" ? "timeout" : "aborted" };
    }
    if (error instanceof RangeError || error instanceof TypeError || error instanceof SyntaxError) throw error;
    return { events, incomplete: "stream-error" };
  } finally {
    reader.releaseLock();
  }
}

function appendSseEvent(block: string, expectedRunId: string, events: DemoEvent[]): void {
  const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (!data) return;
  const event = parseDemoEvent(JSON.parse(data) as unknown);
  if (event.runId !== expectedRunId) throw new TypeError("Gateway stream run ID did not match its response header");
  events.push(event);
}

export class AuthenticatedClinicalGateway {
  readonly usage = new Map<string, ClinicalRunRecord["tokenUsage"]>();
  readonly memoryTrace: MemoryTraceRecord[] = [];
  readonly tenantPrefix: string;
  private readonly accounts: EvaluationAccountInput[];
  private readonly accountByScope = new Map<string, EvaluationAccountInput>();
  private readonly cookieByUsername = new Map<string, string>();
  private readonly accessiblePatientsByUsername = new Map<string, Set<string>>();
  private readonly dataset: SyntheticEvaluationDataset;
  private readonly backend: DshDemoBackend;
  private readonly server;
  private baseUrl = "";
  private started = false;

  constructor(input: {
    readonly studyRunId: string;
    readonly arm: EvalArm;
  readonly cases: readonly SyntheticClinicalCase[];
  readonly concurrency: number;
  readonly evidenceClient?: MedicalEvidenceClientPort;
  readonly collaborationTrace?: CollaborationTraceSink;
}) {
    this.tenantPrefix = `eval-${input.studyRunId}-${input.arm}`;
    const patients = input.cases.map((item) => patientRecord(item, this.tenantPrefix));
    this.dataset = new SyntheticEvaluationDataset({ patientCount: patients.length }, patients);
    this.accounts = accountSet(this.tenantPrefix);
    for (const account of this.accounts) this.accountByScope.set(`${account.tenantId}\0${account.accessGroup}`, account);
    const capabilities: DshCapabilities = input.arm === "single-agent"
      ? { memory: false, rag: false, collaboration: false }
      : { memory: true, rag: true, collaboration: true };
    this.backend = new DshDemoBackend({
      maxSessions: Math.max(16, input.concurrency * 4 + 4),
      resolvePatient: (patientId, encounterId) => this.dataset.getPatientForBackend(patientId, encounterId),
      observeTokenUsage: (runId, reported) => {
        const rootTotal = reported.rootInputTokens + reported.rootOutputTokens;
        const childTotal = reported.subagentInputTokens + reported.subagentOutputTokens;
        this.usage.set(runId, {
          scope: "dsh-agent-tree",
          inputTokens: reported.rootInputTokens + reported.subagentInputTokens,
          outputTokens: reported.rootOutputTokens + reported.subagentOutputTokens,
          totalTokens: reported.rootTotalTokens + reported.subagentTotalTokens,
          rootInputTokens: reported.rootInputTokens,
          rootOutputTokens: reported.rootOutputTokens,
          rootTotalTokens: reported.rootTotalTokens || rootTotal,
          subagentInputTokens: reported.subagentInputTokens,
          subagentOutputTokens: reported.subagentOutputTokens,
          subagentTotalTokens: reported.subagentTotalTokens || childTotal,
          subagentSessionsObserved: reported.subagentSessionCount,
        });
      },
      runtime: new DshWebRuntime({
        capabilities,
        syntheticAmaMemory: input.arm === "integrated",
        ...(input.collaborationTrace ? { collaborationTrace: input.collaborationTrace } : {}),
        ...(input.evidenceClient ? { evidenceClient: input.evidenceClient } : {}),
        memoryTrace: input.arm === "integrated" ? {
          record: (record) => {
            this.memoryTrace.push(record);
            new MetadataMemoryTrace().record(record);
          },
        } : undefined,
      }),
    });
    this.server = createDemoServer({
      backendName: "dsh",
      backend: this.backend,
      evaluationAuth: new ClinicalEvaluationAuth(this.accounts),
      evaluationDataset: this.dataset,
      evaluationAllowedOrigins: [EVALUATION_ORIGIN],
      log: () => undefined,
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Clinical evaluation Gateway did not bind a loopback TCP port");
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    this.started = true;
  }

  identityFor(item: SyntheticClinicalCase): SyntheticEvaluationIdentity {
    return syntheticEvaluationIdentity(item, this.tenantPrefix);
  }

  async createEncounterSession(item: SyntheticClinicalCase, encounterId: string): Promise<string> {
    await this.start();
    const identity = this.identityFor(item);
    const account = this.accountByScope.get(`${identity.tenantId}\0${identity.accessGroup}`);
    if (!account) throw new Error("No synthetic evaluation account matches the patient assignment");
    const cookie = await this.cookieFor(account);
    let allowed = this.accessiblePatientsByUsername.get(account.username);
    if (!allowed) {
      const response = await fetch(`${this.baseUrl}/api/patients`, { headers: { cookie } });
      if (!response.ok) throw new Error(`Authenticated patient list returned HTTP ${response.status}`);
      const payload = await response.json() as { patients?: Array<{ patientId?: string; synthetic?: boolean }> };
      allowed = new Set((payload.patients ?? []).filter((patient) => patient.synthetic === true && typeof patient.patientId === "string").map((patient) => patient.patientId!));
      this.accessiblePatientsByUsername.set(account.username, allowed);
    }
    if (!allowed.has(identity.patientId)) throw new Error("Synthetic patient assignment was not visible to its authenticated owner");
    const response = await fetch(`${this.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { origin: EVALUATION_ORIGIN, cookie, "content-type": "application/json" },
      body: JSON.stringify({ patientId: identity.patientId, encounterId }),
    });
    if (!response.ok) throw new Error(`Authenticated session creation returned HTTP ${response.status}`);
    const session = await response.json() as { sessionId?: string; patientId?: string; encounterId?: string; synthetic?: boolean };
    if (!session.sessionId || session.patientId !== identity.patientId || session.encounterId !== encounterId || session.synthetic !== true) {
      throw new TypeError("Gateway returned a session with an unexpected patient or Encounter binding");
    }
    return session.sessionId;
  }

  async runTurn(input: {
    readonly sessionId: string;
    readonly patientId: string;
    readonly encounterId: string;
    readonly message: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly runId: string; readonly events: readonly DemoEvent[]; readonly incomplete?: "timeout" | "aborted" | "stream-error" }> {
    const identityCookie = await this.cookieForPatient(input.patientId);
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { origin: EVALUATION_ORIGIN, cookie: identityCookie, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ sessionId: input.sessionId, patientId: input.patientId, encounterId: input.encounterId, message: input.message }),
      signal: input.signal,
    });
    if (!response.ok) throw new Error(`Authenticated clinical chat returned HTTP ${response.status}`);
    const runId = response.headers.get("x-run-id");
    if (!runId) throw new TypeError("Gateway SSE response is missing its run ID");
    const stream = await readDemoEventStream({ response, expectedRunId: runId, signal: input.signal });
    return { runId, ...stream };
  }

  async closeEncounterSession(item: SyntheticClinicalCase, sessionId: string): Promise<void> {
    const identity = this.identityFor(item);
    const account = this.accountByScope.get(`${identity.tenantId}\0${identity.accessGroup}`);
    if (!account) throw new Error("No synthetic evaluation account matches the patient assignment");
    const cookie = await this.cookieFor(account);
    const response = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE", headers: { origin: EVALUATION_ORIGIN, cookie },
    });
    if (response.status !== 204) throw new Error(`Authenticated Encounter closure returned HTTP ${response.status}`);
  }

  async dispose(): Promise<void> {
    for (const account of this.accounts) {
      const cookie = this.cookieByUsername.get(account.username);
      if (!cookie) continue;
      await fetch(`${this.baseUrl}/api/auth/logout`, {
        method: "POST", headers: { origin: EVALUATION_ORIGIN, cookie, "content-type": "application/json" }, body: "{}",
      }).catch(() => undefined);
    }
    await this.backend.dispose();
    if (this.started) {
      await new Promise<void>((resolve, reject) => this.server.close((error: Error | undefined) => error ? reject(error) : resolve()));
      this.started = false;
    }
  }

  private async cookieForPatient(patientId: string): Promise<string> {
    const account = this.accounts.find((candidate) => {
      const patients = this.dataset.listPatients(candidate);
      return patients.some((patient) => patient.patientId === patientId);
    });
    if (!account) throw new Error("No authenticated synthetic account owns this patient");
    return this.cookieFor(account);
  }

  private async cookieFor(account: EvaluationAccountInput): Promise<string> {
    const existing = this.cookieByUsername.get(account.username);
    if (existing) return existing;
    const response = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { origin: EVALUATION_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: account.username, password: account.password }),
    });
    if (!response.ok) throw new Error(`Synthetic Gateway login returned HTTP ${response.status}`);
    const setCookie = response.headers.get("set-cookie");
    const cookie = setCookie?.split(";", 1)[0];
    if (!cookie?.startsWith("huiyi_eval_session=")) throw new TypeError("Gateway login did not issue its HttpOnly evaluation session cookie");
    this.cookieByUsername.set(account.username, cookie);
    return cookie;
  }
}
