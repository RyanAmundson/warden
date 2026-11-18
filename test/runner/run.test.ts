import { describe, expect, it } from "vitest";
import { RecordError } from "../../src/records/load.js";
import { runGuardrails } from "../../src/runner/run.js";

describe("runGuardrails", () => {
  it("unknown adapter", async () => {
    const g = { id: "g", kind: "legacy" as const, runs: ["edit" as const], budgetMs: 100, version: 1, implementation: "nope:x" };
    await expect(runGuardrails([g], [], { root: ".", generatedDir: "" })).rejects.toBeInstanceOf(RecordError);
  });
});
