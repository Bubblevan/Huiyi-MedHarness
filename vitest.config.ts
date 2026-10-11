import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { preserveSymlinks: true },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
