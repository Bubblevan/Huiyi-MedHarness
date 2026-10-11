import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClinicalDraftReview } from "./ClinicalDraftReview.js";
import type { ClinicalReviewDraft } from "../../../services/demo-gateway/src/clinical-drafts/registry.js";

function draft(): Omit<ClinicalReviewDraft, "owner"> {
  const patientId = "SYN-P-0001";
  const encounterId = "SYN-P-0001-ENC-02";
  const source = { kind: "patient-message" as const, label: "本次患者描述", patientId, encounterId, runId: "run-1" };
  const item = (itemId: string, label: string, value: string) => ({ itemId, label, value, source, disposition: "unreviewed" as const, reviewNote: "" });
  return {
    schemaVersion: "huiyi-clinical-review-draft/v1", draftId: "00000000-0000-4000-8000-000000000001",
    patientId, encounterId, synthetic: true, clinicalApprovalStatus: "not-performed", version: 1, status: "preliminary",
    sections: {
      chiefConcern: [item("concern-1", "本次复诊主诉", "合成患者主诉")],
      history: [item("history-1", "既往重要病史", "合成病史来源")],
      medications: [item("med-1", "当前用药", "合成用药")],
      allergies: [item("allergy-1", "过敏信息", "合成过敏资料")],
      symptomsAndTests: [item("symptom-1", "本次患者描述", "症状变化待核对")],
      informationToVerify: [item("verify-1", "检查", "核对原始报告")],
      riskSignals: [], medicalEvidence: [item("evidence-1", "本地文献 · 合成标题", "合成证据摘录")],
      assistantResponses: [item("response-1", "模型生成回复（未审核）", "合成模型回答")],
      uncertainty: [item("uncertainty-1", "审核状态", "尚未审核")],
    },
    turns: [{ runId: "run-1", occurredAt: "2026-10-11T12:00:00.000Z", patientMessage: "合成患者主诉", assistantResponse: "合成模型回答", evidenceIds: ["evidence-1"] }],
    createdAt: "2026-10-11T12:00:00.000Z", updatedAt: "2026-10-11T12:00:00.000Z", revisions: [],
  };
}

afterEach(() => cleanup());

describe("ClinicalDraftReview", () => {
  it("shows draft loading errors while no review material exists", () => {
    render(<ClinicalDraftReview draft={null} error="复诊草稿读取失败，请重新加载患者上下文。" onSubmit={vi.fn(async () => undefined)} />);
    expect(screen.getByRole("alert")).toHaveTextContent("复诊草稿读取失败");
  });

  it("submits field edits as demo review without claiming clinical approval", () => {
    const onSubmit = vi.fn(async () => undefined);
    render(<ClinicalDraftReview draft={draft()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("本次复诊主诉"), { target: { value: "编辑后的合成描述" } });
    fireEvent.click(screen.getAllByRole("button", { name: "确认（演示）" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "保存修改 (1)" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      action: "save", expectedVersion: 1,
      changes: [expect.objectContaining({ section: "chiefConcern", itemId: "concern-1", value: "编辑后的合成描述", disposition: "confirmed-in-demo" })],
    }));
    expect(screen.getByText("临床批准：未执行")).toBeInTheDocument();
    expect(screen.getByText(/不会记录为执业医师临床批准/)).toBeInTheDocument();
  });

  it("uses an explicit demo-only approval action", () => {
    const onSubmit = vi.fn(async () => undefined);
    render(<ClinicalDraftReview draft={draft()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "标记演示审核完成" }));
    expect(onSubmit).toHaveBeenCalledWith({ action: "approve-demo", changes: [], expectedVersion: 1 });
    expect(screen.getByText("临床批准：未执行")).toBeInTheDocument();
  });
});
