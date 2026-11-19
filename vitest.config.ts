import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["packs/**", "test/fixtures/**", "node_modules/**"],
    maxWorkers: 2,
    setupFiles: ["test/setup.ts"],
  },
});
