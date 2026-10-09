import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const repoRoot = resolve(process.cwd(), "../..");
const gatewayPort = process.env.HUIYI_DEMO_GATEWAY_PORT ?? "8320";
const webPort = process.env.HUIYI_DEMO_WEB_PORT ?? "5173";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${webPort}`, trace: "retain-on-failure" },
  webServer: [
    { command: "node services/demo-gateway/dist/services/demo-gateway/src/server.js", cwd: repoRoot, url: `http://127.0.0.1:${gatewayPort}/api/health`, reuseExistingServer: !process.env.CI, timeout: 30_000 },
    { command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${webPort}`, cwd: process.cwd(), url: `http://127.0.0.1:${webPort}`, reuseExistingServer: !process.env.CI, timeout: 30_000 },
  ],
});
