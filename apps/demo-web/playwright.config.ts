import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const repoRoot = resolve(process.cwd(), "../..");

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure", channel: "chrome" },
  webServer: [
    { command: "node services/demo-gateway/dist/server.js", cwd: repoRoot, url: "http://127.0.0.1:8320/api/health", reuseExistingServer: !process.env.CI, timeout: 30_000 },
    { command: "node node_modules/vite/bin/vite.js --host 127.0.0.1", cwd: process.cwd(), url: "http://127.0.0.1:5173", reuseExistingServer: !process.env.CI, timeout: 30_000 },
  ],
});
