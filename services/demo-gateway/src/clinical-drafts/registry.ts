import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PatientContext } from "../contracts.js";
import type { EvaluationPrincipal } from "../clinical-evaluation/auth.js";

export const CLINICAL_DRAFT_SCHEMA = "huiyi-clinical-review-draft/v1" as const;

export type ClinicalDraftSection =
  | "chiefConcern"
  | "history"
  | "medications"
  | "allergies"
  | "symptomsAndTests"
  | "informationToVerify"
  | "riskSignals"
  | "medicalEvidence"
  | "assistantResponses"
  | "uncertainty";

export type DraftItemDisposition = "unreviewed" | "confirmed-in-demo" | "rejected-in-demo";
export type DraftWorkflowStatus = "preliminary" | "needs-follow-up" | "rejected-in-demo" | "approved-in-demo";
export type DraftReviewAction = "save" | "needs-follow-up" | "reject" | "approve-demo";

export interface DraftItemSource {
  readonly kind: "patient-context" | "patient-message" | "medical-evidence" | "assistant-response" | "workflow" | "reviewer";
  readonly label: string;
  readonly patientId: string;
  readonly encounterId: string;
  readonly runId?: string;
  readonly evidenceId?: string;
}

export interface ClinicalDraftItem {
  readonly itemId: string;
  label: string;
  value: string;
  source: DraftItemSource;
  disposition: DraftItemDisposition;
  reviewNote: string;
}

export interface ClinicalDraftEvidence {
  readonly evidenceId: string;
  readonly rank: number;
  readonly source: string;
  readonly title: string;
  readonly snippet: string;
  readonly runId: string;
}

export interface ClinicalDraftTurn {
  readonly runId: string;
  readonly occurredAt: string;
  readonly patientMessage: string;
  readonly assistantResponse: string;
  readonly evidenceIds: readonly string[];
}

