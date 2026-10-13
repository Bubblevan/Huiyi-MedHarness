import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const appEnvironment = (["clinical-evaluation", "production", "edge"].includes(mode) ? mode : env.VITE_APP_ENV ?? mode).trim().toLowerCase();
  const isProduction = ["production", "clinical-evaluation", "edge"].includes(appEnvironment);
  const copyModule = resolve(repoRoot, `apps/demo-web/src/copy/clinicalWorkstation.${isProduction ? "production" : "development"}.ts`);
  const publicApiBase = appEnvironment === "edge" ? "/api" : (process.env.HUIYI_DEMO_API_BASE ?? env.HUIYI_DEMO_API_BASE ?? "/api").trim();
  const gatewayPort = process.env.HUIYI_DEMO_GATEWAY_PORT ?? env.HUIYI_DEMO_GATEWAY_PORT ?? "8320";
  const webPort = process.env.HUIYI_DEMO_WEB_PORT ?? "5173";
  return {
  plugins: [react(), {
    name: "huiyi-environment-copy",
    transformIndexHtml(html) {
      const title = "慧宜临床辅助工作台";
      const description = isProduction
        ? "恩施慧宜眼科医院临床辅助工作台"
        : "慧宜临床工作流模拟体验（仅使用模拟病例）";
      return html
        .replaceAll("__HUIYI_PAGE_TITLE__", title)
        .replaceAll("__HUIYI_PAGE_DESCRIPTION__", description);
    },
  }],
    envDir: repoRoot,
    envPrefix: "VITE_",
    define: {
      __HUIYI_CLINICAL_EVALUATION__: JSON.stringify(appEnvironment === "clinical-evaluation"),
      __HUIYI_EDGE_GATEWAY__: JSON.stringify(appEnvironment === "edge"),
      __HUIYI_PRODUCTION_BUILD__: JSON.stringify(isProduction),
      "import.meta.env.HUIYI_DEMO_API_BASE": JSON.stringify(publicApiBase),
    },
    resolve: { alias: [{ find: "@clinical-workstation-copy", replacement: copyModule }] },
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
