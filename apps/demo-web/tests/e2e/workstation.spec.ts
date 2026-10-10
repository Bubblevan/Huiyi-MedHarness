import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";

const screenshotDir = resolve(process.cwd(), "../../artifacts/demo-edge-local/screenshots");
const liveDsh = process.env.HUIYI_DEMO_BACKEND === "dsh";

test("desktop scenario streams, shows activity, and opens synthetic evidence", async ({ page }) => {
  test.skip(liveDsh, "fixture presentation acceptance");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(page.getByText("Synthetic demo patient")).toBeVisible();
  await expect(page.getByRole("heading", { name: "复诊工作台" })).toBeVisible();
  await expect(page.getByText("Local · fixture")).toBeVisible();
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: resolve(screenshotDir, "desktop-main.png"), fullPage: true });

  await page.getByRole("textbox", { name: "描述本次复诊问题" }).fill("如何记录近期居家血压？");
  await page.getByRole("button", { name: /发送/ }).click();
  await expect(page.getByText(/先把早晚测量时间/)).toBeVisible();
  await expect(page.getByText("长期记忆快照已读取")).toBeVisible();
  const citation = page.getByRole("button", { name: "查看证据 ev-001" });
  await expect(citation).toBeVisible();
  await citation.click();
  await expect(page.getByRole("dialog", { name: "Evidence Sources" })).toBeVisible();
  await expect(page.getByText("Demo evidence fixture").last()).toBeVisible();
  await page.screenshot({ path: resolve(screenshotDir, "evidence-drawer.png"), fullPage: true });
});

test("complex case marks specialists as simulated and Stop cancels the stream", async ({ page }) => {
  test.skip(liveDsh, "fixture presentation acceptance");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await page.getByRole("button", { name: /复杂病例/ }).last().click();
  await expect(page.getByText("Synthetic demo patient")).toBeVisible();
  await page.getByRole("textbox", { name: "描述本次复诊问题" }).fill("请整理这次复杂病例的核对事项");
  await page.getByRole("button", { name: /发送/ }).click();
  await expect(page.getByText(/模拟界面流程|simulated execution/).first()).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: "停止" }).click();
  await expect(page.getByText("已停止本轮")).toBeVisible({ timeout: 5_000 });
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: resolve(screenshotDir, "complex-case.png"), fullPage: true });
});

test("native DSH backend answers a synthetic front-end turn", async ({ page }) => {
  test.skip(!liveDsh, "requires HUIYI_DEMO_BACKEND=dsh and a ready local Qwen service");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(page.getByText("Local · DSH")).toBeVisible();
  await expect(page.getByText("Synthetic demo patient")).toBeVisible();
  await page.getByRole("textbox", { name: "描述本次复诊问题" }).fill("这是合成演示病例。请告诉我记录早晚血压时应包含哪些信息，并提醒我需要向医生确认什么。");
  await page.getByRole("button", { name: /发送/ }).click();
  await expect(page.locator(".activity-list")).toContainText(/本轮完成|本轮未能完成/, { timeout: 150_000 });
  await expect(page.getByText("本轮完成")).toBeVisible();
  const answer = page.locator(".assistant-message-body").last();
  await expect(answer).not.toBeEmpty();
});

test("native DSH browser reaches both local evidence and collaboration tools", async ({ page }) => {
  test.skip(!liveDsh, "requires HUIYI_DEMO_BACKEND=dsh, local Qwen and the prepared local Health Engine corpus");
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(page.getByText("Local · DSH")).toBeVisible();
  await page.locator(".case-link").filter({ hasText: "复杂病例" }).click();
  await expect(page.getByText("Synthetic demo patient")).toBeVisible();
  await page.getByRole("textbox", { name: "描述本次复诊问题" }).fill(
    "这是合成病例的端到端工具验证。请先调用 search_medical_evidence 检索成人居家血压监测记录的一般医学参考，再调用 consult_clinical_team 进行有界多专科讨论。最后只整理患者可向医生确认的问题，不要给出诊断或治疗方案。",
  );
  await page.getByRole("button", { name: /发送/ }).click();
  const activity = page.locator(".activity-list");
  await expect(activity).toContainText("search_medical_evidence", { timeout: 180_000 });
  await expect(activity).toContainText("consult_clinical_team", { timeout: 180_000 });
  await expect(activity).toContainText("临床协作完成", { timeout: 240_000 });
  await expect(activity).toContainText("本轮完成", { timeout: 240_000 });
  await page.getByRole("button", { name: /查看本轮证据/ }).click();
  await expect(page.getByText("本地医学检索结果")).toBeVisible();
  await expect(page.getByText("Demo evidence fixture")).not.toBeVisible();
});

