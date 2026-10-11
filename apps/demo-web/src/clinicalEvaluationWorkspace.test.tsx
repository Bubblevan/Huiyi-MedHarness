import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClinicalEvaluationWorkspace } from "./clinicalEvaluationWorkspace.js";

const syntheticPatients = [
  { patientId: "SYN-P-0001", displayName: "合成患者 A", age: 52, sex: "女", synthetic: true as const, encounters: [{ encounterId: "ENC-A-01", label: "合成复诊 A", status: "finished" as const }] },
  { patientId: "SYN-P-0002", displayName: "合成患者 B", age: 61, sex: "男", synthetic: true as const, encounters: [{ encounterId: "ENC-B-02", label: "合成复诊 B", status: "in-progress" as const }] },
];

function patientContext(patientId: string) {
  const item = syntheticPatients.find((patient) => patient.patientId === patientId)!;
  return {
    patientId,
    displayName: item.displayName,
    age: item.age,
    sex: item.sex,
    encounter: item.encounters[0]!.label,
    conditions: ["合成病史条目"],
    medications: ["合成用药条目"],
    allergies: ["未提供合成过敏信息"],
    memory: { summary: "仅用于交互测试的合成记忆。", items: 1, updatedLabel: "合成历史" },
    suggestedQuestion: "合成问题",
  };
}

function event(eventName: string, sessionId: string, data: Record<string, unknown>) {
  return `data: ${JSON.stringify({ version: 1, event: eventName, runId: "synthetic-run", sessionId, timestamp: "2026-10-11T00:00:00.000Z", data })}\n\n`;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: () => undefined });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
});

describe("clinical evaluation workspace flow", () => {
  it("binds the submitted turn to the selected patient, encounter, and server session", async () => {
    const sessionRequests: { patientId: string; encounterId: string }[] = [];
    let chatBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      const method = init?.method ?? "GET";
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/health") return json({ status: "ok", backend: "dsh", providerName: "Codex app-server", modelName: "gpt-6-luna" });
      if (url.pathname === "/api/auth/session") return json({ error: "AUTH_REQUIRED" }, 401);
      if (url.pathname === "/api/auth/login" && method === "POST") return json({ authenticated: true, user: { displayName: "合成评测用户", role: "clinician", environment: "临床评测环境" } });
      if (url.pathname === "/api/patients" && method === "GET") return json({ patients: syntheticPatients });
      const contextMatch = url.pathname.match(/^\/api\/patients\/([^/]+)\/context$/);
      if (contextMatch && method === "GET") return json(patientContext(decodeURIComponent(contextMatch[1]!)));
      if (url.pathname === "/api/sessions" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { patientId: string; encounterId: string };
        sessionRequests.push(body);
        return json({ sessionId: body.patientId === "SYN-P-0002" ? "B0000002-session" : "A0000001-session" });
      }
      if (url.pathname === "/api/chat" && method === "POST") {
        chatBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const sessionId = typeof chatBody.sessionId === "string" ? chatBody.sessionId : "missing-session";
        return new Response(
          event("run.started", sessionId, { backend: "dsh", scenario: "simple" }) +
            event("assistant.delta", sessionId, { text: "已完成合成会话链路检查。" }) +
            event("run.completed", sessionId, { durationMs: 1 }),
          { headers: { "content-type": "text/event-stream; charset=utf-8", "x-run-id": "synthetic-run" } },
        );
      }
      if (url.pathname === "/api/auth/logout" && method === "POST") return new Response(null, { status: 204 });
      return json({ error: `UNEXPECTED_MOCK_ROUTE:${method}:${url.pathname}` }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });

    render(<ClinicalEvaluationWorkspace />);
    await screen.findByRole("heading", { name: "登录临床工作台" });
    fireEvent.change(screen.getByLabelText("评测账号"), { target: { value: "synthetic-clinician" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "synthetic-password-not-real" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await screen.findByText("合成患者 A");
    await waitFor(() => expect(screen.getByText("A0000001")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("患者"), { target: { value: "SYN-P-0002" } });
    await screen.findByText("合成患者 B");
    await waitFor(() => expect(screen.getByText("B0000002")).toBeInTheDocument());
    await waitFor(() => expect(sessionRequests).toHaveLength(2));

    const input = screen.getByRole("textbox", { name: "描述本次复诊问题…" });
    fireEvent.change(input, { target: { value: "请整理本次合成复诊的问题。" } });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));
    await screen.findByText("已完成合成会话链路检查。");
    expect(chatBody).toMatchObject({
      patientId: "SYN-P-0002",
      encounterId: "ENC-B-02",
      sessionId: "B0000002-session",
      message: "请整理本次合成复诊的问题。",
    });
    expect(chatBody).not.toHaveProperty("scenario");

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await screen.findByRole("heading", { name: "登录临床工作台" });
    expect(screen.queryByText("合成患者 B")).not.toBeInTheDocument();
  });
});
