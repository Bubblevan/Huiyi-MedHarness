import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readAppMode } from "./app-mode.js";
import type { DemoEvent } from "./contracts.js";
import { createEvent, parseDemoEvent, validateChatInput } from "./contracts.js";
import { DshDemoBackend } from "./backends/dsh.js";
import type { DemoBackend } from "./backends/backend.js";
import { readModelConfiguration } from "./backends/dsh-runtime.js";
import { FixtureDemoBackend } from "./backends/fixture.js";
import { ClinicalEvaluationAuth, type EvaluationPrincipal } from "./clinical-evaluation/auth.js";
import { SyntheticEvaluationDataset, type SyntheticDatasetOptions } from "./clinical-evaluation/dataset.js";
import { EvaluationSessionRegistry } from "./clinical-evaluation/sessions.js";
import { ClinicalDraftRegistry, DraftVersionConflictError, publicClinicalDraft, type DraftChange, type DraftReviewAction, type ClinicalDraftSection } from "./clinical-drafts/registry.js";

export interface DemoServerOptions {
  backend?: DemoBackend;
  backendName?: "fixture" | "dsh";
  host?: string;
  port?: number;
  log?: (metadata: Record<string, string | number>) => void;
  evaluationAuth?: ClinicalEvaluationAuth;
  evaluationDataset?: SyntheticEvaluationDataset;
  evaluationAllowedOrigins?: readonly string[];
  clinicalDraftRegistry?: ClinicalDraftRegistry;
  clinicalDraftStorePath?: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClinicalDraftReview(value: unknown): {
  readonly expectedVersion: number;
  readonly action: DraftReviewAction;
  readonly changes: readonly DraftChange[];
} | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !["expectedVersion", "action", "changes"].includes(key))
    || !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 0
    || !["save", "needs-follow-up", "reject", "approve-demo"].includes(String(value.action))
    || !Array.isArray(value.changes) || value.changes.length > 40) return undefined;
  const sections: readonly ClinicalDraftSection[] = ["chiefConcern", "history", "medications", "allergies", "symptomsAndTests", "informationToVerify", "riskSignals", "medicalEvidence", "assistantResponses", "uncertainty"];
  const changes: DraftChange[] = [];
  for (const item of value.changes) {
    if (!isRecord(item) || Object.keys(item).some((key) => !["section", "itemId", "value", "disposition", "reviewNote"].includes(key))
      || typeof item.section !== "string" || !sections.includes(item.section as ClinicalDraftSection)
      || typeof item.itemId !== "string" || item.itemId.length > 120
      || (item.value !== undefined && (typeof item.value !== "string" || item.value.length > 8_000))
      || (item.reviewNote !== undefined && (typeof item.reviewNote !== "string" || item.reviewNote.length > 2_000))
      || (item.disposition !== undefined && !["unreviewed", "confirmed-in-demo", "rejected-in-demo"].includes(String(item.disposition)))) return undefined;
    changes.push({
      section: item.section as ClinicalDraftSection,
      itemId: item.itemId,
      ...(typeof item.value === "string" ? { value: item.value } : {}),
      ...(typeof item.disposition === "string" ? { disposition: item.disposition as DraftChange["disposition"] } : {}),
      ...(typeof item.reviewNote === "string" ? { reviewNote: item.reviewNote } : {}),
    });
  }
  if (value.action === "save" && !changes.length) return undefined;
  return { expectedVersion: Number(value.expectedVersion), action: value.action as DraftReviewAction, changes };
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function readSyntheticDatasetOptions(env: NodeJS.ProcessEnv): SyntheticDatasetOptions {
  return {
    patientCount: boundedInteger(env.HUIYI_EVAL_PATIENT_COUNT, 300, 1, 10_000),
    turnCount: boundedInteger(env.HUIYI_EVAL_TURN_COUNT, 8, 1, 100),
    encounterCount: boundedInteger(env.HUIYI_EVAL_ENCOUNTER_COUNT, 3, 1, 20),
    seed: env.HUIYI_EVAL_DATASET_SEED?.trim() || "huiyi-clinical-evaluation-v1",
  };
}

