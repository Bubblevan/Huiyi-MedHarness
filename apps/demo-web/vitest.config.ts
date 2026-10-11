import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@clinical-workstation-copy": resolve(dirname(fileURLToPath(import.meta.url)), "src/copy/clinicalWorkstation.development.ts") } },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"], setupFiles: ["./src/test-setup.ts"], css: true },
});
