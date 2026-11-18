import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import type { Guardrail, RecordSet } from "../records/types.js";
import type { Adapter, RunContext, RunResult, Violation } from "./types.js";

const RULES_PATH = ".warden/generated/eslint.rules.json";

const ruleId = (g: Guardrail): string => g.implementation.slice(g.implementation.indexOf(":") + 1);

const ruleValue = (options: unknown): unknown =>
  options === undefined ? "error" : Array.isArray(options) ? ["error", ...options] : ["error", options];

const pathsFor = (g: Guardrail, set: RecordSet): string[] => {
  for (const pack of set.packs) {
    for (const practice of pack.practices) {
      if (!practice.guardrails.some((x) => x.id === g.id)) continue;
      if (practice.paths.length > 0) return practice.paths;
      const entry = set.config.packs.find((p) => p.id === pack.id);
      return entry ? entry.paths : [];
    }
  }
  return [];
};

const emit = (gs: Guardrail[], set: RecordSet): Record<string, string> => {
  const entries = gs.map((g) => ({
    files: pathsFor(g, set),
    rules: { [ruleId(g)]: ruleValue(g.options) },
  }));
  return { [RULES_PATH]: `${JSON.stringify({ entries }, null, 2)}\n` };
};

const run = async (gs: Guardrail[], files: string[], ctx: RunContext): Promise<RunResult[]> => {
  const { entries } = JSON.parse(await readFile(join(ctx.generatedDir, "eslint.rules.json"), "utf8"));
  const eslint = new ESLint({
    cwd: ctx.root,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ["**/*.{ts,tsx,mts,cts}"], languageOptions: { parser: tseslint.parser } },
      { linterOptions: { noInlineConfig: true } },
      ...entries,
    ],
    allowInlineConfig: false,
    warnIgnored: false,
  });
  const start = performance.now();
  const results = await eslint.lintFiles(files);
  const ms = performance.now() - start;
  const byRule = new Map<string, Violation[]>();
  for (const g of gs) byRule.set(ruleId(g), []);
  const owner = new Map(gs.map((g) => [ruleId(g), g.id]));
  for (const result of results) {
    for (const m of result.messages) {
      const id = m.ruleId === null ? undefined : m.ruleId;
      const bucket = id === undefined ? undefined : byRule.get(id);
      if (bucket === undefined) {
        throw new Error(`eslint reported ${id ?? "a fatal error"} in ${result.filePath}: ${m.message}`);
      }
      bucket.push({
        guardrail: owner.get(id as string) as string,
        file: relative(ctx.root, result.filePath),
        line: m.line,
        message: m.message,
      });
    }
  }
  return gs.map((g) => {
    const violations = byRule.get(ruleId(g)) as Violation[];
    return { guardrail: g.id, status: violations.length > 0 ? "fail" : "pass", violations, ms };
  });
};

export const eslintAdapter: Adapter = { id: "eslint", emit, run };
