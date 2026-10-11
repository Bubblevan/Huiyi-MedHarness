import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { PatientAccessScope } from "./dataset.js";

export const EVALUATION_SESSION_COOKIE = "huiyi_eval_session";
const PASSWORD_BYTES = 64;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface EvaluationAccountInput {
  readonly username: string;
  readonly password: string;
  readonly subjectId: string;
  readonly displayName: string;
  readonly tenantId: string;
  readonly accessGroup: string;
  readonly role: "clinician" | "administrator";
}

export interface EvaluationPrincipal extends PatientAccessScope {
  readonly authSessionId: string;
  readonly subjectId: string;
  readonly displayName: string;
  readonly expiresAt: number;
}

interface StoredAccount extends Omit<EvaluationAccountInput, "password"> {
  readonly usernameKey: string;
  readonly salt: Buffer;
  readonly passwordHash: Buffer;
}

interface StoredSession {
  readonly tokenHash: string;
  readonly principal: EvaluationPrincipal;
}

export interface LoginResult {
  readonly token: string;
  readonly principal: EvaluationPrincipal;
}

export class ClinicalEvaluationAuth {
  private readonly accounts = new Map<string, StoredAccount>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly fakeSalt = randomBytes(16);
  private readonly fakeHash = scryptSync(randomBytes(32), this.fakeSalt, PASSWORD_BYTES);

  constructor(accounts: readonly EvaluationAccountInput[], private readonly now: () => number = Date.now) {
    if (!accounts.length) throw new TypeError("At least one clinical-evaluation account is required");
    const subjects = new Set<string>();
    for (const account of accounts) {
      const usernameKey = account.username.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(usernameKey) || this.accounts.has(usernameKey)) throw new TypeError("Evaluation usernames must be unique ASCII identifiers");
      if (account.password.length < 12 || account.password.length > 256) throw new TypeError("Evaluation passwords must contain 12 to 256 characters");
      if (!/^[A-Za-z0-9._:-]{1,96}$/.test(account.subjectId) || !/^[A-Za-z0-9._:-]{1,96}$/.test(account.tenantId) || !/^[A-Za-z0-9._:-]{1,96}$/.test(account.accessGroup)) throw new TypeError("Evaluation identity fields contain unsupported characters");
      if (subjects.has(account.subjectId)) throw new TypeError("Evaluation subject IDs must be unique");
      subjects.add(account.subjectId);
      if (!account.displayName.trim() || account.displayName.length > 80) throw new TypeError("Evaluation displayName must contain 1 to 80 characters");
      const salt = randomBytes(16);
      const passwordHash = scryptSync(account.password, salt, PASSWORD_BYTES);
      const { password: _discardPassword, ...identity } = account;
      this.accounts.set(usernameKey, { ...identity, usernameKey, salt, passwordHash });
    }
  }

  static fromJson(raw: string): ClinicalEvaluationAuth {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new TypeError("HUIYI_EVAL_USERS_JSON is invalid JSON"); }
    if (!Array.isArray(parsed) || parsed.some((value) => !isEvaluationAccountInput(value))) throw new TypeError("HUIYI_EVAL_USERS_JSON must be an array of valid synthetic accounts");
    return new ClinicalEvaluationAuth(parsed);
  }

  login(username: string, password: string): LoginResult | undefined {
    this.pruneExpiredSessions();
    const key = username.trim().toLowerCase();
    const account = this.accounts.get(key);
    const salt = account?.salt ?? this.fakeSalt;
    const expected = account?.passwordHash ?? this.fakeHash;
    const supplied = scryptSync(password, salt, PASSWORD_BYTES);
    if (!account || !timingSafeEqual(expected, supplied)) return undefined;

    const token = randomBytes(32).toString("base64url");
    const principal: EvaluationPrincipal = {
      authSessionId: randomBytes(16).toString("hex"),
      subjectId: account.subjectId,
      displayName: account.displayName,
      tenantId: account.tenantId,
      accessGroup: account.accessGroup,
      role: account.role,
      expiresAt: this.now() + SESSION_TTL_MS,
    };
    const tokenHash = createHash("sha256").update(token).digest("hex");
    this.sessions.set(tokenHash, { tokenHash, principal });
    return { token, principal };
  }

  resolve(cookieHeader: string | undefined): EvaluationPrincipal | undefined {
    const token = readCookie(cookieHeader, EVALUATION_SESSION_COOKIE);
    if (!token) return undefined;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const session = this.sessions.get(tokenHash);
    if (!session) return undefined;
    if (session.principal.expiresAt <= this.now()) {
      this.sessions.delete(tokenHash);
      return undefined;
    }
    return session.principal;
  }

  revoke(cookieHeader: string | undefined): EvaluationPrincipal | undefined {
    const token = readCookie(cookieHeader, EVALUATION_SESSION_COOKIE);
    if (!token) return undefined;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const session = this.sessions.get(tokenHash);
    this.sessions.delete(tokenHash);
    return session?.principal;
  }

  cookie(token: string, secure: boolean): string {
    return `${EVALUATION_SESSION_COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`;
  }

  clearCookie(secure: boolean): string {
    return `${EVALUATION_SESSION_COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
  }

  private pruneExpiredSessions(): void {
    const now = this.now();
    for (const [tokenHash, session] of this.sessions) {
      if (session.principal.expiresAt <= now) this.sessions.delete(tokenHash);
    }
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || undefined;
  }
  return undefined;
}

function isEvaluationAccountInput(value: unknown): value is EvaluationAccountInput {
  if (!isRecord(value)) return false;
  return typeof value.username === "string" && typeof value.password === "string" &&
    typeof value.subjectId === "string" && typeof value.displayName === "string" &&
    typeof value.tenantId === "string" && typeof value.accessGroup === "string" &&
    (value.role === "clinician" || value.role === "administrator");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
