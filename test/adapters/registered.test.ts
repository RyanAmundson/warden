import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { adapters } from "../../src/runner/run.js";

it("every registered adapter runs the shared conformance suite", () => {
  const missing = [...adapters.keys()].filter((id) => {
    const file = join(import.meta.dirname, `${id}.test.ts`);
    return !existsSync(file) || !new RegExp(`conformance\\(\\s*${id}Adapter\\b`).test(readFileSync(file, "utf8"));
  });
  expect(missing).toEqual([]);
});
