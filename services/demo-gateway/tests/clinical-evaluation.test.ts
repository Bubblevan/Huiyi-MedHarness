import { afterEach, describe, expect, it } from "vitest";
import { createEvent, type ChatInput, type DemoEvent } from "../src/contracts.js";
import type { DemoBackend } from "../src/backends/backend.js";
import { ClinicalEvaluationAuth, EVALUATION_SESSION_COOKIE, type EvaluationAccountInput } from "../src/clinical-evaluation/auth.js";
import { generateSyntheticPatients, SyntheticEvaluationDataset } from "../src/clinical-evaluation/dataset.js";
import { readAppMode } from "../src/app-mode.js";
import { DshSessionBusyError } from "../src/backends/dsh.js";
import { createDemoServer } from "../src/server.js";
import { ClinicalDraftRegistry } from "../src/clinical-drafts/registry.js";

const origin = "http://127.0.0.1:5173";
const accounts: EvaluationAccountInput[] = [
  { username: "clinician-a", password: "local-synthetic-password-a", subjectId: "subject-a", displayName: "临床用户 A", tenantId: "evaluation-tenant-1", accessGroup: "cohort-a", role: "clinician" },
  { username: "clinician-b", password: "local-synthetic-password-b", subjectId: "subject-b", displayName: "临床用户 B", tenantId: "evaluation-tenant-1", accessGroup: "cohort-b", role: "clinician" },
  { username: "clinician-c", password: "local-synthetic-password-c", subjectId: "subject-c", displayName: "临床用户 C", tenantId: "evaluation-tenant-2", accessGroup: "cohort-a", role: "clinician" },
];

const servers: Array<{ close: () => Promise<void>; baseUrl: string }> = [];
let originalAppEnvironment: string | undefined;

class EvaluationTestBackend implements DemoBackend {
  readonly received: ChatInput[] = [];
  readonly cancellations: string[] = [];

  async *run(input: ChatInput, { runId, signal }: { runId: string; signal: AbortSignal }): AsyncIterable<DemoEvent> {
    this.received.push(input);
    yield createEvent("run.started", runId, input.sessionId, { backend: "dsh", scenario: "simple" });
    if (input.message === "hold for cancellation") {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield createEvent("run.cancelled", runId, input.sessionId, { reason: "client_cancelled" });
      return;
    }
    yield createEvent("assistant.delta", runId, input.sessionId, { text: "synthetic response" });
    yield createEvent("run.completed", runId, input.sessionId, { durationMs: 1 });
  }

  cancel(runId: string): void { this.cancellations.push(runId); }
}

class BusyCloseTestBackend extends EvaluationTestBackend {
  async closeSession(_sessionId: string, _patientId: string, _encounterId?: string): Promise<void> {
    throw new DshSessionBusyError();
  }
}

async function start(backend: EvaluationTestBackend = new EvaluationTestBackend()) {
  const server = createDemoServer({
    backendName: "dsh",
    backend,
    evaluationAuth: new ClinicalEvaluationAuth(accounts),
    evaluationDataset: new SyntheticEvaluationDataset({ patientCount: 12, turnCount: 3, encounterCount: 2, seed: "auth-test-seed" }),
    clinicalDraftRegistry: new ClinicalDraftRegistry(),
    evaluationAllowedOrigins: [origin],
    log: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected ephemeral test listener");
  const instance = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    backend,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
  servers.push(instance);
  return instance;
}

async function login(app: Awaited<ReturnType<typeof start>>, account: EvaluationAccountInput): Promise<string> {
  const response = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ username: account.username, password: account.password }),
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain(`${EVALUATION_SESSION_COOKIE}=`);
  return setCookie!.split(";", 1)[0]!;
}

async function request(app: Awaited<ReturnType<typeof start>>, path: string, cookie?: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${app.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.method === "GET" || !init.method ? {} : { origin }),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  if (originalAppEnvironment === undefined) delete process.env.HUIYI_APP_ENV;
  else process.env.HUIYI_APP_ENV = originalAppEnvironment;
  originalAppEnvironment = undefined;
});