export interface ClinicalDraftSnapshot {
  readonly version: number;
  readonly status: DraftWorkflowStatus;
  readonly sections: Readonly<Record<ClinicalDraftSection, readonly ClinicalDraftItem[]>>;
  readonly turns: readonly ClinicalDraftTurn[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ClinicalDraftRevision {
  readonly version: number;
  readonly action: "turn-completed" | DraftReviewAction;
  readonly actor: { readonly subjectId: string; readonly displayName: string; readonly role: string };
  readonly occurredAt: string;
  readonly before: ClinicalDraftSnapshot | null;
  readonly after: ClinicalDraftSnapshot;
}

export interface ClinicalReviewDraft extends Omit<ClinicalDraftSnapshot, "version" | "status" | "sections" | "turns" | "updatedAt"> {
  readonly schemaVersion: typeof CLINICAL_DRAFT_SCHEMA;
  readonly draftId: string;
  readonly patientId: string;
  readonly encounterId: string;
  readonly synthetic: true;
  /** This demo state is never a clinical approval, including when approved-in-demo. */
  readonly clinicalApprovalStatus: "not-performed";
  readonly owner: { readonly tenantId: string; readonly accessGroup: string };
  version: number;
  status: DraftWorkflowStatus;
  sections: Record<ClinicalDraftSection, ClinicalDraftItem[]>;
  turns: ClinicalDraftTurn[];
  updatedAt: string;
  revisions: ClinicalDraftRevision[];
}

export interface DraftEvidenceInput {
  readonly evidenceId: string;
  readonly rank: number;
  readonly source: string;
  readonly title: string;
  readonly snippet: string;
}

export interface DraftTurnInput {
  readonly patient: PatientContext;
  readonly actor: EvaluationPrincipal;
  readonly runId: string;
  readonly patientMessage: string;
  readonly assistantResponse: string;
  readonly evidence: readonly DraftEvidenceInput[];
  readonly occurredAt?: string;
}

export interface DraftChange {
  readonly section: ClinicalDraftSection;
  readonly itemId: string;
  readonly value?: string;
  readonly disposition?: DraftItemDisposition;
  readonly reviewNote?: string;
}

export class ClinicalDraftRegistry {
  private readonly drafts = new Map<string, ClinicalReviewDraft>();
  private readonly path?: string;
  private readonly now: () => Date;
  private readonly ready: Promise<void>;
  private mutations: Promise<void> = Promise.resolve();

  constructor(options: { readonly path?: string; readonly now?: () => Date } = {}) {
    this.path = options.path ? resolve(options.path) : undefined;
    this.now = options.now ?? (() => new Date());
    this.ready = this.load();
  }

  async list(patient: PatientContext, actor: EvaluationPrincipal): Promise<ClinicalReviewDraft[]> {
    await this.ready;
    return [...this.drafts.values()]
      .filter((draft) => draft.patientId === patient.patientId && draft.encounterId === patient.encounterId
        && draft.owner.tenantId === actor.tenantId && draft.owner.accessGroup === actor.accessGroup)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneDraft);
  }

  async appendCompletedTurn(input: DraftTurnInput): Promise<ClinicalReviewDraft> {
    return this.mutate(async () => {
      const patient = input.patient;
      const key = draftScopeKey(patient.patientId, patient.encounterId ?? "", input.actor.tenantId, input.actor.accessGroup);
      const current = [...this.drafts.values()].find((draft) => draftScopeKey(draft.patientId, draft.encounterId, draft.owner.tenantId, draft.owner.accessGroup) === key);
      const occurredAt = input.occurredAt ?? this.now().toISOString();
      if (current?.turns.some((turn) => turn.runId === input.runId)) return cloneDraft(current);

      const before = current ? snapshotOf(current) : null;
      const draft = current ? cloneDraft(current) : createInitialDraft(input, occurredAt);
      const evidence = input.evidence.map((item) => ({ ...item, runId: input.runId }));
      draft.turns = [...draft.turns, {
        runId: input.runId,
        occurredAt,
        patientMessage: input.patientMessage,
        assistantResponse: input.assistantResponse,
        evidenceIds: evidence.map((item) => item.evidenceId),
      }];
      if (!draft.sections.chiefConcern.length) draft.sections.chiefConcern = [makeItem({
        itemId: stableItemId("chief", input.runId), label: "初次复诊主诉", value: input.patientMessage,
        source: source("patient-message", "本次患者描述", patient, input.runId), disposition: "unreviewed",
      })];
      draft.sections.symptomsAndTests = [...draft.sections.symptomsAndTests, makeItem({
        itemId: stableItemId("symptom", input.runId), label: "本次患者描述", value: input.patientMessage,
        source: source("patient-message", "本次患者描述", patient, input.runId), disposition: "unreviewed",
      })];
      draft.sections.assistantResponses = [...draft.sections.assistantResponses, makeItem({
        itemId: stableItemId("response", input.runId), label: "模型生成回复（未审核）", value: input.assistantResponse,
        source: source("assistant-response", "DSH AgentLoop 最终回复", patient, input.runId), disposition: "unreviewed",
      })];
      const knownEvidence = new Set(draft.sections.medicalEvidence.map((item) => item.itemId));
      draft.sections.medicalEvidence = [...draft.sections.medicalEvidence, ...evidence
        .filter((item) => !knownEvidence.has(item.evidenceId))
        .map((item) => makeItem({
          itemId: item.evidenceId,
          label: `${item.source} · ${item.title}`,
          value: item.snippet,
          source: { ...source("medical-evidence", item.source, patient, input.runId), evidenceId: item.evidenceId },
          disposition: "unreviewed",
        }))];
      draft.version = (current?.version ?? 0) + 1;
      draft.status = "preliminary";
      draft.updatedAt = occurredAt;
      const revision = makeRevision(draft, "turn-completed", input.actor, before);
      draft.revisions = [...draft.revisions, revision];
      this.drafts.set(draft.draftId, draft);
      try { await this.persist(); }
      catch (error) {
        if (current) this.drafts.set(current.draftId, current);
        else this.drafts.delete(draft.draftId);
        throw error;
      }
      return cloneDraft(draft);
    });
  }

  async review(input: {
    readonly draftId: string;
    readonly actor: EvaluationPrincipal;
    readonly changes: readonly DraftChange[];
    readonly action: DraftReviewAction;
    readonly expectedVersion: number;
  }): Promise<ClinicalReviewDraft | undefined> {
    return this.mutate(async () => {
      const current = this.drafts.get(input.draftId);
      if (!current || current.owner.tenantId !== input.actor.tenantId || current.owner.accessGroup !== input.actor.accessGroup) return undefined;
      if (current.version !== input.expectedVersion) throw new DraftVersionConflictError();
      const before = snapshotOf(current);
      const draft = cloneDraft(current);
      applyChanges(draft, input.changes);
      if (input.action === "needs-follow-up") draft.status = "needs-follow-up";
      else if (input.action === "reject") draft.status = "rejected-in-demo";
      else if (input.action === "approve-demo") draft.status = "approved-in-demo";
      else if (input.action === "save" && (draft.status === "rejected-in-demo" || draft.status === "approved-in-demo" || draft.status === "needs-follow-up")) draft.status = "preliminary";
      draft.version += 1;
      draft.updatedAt = this.now().toISOString();
      draft.revisions = [...draft.revisions, makeRevision(draft, input.action, input.actor, before)];
      this.drafts.set(draft.draftId, draft);
      try { await this.persist(); }
      catch (error) { this.drafts.set(current.draftId, current); throw error; }
      return cloneDraft(draft);
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    await this.ready;
    const current = this.mutations;
    let release!: () => void;
    this.mutations = new Promise<void>((resolveMutation) => { release = resolveMutation; });
    await current;
    try { return await operation(); }
    finally { release(); }
  }

  private async load(): Promise<void> {
    if (!this.path) return;
    let text: string;
    try { text = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { throw new TypeError("clinical review draft store is not valid JSON"); }
    if (!Array.isArray(parsed) || parsed.some((item) => !isClinicalReviewDraft(item))) {
      throw new TypeError("clinical review draft store has an unsupported schema");
    }
    for (const draft of parsed) this.drafts.set(draft.draftId, draft);
  }

  private async persist(): Promise<void> {
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify([...this.drafts.values()])}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.path);
    } finally { await rm(temporaryPath, { force: true }).catch(() => undefined); }
  }
}

export class DraftVersionConflictError extends Error {
  constructor() { super("DRAFT_VERSION_CONFLICT"); this.name = "DraftVersionConflictError"; }
}

export function publicClinicalDraft(draft: ClinicalReviewDraft): Omit<ClinicalReviewDraft, "owner"> {
  const { owner: _owner, ...visible } = draft;
  return visible;
}

function createInitialDraft(input: DraftTurnInput, occurredAt: string): ClinicalReviewDraft {
  const patient = input.patient;
  const item = (section: string, index: number, label: string, value: string, sourceEncounterId = patient.encounterId ?? "") => makeItem({
    itemId: stableItemId(section, `${patient.patientId}:${sourceEncounterId}:${index}`), label, value,
    source: source("patient-context", "服务端合成患者上下文", patient, input.runId, sourceEncounterId), disposition: "unreviewed",
  });
  const sections: Record<ClinicalDraftSection, ClinicalDraftItem[]> = {
    chiefConcern: [],
    history: [
      ...patient.conditions.map((value, index) => item("history", index, "已知问题", value)),
      ...(patient.encounterHistory ?? []).map((encounter, index) => item(
        "prior-encounter", index, `既往就诊摘要 · ${encounter.label}`, encounter.summary, encounter.encounterId,
      )),
      ...(patient.memory.summary.trim() ? [item("memory", 0, "纵向记忆摘要（合成）", patient.memory.summary)] : []),
    ],
    medications: patient.medications.map((value, index) => item("medication", index, "用药记录（需核对当前实际用药）", value)),
    allergies: patient.allergies.map((value, index) => item("allergy", index, "过敏信息（需核对）", value)),
    symptomsAndTests: [],
    informationToVerify: [
      item("verify", 0, "用药", "核对当前实际用药、剂量及依从性；本条为审核任务，不是患者事实。"),
      item("verify", 1, "检查", "核对与本次复诊相关检查的日期和原始结果；未提供时保持未提供。"),
    ],
    riskSignals: [],
    medicalEvidence: [],
    assistantResponses: [],
    uncertainty: [
      item("uncertainty", 0, "风险状态", "当前工作台未运行独立结构化风险筛查；风险条目为空不代表无风险。"),
      item("uncertainty", 1, "审核状态", "模型生成内容尚未完成临床审核，不得作为已批准的诊疗结论或写回真实 EMR。"),
    ],
  };
  return {
    schemaVersion: CLINICAL_DRAFT_SCHEMA,
    draftId: randomUUID(),
    patientId: patient.patientId,
    encounterId: patient.encounterId ?? "",
    synthetic: true,
    clinicalApprovalStatus: "not-performed",
    owner: { tenantId: input.actor.tenantId, accessGroup: input.actor.accessGroup },
    version: 0,
    status: "preliminary",
    sections,
    turns: [],
    createdAt: occurredAt,
    updatedAt: occurredAt,
    revisions: [],
  };
}

function applyChanges(draft: ClinicalReviewDraft, changes: readonly DraftChange[]): void {
  if (changes.length > 40) throw new TypeError("too many draft changes");
  const seen = new Set<string>();
  for (const change of changes) {
    if (!isClinicalDraftSection(change.section) || typeof change.itemId !== "string" || change.itemId.length > 120) throw new TypeError("INVALID_DRAFT_CHANGE");
    const key = `${change.section}\0${change.itemId}`;
    if (seen.has(key)) throw new TypeError("DUPLICATE_DRAFT_CHANGE");
    seen.add(key);
    if (change.value !== undefined && (typeof change.value !== "string" || change.value.length > 8_000)) throw new TypeError("INVALID_DRAFT_VALUE");
    if (change.reviewNote !== undefined && (typeof change.reviewNote !== "string" || change.reviewNote.length > 2_000)) throw new TypeError("INVALID_REVIEW_NOTE");
    if (change.disposition !== undefined && !["unreviewed", "confirmed-in-demo", "rejected-in-demo"].includes(change.disposition)) throw new TypeError("INVALID_DRAFT_DISPOSITION");
    const target = draft.sections[change.section].find((item) => item.itemId === change.itemId);
    if (!target) throw new TypeError("DRAFT_ITEM_NOT_FOUND");
    if (change.value !== undefined) target.value = change.value;
    if (change.disposition !== undefined) target.disposition = change.disposition;
    if (change.reviewNote !== undefined) target.reviewNote = change.reviewNote;
  }
}

function makeRevision(
  draft: ClinicalReviewDraft,
  action: ClinicalDraftRevision["action"],
  actor: EvaluationPrincipal,
  before: ClinicalDraftSnapshot | null,
): ClinicalDraftRevision {
  return {
    version: draft.version,
    action,
    actor: { subjectId: actor.subjectId, displayName: actor.displayName, role: actor.role },
    occurredAt: draft.updatedAt,
    before,
    after: snapshotOf(draft),
  };
}

function snapshotOf(draft: ClinicalReviewDraft): ClinicalDraftSnapshot {
  return structuredClone({
    version: draft.version,
    status: draft.status,
    sections: draft.sections,
    turns: draft.turns,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  });
}

function makeItem(input: Omit<ClinicalDraftItem, "reviewNote"> & { readonly reviewNote?: string }): ClinicalDraftItem {
  return { ...input, reviewNote: input.reviewNote ?? "" };
}

function source(kind: DraftItemSource["kind"], label: string, patient: PatientContext, runId?: string, encounterId = patient.encounterId ?? ""): DraftItemSource {
  return { kind, label, patientId: patient.patientId, encounterId, ...(runId ? { runId } : {}) };
}

function stableItemId(prefix: string, value: string): string {
  return `${prefix}-${value.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 96)}`;
}

function draftScopeKey(patientId: string, encounterId: string, tenantId: string, accessGroup: string): string {
  return JSON.stringify([patientId, encounterId, tenantId, accessGroup]);
}

function cloneDraft(draft: ClinicalReviewDraft): ClinicalReviewDraft { return structuredClone(draft); }

function isClinicalDraftSection(value: unknown): value is ClinicalDraftSection {
  return typeof value === "string" && ["chiefConcern", "history", "medications", "allergies", "symptomsAndTests", "informationToVerify", "riskSignals", "medicalEvidence", "assistantResponses", "uncertainty"].includes(value);
}

function isClinicalReviewDraft(value: unknown): value is ClinicalReviewDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Partial<ClinicalReviewDraft>;
  return draft.schemaVersion === CLINICAL_DRAFT_SCHEMA && typeof draft.draftId === "string"
    && typeof draft.patientId === "string" && typeof draft.encounterId === "string"
    && draft.synthetic === true && draft.clinicalApprovalStatus === "not-performed"
    && typeof draft.version === "number" && Number.isSafeInteger(draft.version)
    && !!draft.owner && typeof draft.owner.tenantId === "string" && typeof draft.owner.accessGroup === "string"
    && !!draft.sections && Object.keys(draft.sections).length === 10
    && Array.from(Object.values(draft.sections)).every(Array.isArray)
    && Array.isArray(draft.turns) && Array.isArray(draft.revisions);
}
