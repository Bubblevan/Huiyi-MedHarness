import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PatientContext } from "../src/contracts.js";
import type { EvaluationPrincipal } from "../src/clinical-evaluation/auth.js";
import { ClinicalDraftRegistry, DraftVersionConflictError } from "../src/clinical-drafts/registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function context(patientId = "SYN-P-0001"): PatientContext {
  return {
    patientId, tenantId: "evaluation-tenant-1", encounterId: "SYN-P-0001-ENC-02", synthetic: true,
    displayName: "模拟患者 0001", age: 48, sex: "女", encounter: "当前模拟复诊",
    conditions: ["已知合成病史"], medications: ["合成用药记录"], allergies: ["合成过敏记录"],
    memory: { summary: "合成纵向记忆", items: 2, updatedLabel: "模拟数据" }, suggestedQuestion: "请核对本次复诊信息。",
  };
}

const actor: EvaluationPrincipal = {
  authSessionId: "auth-session-a", subjectId: "synthetic-clinician-a", displayName: "模拟审核者 A",
  tenantId: "evaluation-tenant-1", accessGroup: "cohort-a", role: "clinician", expiresAt: Date.now() + 60_000,
};

describe("synthetic clinical draft versions and review audit", () => {
  it("persists a structured preliminary draft and records before/after review snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "huiyi-clinical-draft-"));
    roots.push(root);
    const storePath = join(root, "drafts.json");
    const firstRegistry = new ClinicalDraftRegistry({ path: storePath });
    const first = await firstRegistry.appendCompletedTurn({
      patient: context(), actor, runId: "run-1", patientMessage: "本次模拟复诊主诉",
      assistantResponse: "模型生成的合成回复", evidence: [{ evidenceId: "EV-1", rank: 1, source: "local", title: "合成证据标题", snippet: "合成证据摘录" }],
      occurredAt: "2026-10-11T12:00:00.000Z",
    });
    expect(first).toMatchObject({ version: 1, status: "preliminary", synthetic: true, clinicalApprovalStatus: "not-performed" });
    expect(first.sections.history[0]?.source.kind).toBe("patient-context");
    expect(first.sections.medicalEvidence[0]?.source.evidenceId).toBe("EV-1");
    expect(first.sections.riskSignals).toHaveLength(0);
    expect(first.revisions[0]?.before).toBeNull();

    const second = await firstRegistry.review({
      draftId: first.draftId, actor, expectedVersion: 1, action: "save",
      changes: [{ section: "chiefConcern", itemId: first.sections.chiefConcern[0]!.itemId, value: "审核后的合成描述", disposition: "confirmed-in-demo", reviewNote: "已核对模拟内容" }],
    });
    expect(second?.version).toBe(2);
    expect(second?.revisions[1]?.before?.sections.chiefConcern[0]?.value).toBe("本次模拟复诊主诉");
    expect(second?.revisions[1]?.after.sections.chiefConcern[0]?.value).toBe("审核后的合成描述");

    const reloaded = await new ClinicalDraftRegistry({ path: storePath });
    const persisted = await reloaded.list(context(), actor);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ version: 2, clinicalApprovalStatus: "not-performed" });
    expect(persisted[0]?.revisions).toHaveLength(2);

    await expect(reloaded.review({ draftId: first.draftId, actor, expectedVersion: 1, action: "reject", changes: [] }))
      .rejects.toBeInstanceOf(DraftVersionConflictError);
    expect(await reloaded.list(context("SYN-P-0002"), actor)).toHaveLength(0);
    expect(await reloaded.list(context(), { ...actor, accessGroup: "cohort-b" })).toHaveLength(0);
  });

  it("keeps a demo approval separate from clinical approval", async () => {
    const registry = new ClinicalDraftRegistry();
    const first = await registry.appendCompletedTurn({
      patient: context(), actor, runId: "run-demo-approval", patientMessage: "模拟主诉", assistantResponse: "合成回复", evidence: [],
    });
    const approved = await registry.review({ draftId: first.draftId, actor, expectedVersion: 1, action: "approve-demo", changes: [] });
    expect(approved?.status).toBe("approved-in-demo");
    expect(approved?.clinicalApprovalStatus).toBe("not-performed");
    expect(approved?.revisions.at(-1)?.action).toBe("approve-demo");
  });
});
