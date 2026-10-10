import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const appEnvironment = (env.VITE_APP_ENV ?? mode).trim().toLowerCase();
  const isProduction = appEnvironment === "production";
  const gatewayPort = process.env.HUIYI_DEMO_GATEWAY_PORT ?? env.HUIYI_DEMO_GATEWAY_PORT ?? "8320";
  const webPort = process.env.HUIYI_DEMO_WEB_PORT ?? "5173";
  return {
  plugins: [react(), {
    name: "huiyi-environment-copy",
    transformIndexHtml(html) {
      const title = isProduction ? "Huiyi MedHarness · 临床工作台" : "Huiyi MedHarness · Demo Workstation";
      const description = isProduction
        ? "Huiyi MedHarness clinical workflow workstation"
        : "Huiyi MedHarness synthetic local demonstration workstation";
      return html
        .replaceAll("__HUIYI_PAGE_TITLE__", title)
        .replaceAll("__HUIYI_PAGE_DESCRIPTION__", description);
    },
  }],
  envDir: repoRoot,
  envPrefix: ["VITE_", "HUIYI_DEMO_"],
  server: {
    host: "127.0.0.1",
    port: Number(webPort),
    strictPort: true,
    cors: false,
    proxy: { "/api": { target: `http://127.0.0.1:${gatewayPort}`, changeOrigin: false } },
  },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
  };
});
