import { describe, expect, it } from "vitest";
import type { Guardrail, RecordSet } from "../../src/records/types.js";
import { runGuardrails } from "../../src/runner/run.js";

const g: Guardrail = { id: "g", kind: "legacy", runs: ["edit"], budgetMs: 100, version: 1, implementation: "nope:x", mustFail: "a", mustPass: "b" };

const set: RecordSet = {
  root: ".",
  config: {} as never,
  packs: [{ id: "p", file: "/w/.warden/packs/p/pack.yaml", layer: 0, terms: [], practices: [{ id: "x", pack: "p", statement: "s", terms: [], paths: [], conflictsWith: [], guardrails: [g] }] }],
};

describe("runGuardrails", () => {
  it("an unknown adapter is refused with the shared finding's message and pack file", async () => {
    await expect(runGuardrails(set, [g], [], { root: ".", generatedDir: "" })).rejects.toMatchObject({
      file: "/w/.warden/packs/p/pack.yaml",
      pointer: "/guardrails/g/implementation",
      message: 'Guardrail g names adapter "nope", which is not registered; the known adapters are eslint, tsc, cmd. Next action: set implementation to one of eslint:<...>, tsc:<...>, cmd:<...> in /w/.warden/packs/p/pack.yaml, then run warden compile.',
    });
  });

  it("a Guardrail outside the record set is refused", async () => {
    const stray = { ...g, id: "stray", implementation: "cmd:true" };
    await expect(runGuardrails(set, [stray], [], { root: ".", generatedDir: "" })).rejects.toThrow("runGuardrails got Guardrail stray, which is not in the record set");
  });
});
