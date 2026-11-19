import { defineConfig } from "vitest/config";

const exclude = ["packs/**", "test/fixtures/**", "node_modules/**"];

export default defineConfig({
  test: {
    maxWorkers: 2,
    setupFiles: ["test/setup.ts"],
    projects: [
      { extends: true, test: { name: "unit", include: ["test/**/*.test.ts"], exclude: [...exclude, "test/**/*.scaling.test.ts"], sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: "scaling", include: ["test/**/*.scaling.test.ts"], exclude, fileParallelism: false, maxWorkers: 1, sequence: { groupOrder: 1 } } },
    ],
  },
});
