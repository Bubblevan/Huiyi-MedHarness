import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.HUIYI_EVAL_WEB_PORT ?? "5175");
const includeGatewayFlow = process.env.HUIYI_EVAL_BROWSER_GATEWAY === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: includeGatewayFlow
    ? process.env.HUIYI_EVAL_BROWSER_CHAT === "1" ? "clinical-evaluation-gateway.spec.ts" : "clinical-evaluation*.spec.ts"
    : "clinical-evaluation.spec.ts",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  // A live Luna run shares the local model bridge and Health Engine; keep its browser worker serial.
  workers: process.env.HUIYI_EVAL_BROWSER_CHAT === "1" ? 1 : undefined,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    trace: process.env.HUIYI_EVAL_BROWSER_CHAT === "1" ? "off" : "retain-on-failure",
    ...(process.env.HUIYI_EVAL_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.HUIYI_EVAL_CHROMIUM_PATH } } : {}),
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --mode clinical-evaluation`,
    cwd: process.cwd(),
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
