import { expect, test } from "@playwright/test";

const patients = [
  { patientId: "SYN-P-0001", displayName: "合成患者 A", age: 52, sex: "女", synthetic: true, encounters: [{ encounterId: "ENC-A-01", label: "合成复诊 A", status: "finished" }] },
  { patientId: "SYN-P-0002", displayName: "合成患者 B", age: 61, sex: "男", synthetic: true, encounters: [{ encounterId: "ENC-B-02", label: "合成复诊 B", status: "in-progress" }] },
];

function context(patientId: string) {
  const patient = patients.find((item) => item.patientId === patientId)!;
  return {
    patientId, displayName: patient.displayName, age: patient.age, sex: patient.sex,
    encounter: patient.encounters[0]!.label,
    conditions: ["合成病史条目"], medications: ["合成用药条目"], allergies: ["未提供合成过敏信息"],
    memory: { summary: "仅用于交互测试的合成记忆。", items: 1, updatedLabel: "合成历史" }, suggestedQuestion: "合成问题",
  };
}

function event(eventName: string, sessionId: string, data: Record<string, unknown>) {
  return `data: ${JSON.stringify({ version: 1, event: eventName, runId: "synthetic-run", sessionId, timestamp: "2026-10-11T00:00:00.000Z", data })}\n\n`;
}

test("browser binds a submitted conversation to the selected synthetic patient and Encounter", async ({ page }) => {
  const sessions: { patientId: string; encounterId: string }[] = [];
  let chat: Record<string, unknown> | undefined;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === "/api/health") return route.fulfill({ json: { status: "ok", backend: "dsh", providerName: "Codex app-server", modelName: "gpt-6-luna" } });
    if (url.pathname === "/api/auth/session") return route.fulfill({ status: 401, json: { error: "AUTH_REQUIRED" } });
    if (url.pathname === "/api/auth/login" && method === "POST") return route.fulfill({ json: { authenticated: true, user: { displayName: "合成评测用户", role: "clinician", environment: "临床评测环境" } } });
    if (url.pathname === "/api/patients" && method === "GET") return route.fulfill({ json: { patients } });
    const match = url.pathname.match(/^\/api\/patients\/([^/]+)\/context$/);
    if (match && method === "GET") return route.fulfill({ json: context(decodeURIComponent(match[1]!)) });
    if (url.pathname === "/api/sessions" && method === "POST") {
      const body = request.postDataJSON() as { patientId: string; encounterId: string };
      sessions.push(body);
      return route.fulfill({ json: { sessionId: body.patientId === "SYN-P-0002" ? "B0000002-session" : "A0000001-session" } });
    }
    if (url.pathname === "/api/chat" && method === "POST") {
      chat = request.postDataJSON() as Record<string, unknown>;
      const sessionId = typeof chat.sessionId === "string" ? chat.sessionId : "missing-session";
      return route.fulfill({
        headers: { "content-type": "text/event-stream; charset=utf-8", "x-run-id": "synthetic-run" },
        body: event("run.started", sessionId, { backend: "dsh", scenario: "simple" }) +
          event("assistant.delta", sessionId, { text: "已完成合成会话链路检查。" }) +
          event("run.completed", sessionId, { durationMs: 1 }),
      });
    }
    if (url.pathname === "/api/auth/logout" && method === "POST") return route.fulfill({ status: 204, body: "" });
    return route.fulfill({ status: 404, json: { error: "UNEXPECTED_MOCK_ROUTE" } });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录临床工作台" })).toBeVisible();
  await page.getByLabel("评测账号").fill("synthetic-clinician");
  await page.getByLabel("密码").fill("synthetic-password-not-real");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "合成患者 A" })).toBeVisible();
  await expect(page.locator(".session-meta code")).toHaveText("A0000001");

  await page.getByLabel("患者").selectOption("SYN-P-0002");
  await expect(page.getByRole("heading", { name: "合成患者 B" })).toBeVisible();
  await expect(page.locator(".session-meta code")).toHaveText("B0000002");
  await expect.poll(() => sessions.length).toBe(2);
  await page.getByRole("textbox", { name: "描述本次复诊问题…" }).fill("请整理本次合成复诊的问题。");
  await page.getByRole("button", { name: /发送/ }).click();
  await expect(page.getByText("已完成合成会话链路检查。")).toBeVisible();
  expect(chat).toMatchObject({ patientId: "SYN-P-0002", encounterId: "ENC-B-02", sessionId: "B0000002-session", message: "请整理本次合成复诊的问题。" });
  expect(chat).not.toHaveProperty("scenario");

  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录临床工作台" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "合成患者 B" })).not.toBeVisible();
});
