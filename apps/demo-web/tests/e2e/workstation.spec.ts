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
