import { afterEach, describe, expect, it, vi } from "vitest";
import { eslintAdapter } from "../../src/adapters/eslint.js";
import type { Guardrail, RecordSet } from "../../src/records/types.js";
import { runGuardrails } from "../../src/runner/run.js";

const g: Guardrail = { id: "g", kind: "legacy", runs: ["edit"], budgetMs: 100, version: 1, implementation: "nope:x", mustFail: "a", mustPass: "b" };

const set: RecordSet = {
  root: ".",
  config: {} as never,
  packs: [{ id: "p", file: "/w/.warden/packs/p/pack.yaml", layer: 0, terms: [], capabilities: [], practices: [{ id: "x", pack: "p", statement: "s", terms: [], paths: [], conflictsWith: [], guardrails: [g] }] }],
};

describe("runGuardrails", () => {
  it("an unknown adapter is refused with the shared finding's message and pack file", async () => {
    await expect(runGuardrails(set, [g], [], { root: ".", generatedDir: "" })).rejects.toMatchObject({
      file: "/w/.warden/packs/p/pack.yaml",
      pointer: "/guardrails/g/implementation",
      message: 'Guardrail g names adapter "nope", which is not registered; the known adapters are eslint, tsc, cmd, fs, graph, module, system-one, tool. Next action: set implementation to one of eslint:<...>, tsc:<...>, cmd:<...>, fs:<...>, graph:<...>, module:<...>, system-one:<...>, tool:<...> in /w/.warden/packs/p/pack.yaml, then run warden compile.',
    });
  });

  it("a Guardrail outside the record set is refused", async () => {
    const stray = { ...g, id: "stray", implementation: "cmd:true" };
    await expect(runGuardrails(set, [stray], [], { root: ".", generatedDir: "" })).rejects.toThrow("runGuardrails got Guardrail stray, which is not in the record set");
  });

  describe("a shared ESLint pass", () => {
    const lint = ["a", "b", "c"].map((id): Guardrail => ({ ...g, id, kind: "lint", implementation: `eslint:${id}` }));
    const lintSet: RecordSet = { ...set, packs: [{ ...(set.packs[0] as RecordSet["packs"][number]), practices: [{ ...(set.packs[0]?.practices[0] as RecordSet["packs"][number]["practices"][number]), guardrails: lint }] }] };
    const pass = (ms: number) =>
      vi.spyOn(eslintAdapter, "run").mockResolvedValue(
        lint.map((x) => ({ guardrail: x.id, status: "pass" as const, violations: [], ms, shared: { id: "eslint", guardrails: 3, members: ["a", "b", "c"] } })),
      );

    afterEach(() => vi.restoreAllMocks());

    it("is judged against the sum of the budgets of the Guardrails in it", async () => {
      pass(250);
      expect((await runGuardrails(lintSet, lint, [], { root: ".", generatedDir: "" })).map((r) => r.overBudget)).toEqual([false, false, false]);
      vi.restoreAllMocks();
      pass(350);
      const over = await runGuardrails(lintSet, lint, [], { root: ".", generatedDir: "" });
      expect(over.map((r) => r.overBudget)).toEqual([true, true, true]);
      expect(over.map((r) => r.shared?.budgetMs)).toEqual([300, 300, 300]);
    });
  });
});
