import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ESLint } from "eslint";
import { afterAll, describe, expect, it, vi } from "vitest";
import { BATCH_FILES, eslintAdapter } from "../../src/adapters/eslint.js";
import { PARSE_ERROR } from "../../src/adapters/types.js";
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
    project: "p",
    base: "main",
    packs: [{ id: "core", paths: ["src/**/*.ts"] }],
    tierBudgetMs: { edit: 1000, commit: 1000, boundary: 1000 },
    loopBreakerRepeats: 3,
  },
  packs: [
    {
      id: "core",
      file: "packs/core/pack.yaml",
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
  it("returns a parse error as a violation", async () => {
    const g = guardrail("no-debugger", "eslint:no-debugger");
    await conformance(eslintAdapter, resolve(fixtures, "parse-error"), [g], setFor(g), ["src/a.ts"], [
      { guardrail: PARSE_ERROR, file: "src/a.ts", line: 2, message: "Parsing error: Variable declaration expected." },
    ]);
  });

  it("eslint conformance: inline disables are ignored", async () => {
    const g = guardrail("no-debugger", "eslint:no-debugger");
    await conformance(eslintAdapter, resolve(fixtures, "debugger"), [g], setFor(g), ["src/a.ts"], [
      { guardrail: "no-debugger", file: "src/a.ts", line: 2, endLine: 2, message: "Unexpected 'debugger' statement." },
    ]);
  });

  it("eslint passes options through", async () => {
    const g = guardrail("shallow", "eslint:max-depth", [{ max: 1 }]);
    await conformance(eslintAdapter, resolve(fixtures, "nested"), [g], setFor(g), ["src/a.ts"], [
      {
        guardrail: "shallow",
        file: "src/a.ts",
        line: 3,
        endLine: 5,
        message: "Blocks are nested too deeply (2). Maximum allowed is 1.",
      },
    ]);
  });

  it("emits byte-identical output from different roots", () => {
    const g = guardrail("shallow", "eslint:max-depth", [{ max: 1 }]);
    const a = eslintAdapter.emit([g], { ...setFor(g), root: "/tmp/one" });
    const b = eslintAdapter.emit([g], { ...setFor(g), root: "/tmp/two" });
    expect(Object.keys(a)).toEqual([".warden/generated/eslint.rules.json"]);
    expect(a).toEqual(b);
  });

  it("lints in batches of at most 500 files", async () => {
    const g = guardrail("no-debugger", "eslint:no-debugger");
    const root = await mkdtemp(join(tmpdir(), "warden-batch-"));
    try {
      const files = Array.from({ length: BATCH_FILES + 1 }, (_, i) => `src/f${i}.ts`);
      await mkdir(join(root, "src"));
      await Promise.all(files.map((f) => writeFile(join(root, f), "debugger;\n")));
      for (const [path, content] of Object.entries(eslintAdapter.emit([g], { ...setFor(g), root }))) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), content);
      }
      const spy = vi.spyOn(ESLint.prototype, "lintFiles");
      const [r] = await eslintAdapter.run([g], files, { root, generatedDir: join(root, ".warden/generated") });
      expect(spy.mock.calls.map((c) => [c[0]].flat().length)).toEqual([BATCH_FILES, 1]);
      expect(r?.violations).toHaveLength(BATCH_FILES + 1);
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a pass takes the sum of its batch times and is marked shared by every Guardrail in it", async () => {
    const a = guardrail("a", "eslint:no-debugger");
    const b = guardrail("b", "eslint:no-var");
    const root = await mkdtemp(join(tmpdir(), "warden-time-"));
    try {
      const files = Array.from({ length: BATCH_FILES + 1 }, (_, i) => `src/f${i}.ts`);
      const set = setFor(a);
      (set.packs[0]?.practices[0]?.guardrails as Guardrail[]).push(b);
      for (const [path, content] of Object.entries(eslintAdapter.emit([a, b], { ...set, root }))) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), content);
      }
      vi.spyOn(ESLint.prototype, "lintFiles").mockResolvedValue([]);
      const clock = [0, 100, 100, 350];
      vi.spyOn(performance, "now").mockImplementation(() => clock.shift() as number);
      const results = await eslintAdapter.run([a, b], files, { root, generatedDir: join(root, ".warden/generated") });
      expect(results.map((r) => [r.guardrail, r.ms, r.shared])).toEqual([
        ["a", 350, { id: "eslint", guardrails: 2, members: ["a", "b"] }],
        ["b", 350, { id: "eslint", guardrails: 2, members: ["a", "b"] }],
      ]);
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emit refuses two Guardrails that share a plugin rule", () => {
    const a = guardrail("a", "eslint:warden/no-comments");
    const b = guardrail("b", "eslint:warden/no-comments");
    const set = setFor(a);
    (set.packs[0]?.practices[0]?.guardrails as Guardrail[]).push(b);
    expect(() => eslintAdapter.emit([a, b], set)).toThrow("ESLint rule warden/no-comments is already the implementation of Guardrail a, and a plugin rule carries one Practice. Next action: remove Guardrail b from packs/core/pack.yaml, then run warden compile.");
  });

  it("two Guardrails share one core rule, each with its own options and its own violations", async () => {
    const a = guardrail("shallow", "eslint:max-depth", [{ max: 1 }]);
    const b = guardrail("deep", "eslint:max-depth", [{ max: 5 }]);
    const set = setFor(a);
    (set.packs[0]?.practices[0]?.guardrails as Guardrail[]).push(b);
    await conformance(eslintAdapter, resolve(fixtures, "nested"), [a, b], set, ["src/a.ts"], [
      { guardrail: "shallow", file: "src/a.ts", line: 3, endLine: 5, message: "Blocks are nested too deeply (2). Maximum allowed is 1." },
    ]);
  });

  it("refuses a core rule ESLint does not have, with the next action", async () => {
    const g = { ...guardrail("x", "eslint:no-such-rule"), packDir: "/p/packs/core" };
    await expect(conformance(eslintAdapter, resolve(fixtures, "nested"), [g], setFor(g), ["src/a.ts"], [])).rejects.toThrow(
      "ESLint has no core rule no-such-rule. Next action: set implementation of Guardrail x to an ESLint core rule in /p/packs/core/pack.yaml, then run warden compile.",
    );
  });

  describe("pack-shipped rules", () => {
    const made: string[] = [];
    afterAll(async () => {
      for (const dir of made) await rm(dir, { recursive: true, force: true });
    });
    const shipped = async (code: string | undefined): Promise<string> => {
      const dir = await mkdtemp(join(tmpdir(), "warden-pack-rule-"));
      made.push(dir);
      await mkdir(join(dir, "packs/local"), { recursive: true });
      if (code !== undefined) await writeFile(join(dir, "packs/local/eslint.js"), code);
      return join(dir, "packs/local");
    };
    const rule = [
      "export default {",
      "  \"no-x\": {",
      "    meta: { type: \"problem\", schema: [{ type: \"object\" }], messages: { x: \"{{text}}\" } },",
      "    create: (context) => ({ Identifier(node) { if (node.name === \"f\") context.report({ node, messageId: \"x\", data: { text: `${context.options[0].practice} ${context.options[0].settings.word}` } }); } }),",
      "  },",
      "};",
      "",
    ].join("\n");
    const packed = (packDir: string, implementation = "eslint:local/no-x"): { g: Guardrail; set: RecordSet } => {
      const g = { ...guardrail("no-x", implementation), packDir };
      const set = setFor(g);
      set.config.packs = [{ id: "core", paths: ["src/**/*.ts"], settings: { word: "settled" } }];
      return { g, set };
    };

    it("registers a rule from the pack's eslint.js and hands it the pack's settings", async () => {
      const { g, set } = packed(await shipped(rule));
      await conformance(eslintAdapter, resolve(fixtures, "nested"), [g], set, ["src/a.ts"], [
        { guardrail: "no-x", file: "src/a.ts", line: 1, endLine: 1, message: "p1 settled" },
      ]);
    });

    it("refuses a pack that ships no eslint.js, with the file to add", async () => {
      const dir = await shipped(undefined);
      const { g, set } = packed(dir);
      await expect(conformance(eslintAdapter, resolve(fixtures, "nested"), [g], set, ["src/a.ts"], [])).rejects.toThrow(
        `pack local ships no eslint.js. Next action: add ${join(dir, "eslint.js")} whose default export maps no-x to its implementation, then run warden compile.`,
      );
    });

    it("refuses a rule the pack's eslint.js does not export", async () => {
      const dir = await shipped(rule);
      const { g, set } = packed(dir, "eslint:local/no-y");
      await expect(conformance(eslintAdapter, resolve(fixtures, "nested"), [g], set, ["src/a.ts"], [])).rejects.toThrow(
        `${join(dir, "eslint.js")} exports no no-y. Next action: add no-y to the default export of ${join(dir, "eslint.js")}, then run warden compile.`,
      );
    });

    it("refuses a rule namespaced by another pack", async () => {
      const { g, set } = packed(await shipped(rule), "eslint:other/no-x");
      await expect(conformance(eslintAdapter, resolve(fixtures, "nested"), [g], set, ["src/a.ts"], [])).rejects.toThrow("eslint:other/no-x names no code shipped by this pack. Next action: set implementation of Guardrail no-x to eslint:local/<name>");
    });
  });
});
