import { resolve } from "node:path";
import { describe, it } from "vitest";
import { eslintAdapter } from "../../src/adapters/eslint.js";
import type { Guardrail, RecordSet } from "../../src/records/types.js";
import { conformance } from "./conformance.js";

const guardrail = (id: string, implementation: string, options?: unknown): Guardrail => ({
  id,
  kind: "lint",
  runs: ["edit"],
  budgetMs: 10000,
  version: 1,
  implementation,
  mustFail: "bad",
  mustPass: "good",
  ...(options === undefined ? {} : { options }),
});

const setFor = (g: Guardrail): RecordSet => ({
  root: "",
  config: {
    warden: "0.1.0",
    project: "p",
    base: "main",
    packs: [{ id: "core", paths: ["src/**/*.ts"] }],
    tierBudgetMs: { edit: 1000, commit: 1000, boundary: 1000 },
    loopBreakerRepeats: 3,
  },
  packs: [
    {
      id: "core",
      layer: 0,
      terms: [],
      practices: [
        { id: "p1", pack: "core", statement: "s", terms: [], paths: [], conflictsWith: [], guardrails: [g] },
      ],
    },
  ],
});

const fixtures = resolve(import.meta.dirname, "../fixtures/adapters");

describe("eslint adapter", () => {
  it("eslint conformance: inline disables are ignored", async () => {
    const g = guardrail("no-debugger", "eslint:no-debugger");
    await conformance(eslintAdapter, resolve(fixtures, "debugger"), [g], setFor(g), ["src/a.ts"], [
      { guardrail: "no-debugger", file: "src/a.ts", line: 2, message: "Unexpected 'debugger' statement." },
    ]);
  });

  it("eslint passes options through", async () => {
    const g = guardrail("shallow", "eslint:max-depth", [{ max: 1 }]);
    await conformance(eslintAdapter, resolve(fixtures, "nested"), [g], setFor(g), ["src/a.ts"], [
      {
        guardrail: "shallow",
        file: "src/a.ts",
        line: 3,
        message: "Blocks are nested too deeply (2). Maximum allowed is 1.",
      },
    ]);
  });
});
