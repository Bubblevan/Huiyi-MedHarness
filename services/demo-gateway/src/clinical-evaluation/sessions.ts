import { randomUUID } from "node:crypto";
import type { EvaluationPrincipal } from "./auth.js";

export interface EvaluationSessionBinding {
  readonly sessionId: string;
  readonly authSessionId: string;
  readonly subjectId: string;
  readonly tenantId: string;
  readonly patientId: string;
  readonly encounterId: string;
  readonly expiresAt: number;
}

export class EvaluationSessionRegistry {
  private readonly sessions = new Map<string, EvaluationSessionBinding>();

  constructor(private readonly now: () => number = Date.now) {}

  create(principal: EvaluationPrincipal, patientId: string, encounterId: string): EvaluationSessionBinding {
    this.pruneExpired();
    const binding = Object.freeze({
      sessionId: randomUUID(),
      authSessionId: principal.authSessionId,
      subjectId: principal.subjectId,
      tenantId: principal.tenantId,
      patientId,
      encounterId,
      expiresAt: principal.expiresAt,
    });
    this.sessions.set(binding.sessionId, binding);
    return binding;
  }

  resolve(sessionId: string, principal: EvaluationPrincipal): EvaluationSessionBinding | undefined {
    const binding = this.sessions.get(sessionId);
    if (!binding) return undefined;
    if (binding.expiresAt <= this.now()) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return binding.authSessionId === principal.authSessionId &&
      binding.subjectId === principal.subjectId && binding.tenantId === principal.tenantId
      ? binding
      : undefined;
  }

  revokeAuthSession(authSessionId: string): EvaluationSessionBinding[] {
    const revoked: EvaluationSessionBinding[] = [];
    for (const [sessionId, binding] of this.sessions) {
      if (binding.authSessionId === authSessionId) {
        this.sessions.delete(sessionId);
        revoked.push(binding);
      }
    }
    return revoked;
  }

  closeSession(sessionId: string, principal: EvaluationPrincipal): EvaluationSessionBinding | undefined {
    const binding = this.resolve(sessionId, principal);
    if (!binding) return undefined;
    this.sessions.delete(sessionId);
    return binding;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [sessionId, binding] of this.sessions) {
      if (binding.expiresAt <= now) this.sessions.delete(sessionId);
    }
  }
}
