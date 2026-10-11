import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test } from "@playwright/test";

test("browser authenticates against the real synthetic Gateway and switches server-owned Sessions", async ({ page }) => {
  const chatEnabled = process.env.HUIYI_EVAL_BROWSER_CHAT === "1";
  if (chatEnabled) test.setTimeout(300_000);
  const username = process.env.HUIYI_EVAL_BROWSER_USER;
  const password = process.env.HUIYI_EVAL_BROWSER_PASSWORD;
  if (!username || !password) throw new Error("The Gateway browser smoke requires process-local synthetic credentials.");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录临床工作台" })).toBeVisible();
  await page.getByLabel("评测账号").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();

  const patientSelect = page.getByLabel("患者");
  await expect(patientSelect.locator("option")).toHaveCount(75);
  const firstOption = await patientSelect.locator("option").nth(0).innerText();
  const firstPatientName = firstOption.split(" · ")[0]!;
  await expect(page.getByRole("heading", { name: firstPatientName })).toBeVisible();
  const firstSession = await page.locator(".session-meta code").innerText();
  expect(firstSession).toMatch(/^[A-Za-z0-9_-]{8}$/);

  await patientSelect.selectOption({ index: 1 });
  const secondOption = await patientSelect.locator("option").nth(1).innerText();
  const secondPatientName = secondOption.split(" · ")[0]!;
  await expect(page.getByRole("heading", { name: secondPatientName })).toBeVisible();
  await expect.poll(() => page.locator(".session-meta code").innerText()).not.toBe(firstSession);
  expect(await page.locator(".session-meta code").innerText()).toMatch(/^[A-Za-z0-9_-]{8}$/);

  if (chatEnabled) {
    const resultPath = process.env.HUIYI_EVAL_BROWSER_RESULT_PATH;
    if (!resultPath) throw new Error("The model browser E2E requires a sanitized result artifact path.");
    const startedAt = Date.now();
    const chatResponsePromise = page.waitForResponse(
      (response) => response.url().endsWith("/api/chat") && response.request().method() === "POST",
      { timeout: 280_000 },
    );
    await page.locator(".composer-input").fill("请使用本地医学知识库检索高血压复诊时常见的监测项目与危险信号核对点，简要列出并附来源；说明需要医生结合完整病史判断。");
    await page.getByRole("button", { name: "发送" }).click();
    const chatResponse = await chatResponsePromise;
    expect(chatResponse.status()).toBe(200);
    const body = await chatResponse.text();
    const events = body.split(/\r?\n\r?\n/).flatMap((block) => {
      const dataLine = block.split(/\r?\n/).find((line) => line.startsWith("data: "));
      if (!dataLine) return [];
      try { return [JSON.parse(dataLine.slice(6)) as { event?: unknown; data?: Record<string, unknown> }]; }
      catch { return []; }
    });
    const runCompleted = events.some((event) => event.event === "run.completed");
    const assistantDeltaCount = events.filter((event) => event.event === "assistant.delta").length;
    const ragToolCompleted = events.some((event) => event.event === "tool.completed"
      && event.data?.tool === "search_medical_evidence" && event.data.status === "completed");
    const evidenceItems = events.filter((event) => event.event === "evidence.item");
    const knownSources = ["Textbooks", "StatPearls", "PubMed", "Wikipedia", "Huiyi"];
    const evidenceSources = [...new Set(evidenceItems.map((event) => event.data?.source)
      .filter((source): source is string => typeof source === "string" && knownSources.includes(source)))];
    expect(runCompleted).toBe(true);
    expect(assistantDeltaCount).toBeGreaterThan(0);
    expect(ragToolCompleted).toBe(true);
    expect(evidenceItems.length).toBeGreaterThan(0);
    await expect(page.locator(".assistant-message .assistant-markdown").last()).toContainText(/\S/);
    const result = {
      schemaVersion: "huiyi-clinical-browser-e2e/v1",
      createdAt: new Date().toISOString(),
      scope: "synthetic local browser -> authenticated Gateway -> DSH GPT-6-Luna -> local RAG",
      status: "passed",
      model: "gpt-6-luna",
      retrievalModel: "Qwen3-Embedding-0.6B",
      patientOptions: 75,
      patientSwitchCreatedNewSession: true,
      chatHttpStatus: chatResponse.status(),
      runCompleted,
      assistantDeltaCount,
      ragToolCompleted,
      evidenceItemCount: evidenceItems.length,
      ...(evidenceSources.length ? { evidenceSources } : {}),
      responseWallTimeMs: Date.now() - startedAt,
      rawPromptsAnswersAndEvidenceStored: false,
    };
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(`HUIYI_BROWSER_E2E_RESULT ${JSON.stringify(result)}`);
  }

  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录临床工作台" })).toBeVisible();
  await expect(page.getByLabel("患者")).toHaveCount(0);
});