function evaluationCookieSecure(): boolean {
  return process.env.HUIYI_EVAL_COOKIE_SECURE === "1" || process.env.NODE_ENV === "production";
}

function hasAllowedOrigin(request: IncomingMessage, origins: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  return typeof origin === "string" && origins.has(origin);
}

function principalView(principal: EvaluationPrincipal): Record<string, string> {
  return { displayName: principal.displayName, role: principal.role, environment: "临床评测环境" };
}

function encounterList(dataset: SyntheticEvaluationDataset, patientId: string, principal: EvaluationPrincipal) {
  return dataset.getEncounterSummaries(patientId, principal);
}

async function getDemoSeedPatient(patientId: string) {
  const seed = await import("./demo-seed/patients.js");
  return seed.getPatient(patientId);
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
  const mode = readAppMode();
  const production = mode === "production";
  const clinicalEvaluation = mode === "clinical-evaluation";
  if (production && process.env.HUIYI_DEMO_SYNTHETIC_AMA_MEMORY?.trim() === "1") {
    throw new Error("Synthetic patient AMA memory is disabled in production");
  }
  const backendName = options.backendName ?? (production || clinicalEvaluation || process.env.HUIYI_DEMO_BACKEND === "dsh" ? "dsh" : "fixture");
  if (production && backendName === "fixture") {
    throw new Error("Fixture backend is disabled in production");
  }
  if (clinicalEvaluation && backendName === "fixture") throw new Error("Clinical-evaluation requires the DSH backend");
  const evaluationAuth = clinicalEvaluation
    ? options.evaluationAuth ?? (process.env.HUIYI_EVAL_USERS_JSON ? ClinicalEvaluationAuth.fromJson(process.env.HUIYI_EVAL_USERS_JSON) : undefined)
    : undefined;
  if (clinicalEvaluation && !evaluationAuth) throw new Error("Clinical-evaluation requires HUIYI_EVAL_USERS_JSON with synthetic accounts");
  const evaluationDataset = clinicalEvaluation
    ? options.evaluationDataset ?? new SyntheticEvaluationDataset(readSyntheticDatasetOptions(process.env))
    : undefined;
  const allowedEvaluationOrigins = new Set(options.evaluationAllowedOrigins ?? (process.env.HUIYI_EVAL_ALLOWED_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173")
    .split(",").map((origin) => origin.trim()).filter(Boolean));
  const evaluationSessions = clinicalEvaluation ? new EvaluationSessionRegistry() : undefined;
  const configuredDraftPath = options.clinicalDraftStorePath ?? process.env.HUIYI_CLINICAL_DRAFT_STORE_PATH?.trim();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const clinicalDrafts = clinicalEvaluation
    ? options.clinicalDraftRegistry ?? new ClinicalDraftRegistry({
      path: configuredDraftPath
        ? isAbsolute(configuredDraftPath) ? configuredDraftPath : resolve(repoRoot, configuredDraftPath)
        : resolve(repoRoot, "services/demo-gateway/data/clinical-evaluation/review-drafts.json"),
    })
    : undefined;
  const backend: DemoBackend = options.backend ?? (backendName === "dsh"
    ? new DshDemoBackend({ resolvePatient: clinicalEvaluation ? (patientId, encounterId) => evaluationDataset?.getPatientForBackend(patientId, encounterId) : undefined })
    : new FixtureDemoBackend());
  const activeRuns = new Map<string, { controller: AbortController; sessionId: string; startedAt: number; settled: Promise<void>; settle: () => void; ownerAuthSessionId?: string }>();
  const failedLogins = new Map<string, { count: number; blockedUntil: number }>();
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
    if (clinicalEvaluation && evaluationAuth && evaluationDataset && evaluationSessions) {
      if (method === "POST" && url.pathname === "/api/auth/login") {
        if (!hasAllowedOrigin(request, allowedEvaluationOrigins)) { json(response, 403, { error: "ORIGIN_NOT_ALLOWED" }); return; }
        if (!isJsonContentType(request)) { json(response, 415, { error: "UNSUPPORTED_MEDIA_TYPE" }); return; }
        let body: unknown;
        try { body = await readJson(request, 4_096); }
        catch (error) { json(response, error instanceof RangeError ? 413 : 400, { error: "INVALID_REQUEST" }); return; }
        if (!isRecord(body) || Object.keys(body).some((key) => key !== "username" && key !== "password") ||
            typeof body.username !== "string" || typeof body.password !== "string" || body.username.length > 64 || body.password.length > 256) {
          json(response, 400, { error: "INVALID_REQUEST" });
          return;
        }
        const ip = request.socket.remoteAddress ?? "unknown";
        const attemptKey = `${ip}\0${body.username.trim().toLowerCase()}`;
        const attempt = failedLogins.get(attemptKey);
        if (attempt && attempt.blockedUntil > Date.now()) { json(response, 429, { error: "LOGIN_RATE_LIMITED" }); return; }
        const login = evaluationAuth.login(body.username, body.password);
        if (!login) {
          const count = (attempt?.count ?? 0) + 1;
          failedLogins.set(attemptKey, { count, blockedUntil: count >= 5 ? Date.now() + 5 * 60_000 : 0 });
          json(response, count >= 5 ? 429 : 401, { error: count >= 5 ? "LOGIN_RATE_LIMITED" : "INVALID_CREDENTIALS" });
          return;
        }
        failedLogins.delete(attemptKey);
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": evaluationAuth.cookie(login.token, evaluationCookieSecure()),
        });
        response.end(JSON.stringify({ authenticated: true, user: principalView(login.principal) }));
        try { log({ requestId, event: "auth.login", outcome: "allowed", role: login.principal.role }); } catch { /* logging cannot break login */ }
        return;
      }

      if (method === "GET" && url.pathname === "/api/auth/session") {
        const principal = evaluationAuth.resolve(request.headers.cookie);
        if (!principal) { json(response, 401, { error: "AUTH_REQUIRED" }); return; }
        json(response, 200, { authenticated: true, user: principalView(principal), expiresAt: new Date(principal.expiresAt).toISOString() });
        return;
      }

      if (method === "POST" && url.pathname === "/api/auth/logout") {
        if (!hasAllowedOrigin(request, allowedEvaluationOrigins)) { json(response, 403, { error: "ORIGIN_NOT_ALLOWED" }); return; }
        const principal = evaluationAuth.resolve(request.headers.cookie);
        const secure = evaluationCookieSecure();
        if (!principal) {
          response.writeHead(204, { "cache-control": "no-store", "set-cookie": evaluationAuth.clearCookie(secure) });
          response.end();
          return;
        }
        const revoked = evaluationSessions.revokeAuthSession(principal.authSessionId);
        for (const [runId, run] of activeRuns) {
          if (run.ownerAuthSessionId !== principal.authSessionId) continue;
          run.controller.abort();
          backend.cancel(runId);
          await run.settled;
        }
        for (const session of revoked) await backend.closeSession?.(session.sessionId, session.patientId, session.encounterId).catch(() => undefined);
        evaluationAuth.revoke(request.headers.cookie);
        response.writeHead(204, { "cache-control": "no-store", "set-cookie": evaluationAuth.clearCookie(secure) });
        response.end();
        try { log({ requestId, event: "auth.logout", outcome: "allowed", role: principal.role }); } catch { /* logging cannot break logout */ }
        return;
      }

      const principal = evaluationAuth.resolve(request.headers.cookie);
      if (method === "GET" && url.pathname === "/api/patients") {
        if (!principal) { json(response, 401, { error: "AUTH_REQUIRED" }); return; }
        json(response, 200, { patients: evaluationDataset.listPatients(principal).map((patient) => ({
          patientId: patient.patientId,
          displayName: patient.displayName,
          age: patient.age,
          sex: patient.sex,
          synthetic: patient.synthetic,
          encounters: patient.encounters.map(({ encounterId, label, status }) => ({ encounterId, label, status })),
        })) });
        return;
      }

      const encountersMatch = url.pathname.match(/^\/api\/patients\/([^/]+)\/encounters$/);
      if (method === "GET" && encountersMatch) {
        if (!principal) { json(response, 401, { error: "AUTH_REQUIRED" }); return; }
        const patientId = decodePathSegment(encountersMatch[1] ?? "");
        if (!patientId) { json(response, 400, { error: "INVALID_PATH" }); return; }
        const encounters = encounterList(evaluationDataset, patientId, principal);
        if (!encounters) { json(response, 404, { error: "PATIENT_NOT_FOUND" }); return; }
        json(response, 200, { encounters: encounters.map(({ encounterId, label, status }) => ({ encounterId, label, status })) });
        return;
      }

      const contextMatch = url.pathname.match(/^\/api\/patients\/([^/]+)\/context$/);
      if (method === "GET" && contextMatch) {
        if (!principal) { json(response, 401, { error: "AUTH_REQUIRED" }); return; }
        const patientId = decodePathSegment(contextMatch[1] ?? "");
        const encounterId = url.searchParams.get("encounterId") ?? "";
        if (!patientId) { json(response, 400, { error: "INVALID_PATH" }); return; }
        const patient = evaluationDataset.getPatient(patientId, principal);
        const encounter = patient?.encounters.find((item) => item.encounterId === encounterId);
        const context = patient && encounter ? evaluationDataset.getPatientForBackend(patientId, encounterId) : undefined;
        if (!context) { json(response, 404, { error: "PATIENT_OR_ENCOUNTER_NOT_FOUND" }); return; }
        json(response, 200, context);
        return;
      }

      const encounterDraftMatch = url.pathname.match(/^\/api\/patients\/([^/]+)\/encounters\/([^/]+)\/draft$/);
      if (method === "GET" && encounterDraftMatch) {
        if (!principal) { json(response, 401, { error: "AUTH_REQUIRED" }); return; }
        if (!clinicalDrafts) { json(response, 503, { error: "DRAFT_STORE_UNAVAILABLE" }); return; }
        const patientId = decodePathSegment(encounterDraftMatch[1] ?? "");
        const encounterId = decodePathSegment(encounterDraftMatch[2] ?? "");
        if (!patientId || !encounterId) { json(response, 400, { error: "INVALID_PATH" }); return; }
        const patient = evaluationDataset.getPatient(patientId, principal);
        if (!patient || !patient.encounters.some((item) => item.encounterId === encounterId)) {
          json(response, 404, { error: "PATIENT_OR_ENCOUNTER_NOT_FOUND" });
          return;
        }
        const context = evaluationDataset.getPatientForBackend(patientId, encounterId);
        if (!context) { json(response, 404, { error: "PATIENT_OR_ENCOUNTER_NOT_FOUND" }); return; }
        const drafts = await clinicalDrafts.list(context, principal);
        json(response, 200, { draft: drafts[0] ? publicClinicalDraft(drafts[0]) : null });
        try { log({ requestId, event: "clinical-draft.read", outcome: "allowed", role: principal.role }); } catch { /* logging cannot break reads */ }
        return;
      }

      const clinicalDraftMatch = url.pathname.match(/^\/api\/clinical-drafts\/([A-Za-z0-9-]{36})$/i);
      if (method === "PATCH" && clinicalDraftMatch) {
        if (!hasAllowedOrigin(request, allowedEvaluationOrigins)) { json(response, 403, { error: "ORIGIN_NOT_ALLOWED" }); return; }
        if (!principal) { json(response, 401, { error: "AUTH_REQUIRED" }); return; }
        if (!clinicalDrafts) { json(response, 503, { error: "DRAFT_STORE_UNAVAILABLE" }); return; }
        if (principal.role !== "clinician") { json(response, 403, { error: "REVIEW_ROLE_REQUIRED" }); return; }
        if (!isJsonContentType(request)) { json(response, 415, { error: "UNSUPPORTED_MEDIA_TYPE" }); return; }
        let body: unknown;
        try { body = await readJson(request, 16_384); }
        catch (error) { json(response, error instanceof RangeError ? 413 : 400, { error: "INVALID_REQUEST" }); return; }
        const review = parseClinicalDraftReview(body);
        if (!review) { json(response, 400, { error: "INVALID_REQUEST" }); return; }
        try {
          const updated = await clinicalDrafts.review({
            draftId: clinicalDraftMatch[1]!, actor: principal, expectedVersion: review.expectedVersion,
            action: review.action, changes: review.changes,
          });
          if (!updated) { json(response, 404, { error: "DRAFT_NOT_FOUND" }); return; }
          json(response, 200, { draft: publicClinicalDraft(updated) });
          try { log({ requestId, event: "clinical-draft.reviewed", outcome: "allowed", role: principal.role, action: review.action, version: updated.version, status: updated.status }); } catch { /* audit output cannot break a saved review */ }
        } catch (error) {
          if (error instanceof DraftVersionConflictError) { json(response, 409, { error: "DRAFT_VERSION_CONFLICT" }); return; }
          if (error instanceof TypeError) { json(response, 400, { error: "INVALID_DRAFT_CHANGE" }); return; }
          throw error;
        }
        return;
      }

      if (method === "POST" && url.pathname === "/api/sessions") {
        if (!hasAllowedOrigin(request, allowedEvaluationOrigins)) { json(response, 403, { error: "ORIGIN_NOT_ALLOWED" }); return; }
        if (!principal) { json(response, 401, { error: "AUTH_REQUIRED" }); return; }
        if (!isJsonContentType(request)) { json(response, 415, { error: "UNSUPPORTED_MEDIA_TYPE" }); return; }
        let body: unknown;
        try { body = await readJson(request, 4_096); }
        catch (error) { json(response, error instanceof RangeError ? 413 : 400, { error: "INVALID_REQUEST" }); return; }
        if (!isRecord(body) || Object.keys(body).some((key) => key !== "patientId" && key !== "encounterId") ||
            typeof body.patientId !== "string" || typeof body.encounterId !== "string") {
          json(response, 400, { error: "INVALID_REQUEST" });
          return;
        }
        const patient = evaluationDataset.getPatient(body.patientId, principal);
        const encounter = patient?.encounters.find((item) => item.encounterId === body.encounterId);
        if (!patient || !encounter) { json(response, 404, { error: "PATIENT_OR_ENCOUNTER_NOT_FOUND" }); return; }
        const session = evaluationSessions.create(principal, patient.patientId, encounter.encounterId);
        json(response, 201, { sessionId: session.sessionId, patientId: session.patientId, encounterId: session.encounterId, expiresAt: new Date(session.expiresAt).toISOString(), synthetic: true });
        try { log({ requestId, event: "session.created", outcome: "allowed", role: principal.role }); } catch { /* logging cannot break session creation */ }
        return;
      }

      const closeSessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (method === "DELETE" && closeSessionMatch) {
        if (!hasAllowedOrigin(request, allowedEvaluationOrigins)) { json(response, 403, { error: "ORIGIN_NOT_ALLOWED" }); return; }
        if (!principal) { json(response, 401, { error: "AUTH_REQUIRED" }); return; }
        const sessionId = decodePathSegment(closeSessionMatch[1] ?? "");
        if (!sessionId) { json(response, 400, { error: "INVALID_PATH" }); return; }
        const binding = evaluationSessions.closeSession(sessionId, principal);
        if (!binding) { json(response, 404, { error: "SESSION_NOT_FOUND" }); return; }
        await backend.closeSession?.(binding.sessionId, binding.patientId, binding.encounterId);
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        try { log({ requestId, event: "session.closed", outcome: "allowed", role: principal.role }); } catch { /* logging cannot break session closure */ }
        return;
      }
    }

    const patientMatch = url.pathname.match(/^\/api\/demo\/patients\/([^/]+)$/);
    if (method === "GET" && patientMatch) {
      if (production || clinicalEvaluation) { json(response, 404, { error: "NOT_FOUND" }); return; }
      const patientId = decodePathSegment(patientMatch[1] ?? "");
      if (patientId === undefined) { json(response, 400, { error: "INVALID_PATH" }); return; }
      const patient = await getDemoSeedPatient(patientId);
      if (!patient) { json(response, 404, { error: "INVALID_FIXTURE_PATIENT" }); return; }
      json(response, 200, patient);
      return;
    }
    const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (method === "POST" && cancelMatch) {
      if (clinicalEvaluation && !hasAllowedOrigin(request, allowedEvaluationOrigins)) { json(response, 403, { error: "ORIGIN_NOT_ALLOWED" }); return; }
      const cancelPrincipal = clinicalEvaluation ? evaluationAuth?.resolve(request.headers.cookie) : undefined;
      if (clinicalEvaluation && !cancelPrincipal) { json(response, 401, { error: "AUTH_REQUIRED" }); return; }
      const runId = decodePathSegment(cancelMatch[1] ?? "");
      if (runId === undefined) { json(response, 400, { error: "INVALID_PATH" }); return; }
      const run = activeRuns.get(runId);
      if (!run || (clinicalEvaluation && run.ownerAuthSessionId !== cancelPrincipal?.authSessionId)) { json(response, 404, { error: "RUN_NOT_FOUND" }); return; }
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
      if (clinicalEvaluation && !hasAllowedOrigin(request, allowedEvaluationOrigins)) { json(response, 403, { error: "ORIGIN_NOT_ALLOWED" }); return; }
      const chatPrincipal = clinicalEvaluation ? evaluationAuth?.resolve(request.headers.cookie) : undefined;
      if (clinicalEvaluation && !chatPrincipal) { json(response, 401, { error: "AUTH_REQUIRED" }); return; }
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
      if (clinicalEvaluation) {
        if (input.scenario !== undefined || !input.encounterId) { json(response, 400, { error: "INVALID_REQUEST" }); return; }
        const binding = evaluationSessions?.resolve(input.sessionId, chatPrincipal!);
        if (!binding || binding.patientId !== input.patientId || binding.encounterId !== input.encounterId) {
          json(response, 404, { error: "SESSION_NOT_FOUND" });
          return;
        }
        const patient = evaluationDataset?.getPatient(input.patientId, chatPrincipal!);
        if (!patient || !patient.encounters.some((encounter) => encounter.encounterId === input.encounterId)) {
          json(response, 404, { error: "PATIENT_OR_ENCOUNTER_NOT_FOUND" });
          return;
        }
      } else if (!await getDemoSeedPatient(input.patientId)) {
        json(response, 422, { error: "INVALID_FIXTURE_PATIENT" });
        return;
      }
      const runId = randomUUID();
      const controller = new AbortController();
      const startedAt = Date.now();
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => { settle = resolve; });
      const runState = { controller, sessionId: input.sessionId, startedAt, settled, settle, ...(chatPrincipal ? { ownerAuthSessionId: chatPrincipal.authSessionId } : {}) };
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
      let assistantText = "";
      const capturedEvidence: Array<{ evidenceId: string; rank: number; source: string; title: string; snippet: string }> = [];
      try {
        for await (const event of backend.run(input, { runId, signal: controller.signal })) {
          if (response.destroyed) break;
          if (event.event === "assistant.delta") assistantText = `${assistantText}${event.data.text}`.slice(0, 200_000);
          if (event.event === "evidence.item") capturedEvidence.push({
            evidenceId: event.data.evidenceId, rank: event.data.rank, source: event.data.source,
            title: event.data.title, snippet: event.data.snippet,
          });
          if (event.event === "run.completed" && clinicalEvaluation && chatPrincipal && clinicalDrafts && evaluationDataset) {
            const context = evaluationDataset.getPatientForBackend(input.patientId, input.encounterId);
            if (context && assistantText.trim()) {
              try {
                const draft = await clinicalDrafts.appendCompletedTurn({
                  patient: context, actor: chatPrincipal, runId, patientMessage: input.message,
                  assistantResponse: assistantText, evidence: capturedEvidence,
                });
                sendEvent(response, createEvent("draft.updated", runId, input.sessionId, { draftId: draft.draftId, version: draft.version, status: "preliminary" }));
              } catch {
                try { log({ requestId, event: "clinical-draft.save", outcome: "failed", role: chatPrincipal.role, errorCode: "DRAFT_SAVE_FAILED" }); } catch { /* audit output cannot break response */ }
                sendEvent(response, createEvent("draft.save_failed", runId, input.sessionId, { code: "DRAFT_SAVE_FAILED" }));
              }
            }
          }
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
