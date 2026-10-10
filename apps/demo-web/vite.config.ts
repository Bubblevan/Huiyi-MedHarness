import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const gatewayPort = process.env.HUIYI_DEMO_GATEWAY_PORT ?? env.HUIYI_DEMO_GATEWAY_PORT ?? "8320";
  const webPort = process.env.HUIYI_DEMO_WEB_PORT ?? "5173";
  return {
  plugins: [react()],
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