describe("synthetic clinical-evaluation identity and ownership boundary", () => {
  it("keeps explicit development labels from overriding production fail-closed mode", () => {
    expect(readAppMode({ NODE_ENV: "production", HUIYI_APP_ENV: "demo" })).toBe("production");
    expect(readAppMode({ NODE_ENV: "production", HUIYI_APP_ENV: "development" })).toBe("production");
    expect(() => readAppMode({ NODE_ENV: "production", HUIYI_APP_ENV: "clinical-evaluation" })).toThrow(/requires HUIYI_ENABLE_SYNTHETIC_EVALUATION_IN_PRODUCTION/);
    expect(readAppMode({ NODE_ENV: "production", HUIYI_APP_ENV: "clinical-evaluation", HUIYI_ENABLE_SYNTHETIC_EVALUATION_IN_PRODUCTION: "1" })).toBe("clinical-evaluation");
  });

  it("keeps generated patient records deterministic and exposes no turn plan in the authorized list", async () => {
    const first = generateSyntheticPatients({ patientCount: 8, turnCount: 2, encounterCount: 2, seed: "reproducible" });
    const second = generateSyntheticPatients({ patientCount: 8, turnCount: 2, encounterCount: 2, seed: "reproducible" });
    expect(first).toEqual(second);
    expect(first).toHaveLength(8);
    expect(first[0]!.encounters[0]!.turnPlan).toHaveLength(2);
    expect(first.every((patient) => patient.synthetic && patient.patientId.startsWith("SYN-P-"))).toBe(true);
  });

  it("isolates authorization records from mutations to input and returned patient objects", () => {
    const records = generateSyntheticPatients({ patientCount: 2, turnCount: 1, encounterCount: 1, seed: "mutation-isolation" });
    const dataset = new SyntheticEvaluationDataset({}, records);
    const scope = { tenantId: "evaluation-tenant-1", accessGroup: "cohort-a", role: "clinician" as const };
    const patientId = records[0]!.patientId;
    const originalFact = records[0]!.encounters[0]!.turnPlan[0]!.factToDisclose;

    records[0]!.accessGroup = "cohort-b";
    records[0]!.encounters[0]!.turnPlan[0]!.factToDisclose = "caller mutation";
    expect(dataset.getPatient(patientId, scope)?.accessGroup).toBe("cohort-a");

    const returned = dataset.getPatient(patientId, scope)!;
    returned.accessGroup = "cohort-b";
    returned.encounters[0]!.turnPlan[0]!.factToDisclose = "response mutation";
    expect(dataset.getPatient(patientId, scope)?.accessGroup).toBe("cohort-a");
    expect(dataset.getPatient(patientId, scope)?.encounters[0]!.turnPlan[0]!.factToDisclose).toBe(originalFact);
  });

  it("requires login and confines patient, encounter, DSH session, chat and cancellation to the authenticated assignment", async () => {
    originalAppEnvironment = process.env.HUIYI_APP_ENV;
    process.env.HUIYI_APP_ENV = "clinical-evaluation";
    const app = await start();
    const unauthPatients = await request(app, "/api/patients");
    expect(unauthPatients.status).toBe(401);
    expect((await request(app, "/api/sessions", undefined, { method: "POST", body: JSON.stringify({ patientId: "SYN-P-0001", encounterId: "SYN-P-0001-ENC-01" }) })).status).toBe(401);

    const cookieA = await login(app, accounts[0]!);
    const cookieB = await login(app, accounts[1]!);
    const cookieC = await login(app, accounts[2]!);
    const listAResponse = await request(app, "/api/patients", cookieA);
    const listA = await listAResponse.json() as { patients: Array<{ patientId: string; synthetic: boolean; encounters: Array<{ encounterId: string }> }> };
    const listB = await request(app, "/api/patients", cookieB).then((response) => response.json()) as { patients: Array<{ patientId: string }> };
    const listC = await request(app, "/api/patients", cookieC).then((response) => response.json()) as { patients: Array<{ patientId: string }> };
    expect(listA.patients.length).toBeGreaterThan(0);
    expect(listA.patients.every((patient) => patient.synthetic)).toBe(true);
    expect(JSON.stringify(listA)).not.toContain("turnPlan");
    expect(JSON.stringify(listA)).not.toContain("patientMessage");
    const ownPatient = listA.patients[0]!;
    const ownEncounter = ownPatient.encounters[0]!;
    const otherGroupPatient = listB.patients[0]!;
    const otherTenantPatient = listC.patients[0]!;
    expect(listA.patients.some((patient) => patient.patientId === otherGroupPatient.patientId)).toBe(false);
    expect(listA.patients.some((patient) => patient.patientId === otherTenantPatient.patientId)).toBe(false);

    expect((await request(app, `/api/patients/${ownPatient.patientId}/context?encounterId=${ownEncounter.encounterId}`, cookieA)).status).toBe(200);
    expect((await request(app, `/api/patients/${otherGroupPatient.patientId}/context?encounterId=${otherGroupPatient.encounters[0]!.encounterId}`, cookieA)).status).toBe(404);
    expect((await request(app, `/api/patients/${otherTenantPatient.patientId}/encounters`, cookieA)).status).toBe(404);
    const deniedSession = await request(app, "/api/sessions", cookieA, { method: "POST", body: JSON.stringify({ patientId: otherGroupPatient.patientId, encounterId: otherGroupPatient.encounters[0]!.encounterId }) });
    expect(deniedSession.status).toBe(404);

    const sessionResponse = await request(app, "/api/sessions", cookieA, { method: "POST", body: JSON.stringify({ patientId: ownPatient.patientId, encounterId: ownEncounter.encounterId }) });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json() as { sessionId: string };
    const crossUserReplay = await request(app, "/api/chat", cookieB, { method: "POST", body: JSON.stringify({ sessionId: session.sessionId, patientId: ownPatient.patientId, encounterId: ownEncounter.encounterId, message: "hello" }) });
    expect(crossUserReplay.status).toBe(404);
    const crossPatientReplay = await request(app, "/api/chat", cookieA, { method: "POST", body: JSON.stringify({ sessionId: session.sessionId, patientId: otherGroupPatient.patientId, encounterId: otherGroupPatient.encounters[0]!.encounterId, message: "hello" }) });
    expect(crossPatientReplay.status).toBe(404);
    const crossEncounterReplay = await request(app, "/api/chat", cookieA, { method: "POST", body: JSON.stringify({ sessionId: session.sessionId, patientId: ownPatient.patientId, encounterId: ownPatient.encounters[1]!.encounterId, message: "hello" }) });
    expect(crossEncounterReplay.status).toBe(404);
    expect(app.backend.received).toHaveLength(0);

    const validChat = await request(app, "/api/chat", cookieA, { method: "POST", body: JSON.stringify({ sessionId: session.sessionId, patientId: ownPatient.patientId, encounterId: ownEncounter.encounterId, message: "hello" }) });
    expect(validChat.status).toBe(200);
    const validChatEvents = await validChat.text();
    expect(validChatEvents).toContain("synthetic response");
    expect(validChatEvents).toContain("event: draft.updated");
    expect(app.backend.received).toHaveLength(1);

    const draftPath = `/api/patients/${ownPatient.patientId}/encounters/${ownEncounter.encounterId}/draft`;
    const draftResponse = await request(app, draftPath, cookieA);
    expect(draftResponse.status).toBe(200);
    const draftPayload = await draftResponse.json() as { draft: {
      draftId: string; version: number; status: string; synthetic: boolean; clinicalApprovalStatus: string;
      sections: Record<string, Array<{ itemId: string; value: string; disposition: string }>>;
      turns: Array<{ patientMessage: string; assistantResponse: string }>;
      revisions: Array<{ before: unknown; after: { version: number } }>;
    } };
    const draft = draftPayload.draft;
    expect(draft).toMatchObject({ version: 1, status: "preliminary", synthetic: true, clinicalApprovalStatus: "not-performed" });
    expect(draft.sections.chiefConcern?.[0]?.value).toBe("hello");
    expect(draft.sections.history?.[0]?.value).toBeTruthy();
    expect(draft.sections.informationToVerify?.length).toBeGreaterThan(0);
    expect(draft.turns[0]).toMatchObject({ patientMessage: "hello", assistantResponse: "synthetic response" });
    expect(draft.revisions).toHaveLength(1);
    expect((await request(app, draftPath.replace(ownPatient.patientId, otherGroupPatient.patientId).replace(ownEncounter.encounterId, otherGroupPatient.encounters[0]!.encounterId), cookieA)).status).toBe(404);
    expect((await request(app, draftPath, cookieB)).status).toBe(404);

    const concern = draft.sections.chiefConcern![0]!;
    const savedDraftResponse = await request(app, `/api/clinical-drafts/${draft.draftId}`, cookieA, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: 1, action: "save", changes: [{ section: "chiefConcern", itemId: concern.itemId, value: "审阅后的合成主诉", disposition: "confirmed-in-demo", reviewNote: "演示字段核对" }] }),
    });
    expect(savedDraftResponse.status).toBe(200);
    const savedDraft = (await savedDraftResponse.json() as { draft: typeof draft }).draft;
    expect(savedDraft.version).toBe(2);
    expect(savedDraft.sections.chiefConcern[0]!.value).toBe("审阅后的合成主诉");
    expect(savedDraft.revisions[1]!.before).toBeTruthy();
    expect(savedDraft.revisions[1]!.after.version).toBe(2);
    expect((await request(app, `/api/clinical-drafts/${draft.draftId}`, cookieB, {
      method: "PATCH", body: JSON.stringify({ expectedVersion: 2, action: "approve-demo", changes: [] }),
    })).status).toBe(404);

    const demoApproval = await request(app, `/api/clinical-drafts/${draft.draftId}`, cookieA, {
      method: "PATCH", body: JSON.stringify({ expectedVersion: 2, action: "approve-demo", changes: [] }),
    });
    expect(demoApproval.status).toBe(200);
    const approvedDraft = (await demoApproval.json() as { draft: typeof draft }).draft;
    expect(approvedDraft).toMatchObject({ version: 3, status: "approved-in-demo", clinicalApprovalStatus: "not-performed" });
    expect((await request(app, `/api/clinical-drafts/${draft.draftId}`, cookieA, {
      method: "PATCH", body: JSON.stringify({ expectedVersion: 2, action: "reject", changes: [] }),
    })).status).toBe(409);

    const heldChat = await request(app, "/api/chat", cookieA, { method: "POST", body: JSON.stringify({ sessionId: session.sessionId, patientId: ownPatient.patientId, encounterId: ownEncounter.encounterId, message: "hold for cancellation" }) });
    expect(heldChat.status).toBe(200);
    const heldRunId = heldChat.headers.get("x-run-id");
    expect(heldRunId).toBeTruthy();
    const otherUserCancel = await request(app, `/api/runs/${heldRunId}/cancel`, cookieB, { method: "POST", body: "{}" });
    expect(otherUserCancel.status).toBe(404);
    const ownerCancel = await request(app, `/api/runs/${heldRunId}/cancel`, cookieA, { method: "POST", body: "{}" });
    expect(ownerCancel.status).toBe(202);
    await heldChat.text();
    const afterCancel = (await request(app, draftPath, cookieA).then((response) => response.json()) as { draft: typeof draft }).draft;
    expect(afterCancel.version).toBe(3);
    expect(afterCancel.turns).toHaveLength(1);

    const foreignClose = await request(app, `/api/sessions/${session.sessionId}`, cookieB, { method: "DELETE" });
    expect(foreignClose.status).toBe(404);
    const ownerClose = await request(app, `/api/sessions/${session.sessionId}`, cookieA, { method: "DELETE" });
    expect(ownerClose.status).toBe(204);
    expect((await request(app, "/api/chat", cookieA, { method: "POST", body: JSON.stringify({ sessionId: session.sessionId, patientId: ownPatient.patientId, encounterId: ownEncounter.encounterId, message: "hello after close" }) })).status).toBe(404);

    await request(app, "/api/auth/logout", cookieA, { method: "POST", body: "{}" });
    expect((await request(app, "/api/auth/session", cookieA)).status).toBe(401);
    expect((await request(app, "/api/sessions", cookieA, { method: "POST", body: JSON.stringify({ patientId: ownPatient.patientId, encounterId: ownEncounter.encounterId }) })).status).toBe(401);
  });

  it("keeps the Gateway session binding when DSH refuses to close a busy session", async () => {
    originalAppEnvironment = process.env.HUIYI_APP_ENV;
    process.env.HUIYI_APP_ENV = "clinical-evaluation";
    const app = await start(new BusyCloseTestBackend());
    const cookie = await login(app, accounts[0]!);
    const patientResponse = await request(app, "/api/patients", cookie);
    const patient = (await patientResponse.json() as { patients: Array<{ patientId: string; encounters: Array<{ encounterId: string }> }> }).patients[0]!;
    const encounterId = patient.encounters[0]!.encounterId;
    const created = await request(app, "/api/sessions", cookie, { method: "POST", body: JSON.stringify({ patientId: patient.patientId, encounterId }) });
    const { sessionId } = await created.json() as { sessionId: string };

    const close = await request(app, `/api/sessions/${sessionId}`, cookie, { method: "DELETE" });
    expect(close.status).toBe(409);
    expect(await close.json()).toEqual({ error: "SESSION_BUSY" });

    const chat = await request(app, "/api/chat", cookie, { method: "POST", body: JSON.stringify({
      sessionId, patientId: patient.patientId, encounterId, message: "synthetic session remains active",
    }) });
    expect(chat.status).toBe(200);
    await chat.text();
  });

  it("does not enable synthetic evaluation implicitly in production", async () => {
    originalAppEnvironment = process.env.HUIYI_APP_ENV;
    process.env.HUIYI_APP_ENV = "production";
    expect(() => createDemoServer({ backendName: "fixture", log: () => undefined })).toThrow("Fixture backend is disabled in production");
  });
});
