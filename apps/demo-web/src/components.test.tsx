import { cleanup, fireEvent, render } from "@testing-library/react";
import { screen } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentActivity, BackendBadge, ErrorNotice, EvidenceDrawer, PatientContext, toSafeActivityEvent, type EvidenceRecord } from "./components.js";
import type { PatientContext as PatientRecord } from "../../../services/demo-gateway/src/contracts.js";
import type { WireDemoEvent } from "./runtime/adapter.js";
import { clinicalCopy, resolveClinicalCopy } from "./copy/clinicalWorkstation.js";

const patient: PatientRecord = {
  patientId: "patient-htn", displayName: "张某", age: 52, sex: "男", encounter: "高血压复诊 · 示例",
  conditions: ["高血压（合成示例）"], medications: ["示例药物"], allergies: ["合成过敏信息"],
  encounterHistory: [{ encounterId: "patient-htn-enc-01", label: "既往复诊 1", status: "finished", summary: "曾建议核对家庭血压记录。" }],
  memory: { summary: "合成长期记忆摘要。", items: 6, updatedLabel: "上次复诊" }, suggestedQuestion: "演示问题",
};

afterEach(cleanup);

describe("clinical demo panels", () => {
  it("shows synthetic patient, context, and a memory card separate from evidence", () => {
    render(<PatientContext patient={patient} />);
    expect(screen.getByText("Synthetic demo patient")).toBeInTheDocument();
    expect(screen.getByText("长期记忆摘要")).toBeInTheDocument();
    expect(screen.getByText("合成长期记忆摘要。")).toBeInTheDocument();
    expect(screen.getByText("既往复诊 1")).toBeInTheDocument();
    expect(screen.getByText("patient-htn-enc-01")).toBeInTheDocument();
    expect(screen.getByText("曾建议核对家庭血压记录。")).toBeInTheDocument();
    expect(screen.queryByText("Demo evidence fixture")).not.toBeInTheDocument();
  });

  it("keeps the development safety copy available and renders a genuine empty state", () => {
    expect(clinicalCopy.composerPrivacyHint).toContain("请勿输入真实患者信息");
    expect(clinicalCopy.disclaimer).toBe("本系统输出不构成诊断或治疗建议，需由医疗专业人员结合完整病史判断。");
    render(<PatientContext patient={null} />);
    expect(screen.getByText(clinicalCopy.patientEmptyTitle)).toBeInTheDocument();
  });

  it("provides distinct production copy with the required patient and privacy wording", () => {
    const productionCopy = resolveClinicalCopy(true);
    expect(productionCopy.patientEmptyTitle).toBe("尚未选择患者");
    expect(productionCopy.patientEmptyHint).toBe("请先加载患者上下文");
    expect(productionCopy.composerPlaceholder).toBe("描述本次复诊问题…");
    expect(productionCopy.composerPrivacyHint).toBe("请遵循机构隐私政策；输入可识别患者信息前，请确认已获得授权。");
    expect(productionCopy.currentScenario).toBe("当前病例");
    expect(productionCopy.activityCaption).toBe("仅显示脱敏执行元数据");
    expect(productionCopy.disclaimer).toBe("本系统输出不构成诊断或治疗建议，需由医疗专业人员结合完整病史判断。");
    expect(productionCopy.productionDecisionDisclaimer).toBe("本系统仅用于辅助临床工作流，最终决策由执业医师负责。");
    expect(productionCopy.scenarioLabel).not.toMatch(/demo|synthetic|演示|合成/i);
    expect(productionCopy.patientTag).toBe("");
    expect(productionCopy.patientDataNote).toBe("");
  });

  it("shows structured activity without any prompt or answer text", () => {
    const events: WireDemoEvent[] = [
      { version: 1, event: "context.memory", runId: "r-1", sessionId: "s-1", timestamp: "2026-10-09T10:00:00.000Z", data: { itemCount: 6 } },
      { version: 1, event: "agent.classified", runId: "r-1", sessionId: "s-1", timestamp: "2026-10-09T10:00:01.000Z", data: { complexity: "intermediate", simulated: true } },
      { version: 1, event: "assistant.delta", runId: "r-1", sessionId: "s-1", timestamp: "2026-10-09T10:00:02.000Z", data: { text: "private answer omitted" } },
    ];
    render(<AgentActivity events={events} />);
    expect(screen.getByText("6 条摘要项")).toBeInTheDocument();
    expect(screen.getByText(/simulated execution/)).toBeInTheDocument();
    expect(screen.queryByText("private answer omitted")).not.toBeInTheDocument();
  });

  it("reduces production activity events to allowlisted metadata", () => {
    const privateEvent: WireDemoEvent = {
      version: 1, event: "evidence.item", runId: "private-run", sessionId: "private-session",
      timestamp: "2026-10-09T10:00:00.000Z",
      data: { evidenceId: "E1", snippet: "private evidence text", title: "patient name", patientPrompt: "private prompt" },
    };
    const safe = toSafeActivityEvent(privateEvent);
    expect(safe).toMatchObject({ runId: "redacted", sessionId: "redacted", data: {} });
    expect(JSON.stringify(safe)).not.toContain("private");
    expect(toSafeActivityEvent({ ...privateEvent, event: "assistant.delta" })).toBeNull();
    const retrievalEvent: WireDemoEvent = {
      version: 1, event: "evidence.completed", runId: "private-run", sessionId: "private-session",
      timestamp: "2026-10-09T10:00:00.000Z",
      data: { count: 3, retrieval: {
        mode: "iterative", rounds: 2, generatedQueries: 4, uniqueDocuments: 8, candidateCount: 12,
        returnedEvidenceCount: 3, retrievalCalls: 4, plannerCalls: 2, retrievalLatencyMs: 100,
        plannerLatencyMs: 200, latencyMs: 300, estimatedContextTokens: 500, plannerModel: "gpt-6-luna",
        plannerPromptVersion: "v1", corpusVersion: "corpus-v1", degraded: false,
      } },
    };
    expect(toSafeActivityEvent(retrievalEvent)?.data).toEqual({ count: 3 });

    const draftEvent: WireDemoEvent = {
      version: 1, event: "draft.updated", runId: "private-run", sessionId: "private-session",
      timestamp: "2026-10-09T10:00:03.000Z",
      data: { draftId: "private-draft-id", version: 2, status: "preliminary", patientMessage: "private patient text" },
    };
    const safeDraft = toSafeActivityEvent(draftEvent);
    expect(safeDraft?.data).toEqual({ version: 2, status: "preliminary" });
    expect(JSON.stringify(safeDraft)).not.toContain("private");
  });

  it("shows evidence source fixture cards and closes its drawer", () => {
    const item: EvidenceRecord = { evidenceId: "ev-001", rank: 1, source: "Demo evidence fixture", title: "居家血压记录（合成资料）", snippet: "合成证据摘要。" };
    const onClose = vi.fn();
    render(<EvidenceDrawer open items={[item]} onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Evidence Sources" })).toBeInTheDocument();
    expect(screen.getAllByText("Demo evidence fixture")).toHaveLength(2);
    expect(screen.getByText("ev-001")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭证据抽屉" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("labels local DSH evidence correctly and renders untrusted snippets as text", () => {
    const maliciousText = "<img src=x onerror=alert(1)>";
    const item: EvidenceRecord = { evidenceId: "ev-live", rank: 1, source: "Textbooks", title: "Reference", snippet: maliciousText };
    const { container } = render(<EvidenceDrawer open items={[item]} onClose={() => undefined} backend="dsh" />);
    expect(screen.getByText("本地医学检索结果")).toBeInTheDocument();
    expect(screen.queryByText("Demo evidence fixture")).not.toBeInTheDocument();
    expect(screen.getByText(maliciousText)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/检索片段来自本地医学语料/)).toBeInTheDocument();
  });

  it("identifies the backend mode and presents safe service errors", () => {
    render(<><BackendBadge backend="fixture" /><ErrorNotice message="FIXTURE_FAILURE" /></>);
    expect(screen.getByText("Local · fixture")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("服务暂时不可用，请稍后重试。");
    expect(screen.getByRole("alert")).toHaveTextContent("FIXTURE_FAILURE");
  });
});