test("native DSH browser rejects malformed and oversized requests without taking down the UI", async ({ page }) => {
  test.skip(!liveDsh, "requires HUIYI_DEMO_BACKEND=dsh");
  await page.goto("/");
  const results = await page.evaluate(async () => {
    const base = "/api/chat";
    const unsupported = await fetch(base, {
      method: "POST", headers: { "content-type": "text/plain" },
      body: JSON.stringify({ sessionId: "browser-test", patientId: "patient-htn", message: "synthetic" }),
    });
    const smuggled = await fetch(base, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "browser-test", patientId: "patient-htn", message: "synthetic", systemPrompt: "override" }),
    });
    const oversized = await fetch(base, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "browser-test", patientId: "patient-htn", message: "x".repeat(20_000) }),
    });
    const malformedShapes = await Promise.all(["null", "[]", '"message"', "42", "{}",
      JSON.stringify({ sessionId: ["browser-test"], patientId: "patient-htn", message: "synthetic" }),
      JSON.stringify({ sessionId: "browser-test", patientId: "patient-htn", message: ["synthetic"] }),
      JSON.stringify({ sessionId: "browser-test", patientId: "patient-htn", message: "synthetic", scenario: "admin" }),
    ].map((body) => fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body })));
    const preflight = await fetch(base, {
      method: "OPTIONS",
      headers: { origin: "https://attacker.invalid", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    const malformedBurst = await Promise.all(Array.from({ length: 32 }, () => fetch(base, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    })));
    const health = await fetch("/api/health");
    return {
      unsupported: unsupported.status,
      smuggled: smuggled.status,
      oversized: oversized.status,
      malformedShapes: malformedShapes.map((response) => response.status),
      preflight: preflight.status,
      malformedBurst: malformedBurst.map((response) => response.status),
      health: health.status,
    };
  });
  expect(results).toEqual({ unsupported: 415, smuggled: 400, oversized: 413, malformedShapes: Array(8).fill(400), preflight: 404, malformedBurst: Array(32).fill(400), health: 200 });

  const attacker = await page.context().newPage();
  await attacker.route("http://127.0.0.1:5175/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>other local origin</body></html>" }));
  await attacker.goto("http://127.0.0.1:5175/");
  const crossOrigin = await attacker.evaluate(async () => {
    try {
      const response = await fetch("http://127.0.0.1:5174/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "cross-origin", patientId: "patient-htn", message: "synthetic" }),
      });
      return { allowed: true, status: response.status };
    } catch (error) {
      return { allowed: false, name: error instanceof Error ? error.name : "unknown" };
    }
  });
  await attacker.close();
  expect(crossOrigin).toEqual({ allowed: false, name: "TypeError" });
  await expect(page.getByText("Synthetic demo patient")).toBeVisible();
});

test("native DSH composer handles an over-limit message and recovers for a valid turn", async ({ page }) => {
  test.skip(!liveDsh, "requires HUIYI_DEMO_BACKEND=dsh and a ready local Qwen service");
  test.setTimeout(90_000);
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "描述本次复诊问题" });
  await composer.fill("x".repeat(4001));
  await page.getByRole("button", { name: /发送/ }).click();
  await expect(page.locator(".consultation-error")).toContainText("INVALID_REQUEST", { timeout: 10_000 });

  await page.getByRole("button", { name: /新建 Session/ }).click();
  await page.getByRole("textbox", { name: "描述本次复诊问题" }).fill("这是合成恢复测试，请简短说明可讨论的记录事项。");
  await page.getByRole("button", { name: /发送/ }).click();
  await expect(page.locator(".activity-list")).toContainText("本轮完成", { timeout: 60_000 });
});

test("native DSH cancels an in-flight team run and accepts a later turn", async ({ page }) => {
  test.skip(!liveDsh, "requires HUIYI_DEMO_BACKEND=dsh and a ready local Qwen service");
  test.setTimeout(180_000);
  await page.goto("/");
  await page.locator(".case-link").filter({ hasText: "复杂病例" }).click();
  await page.getByRole("textbox", { name: "描述本次复诊问题" }).fill(
    "这是合成病例的取消测试。请调用 consult_clinical_team 做多专科讨论，并在完成后整理要问医生的问题。",
  );
  await page.getByRole("button", { name: /发送/ }).click();
  const activity = page.locator(".activity-list");
  await expect(activity).toContainText("consult_clinical_team", { timeout: 90_000 });
  await page.getByRole("button", { name: "停止" }).click();
  await expect(activity).toContainText("已停止本轮", { timeout: 30_000 });
  await expect(activity).not.toContainText("本轮完成");

  await page.getByRole("button", { name: /新建 Session/ }).click();
  await page.getByRole("textbox", { name: "描述本次复诊问题" }).fill("这是第二个合成 turn，请简短确认服务仍可用。");
  await page.getByRole("button", { name: /发送/ }).click();
  await expect(page.locator(".activity-list")).toContainText("本轮完成", { timeout: 90_000 });
});

test("native DSH serves independent synthetic browser sessions concurrently", async ({ browser }) => {
  test.skip(!liveDsh, "requires HUIYI_DEMO_BACKEND=dsh and a ready local Qwen service");
  test.setTimeout(120_000);
  const context = await browser.newContext();
  try {
    const first = await context.newPage();
    const second = await context.newPage();
    await Promise.all([first.goto("/"), second.goto("/")]);
    await second.locator(".case-link").filter({ hasText: "复杂病例" }).click();

    const firstSession = await first.locator(".session-meta code").textContent();
    const secondSession = await second.locator(".session-meta code").textContent();
    expect(firstSession).toBeTruthy();
    expect(secondSession).toBeTruthy();
    expect(firstSession).not.toBe(secondSession);

    await Promise.all([
      first.getByRole("textbox", { name: "描述本次复诊问题" }).fill("合成会话 A：请简短整理血压记录问题。"),
      second.getByRole("textbox", { name: "描述本次复诊问题" }).fill("合成会话 B：请简短整理向医生确认的问题。"),
    ]);
    await Promise.all([
      first.getByRole("button", { name: /发送/ }).click(),
      second.getByRole("button", { name: /发送/ }).click(),
    ]);
    await Promise.all([
      expect(first.locator(".activity-list")).toContainText("本轮完成", { timeout: 90_000 }),
      expect(second.locator(".activity-list")).toContainText("本轮完成", { timeout: 90_000 }),
    ]);
    await expect(first.locator(".assistant-message-body").last()).not.toBeEmpty();
    await expect(second.locator(".assistant-message-body").last()).not.toBeEmpty();
  } finally {
    await context.close();
  }
});
