import { cleanup, fireEvent, render } from "@testing-library/react";
import { screen } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentActivity, BackendBadge, ErrorNotice, EvidenceDrawer, PatientContext, toSafeActivityEvent, type EvidenceRecord } from "./components.js";
import type { PatientContext as PatientRecord } from "../../../services/demo-gateway/src/contracts.js";
import type { WireDemoEvent } from "./runtime/adapter.js";
import { clinicalCopy } from "./copy/clinicalWorkstation.js";

const patient: PatientRecord = {
  patientId: "patient-htn", displayName: "张某", age: 52, sex: "男", encounter: "高血压复诊 · 示例",
  conditions: ["高血压（合成示例）"], medications: ["示例药物"], allergies: ["合成过敏信息"],
  memory: { summary: "合成长期记忆摘要。", items: 6, updatedLabel: "上次复诊" }, suggestedQuestion: "演示问题",
};

afterEach(cleanup);

describe("clinical demo panels", () => {
  it("shows synthetic patient, context, and a memory card separate from evidence", () => {
    render(<PatientContext patient={patient} />);
    expect(screen.getByText("Synthetic demo patient")).toBeInTheDocument();
    expect(screen.getByText("长期记忆摘要")).toBeInTheDocument();
    expect(screen.getByText("合成长期记忆摘要。")).toBeInTheDocument();
    expect(screen.queryByText("Demo evidence fixture")).not.toBeInTheDocument();
  });

  it("keeps the development safety copy available and renders a genuine empty state", () => {
    expect(clinicalCopy.composerPrivacyHint).toContain("请勿输入真实患者信息");
    expect(clinicalCopy.disclaimer).toBe("本系统输出不构成诊断或治疗建议，需由医疗专业人员结合完整病史判断。");
    render(<PatientContext patient={null} />);
    expect(screen.getByText(clinicalCopy.patientEmptyTitle)).toBeInTheDocument();
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
