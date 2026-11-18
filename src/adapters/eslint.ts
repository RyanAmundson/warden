import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { plugin } from "../../eslint-plugin/index.js";
import { pathGroups } from "../records/paths.js";
import type { Guardrail, Practice, RecordSet } from "../records/types.js";
import { type Adapter, PARSE_ERROR, type RunContext, type RunResult, type Violation } from "./types.js";

const RULES_PATH = ".warden/generated/eslint.rules.json";

export const BATCH_FILES = 500;

const ruleId = (g: Guardrail): string => g.implementation.slice(g.implementation.indexOf(":") + 1);

const ruleValue = (options: unknown): unknown =>
  options === undefined ? "error" : Array.isArray(options) ? ["error", ...options] : ["error", options];

const owner = (g: Guardrail, set: RecordSet): { practice?: Practice; paths: (string | string[])[] } => {
  for (const pack of set.packs) {
    for (const practice of pack.practices) {
      if (!practice.guardrails.some((x) => x.id === g.id)) continue;
      const entry = set.config.packs.find((p) => p.id === pack.id);
      return { practice, paths: pathGroups(practice.paths, entry ? entry.paths : []).map((grp) => (grp.length === 1 ? (grp[0] as string) : grp)) };
    }
  }
  return { paths: [] };
};

const wardenValue = (g: Guardrail, practice: Practice | undefined): unknown => {
  if (practice === undefined) throw new Error(`guardrail ${g.id} uses a warden rule but belongs to no practice`);
  const extra = typeof g.options === "object" && g.options !== null && !Array.isArray(g.options) ? g.options : {};
  return ["error", { practice: practice.id, statement: practice.statement, ...extra }];
};

const emit = (gs: Guardrail[], set: RecordSet): Record<string, string> => {
  const entries = gs.map((g) => {
    const { practice, paths } = owner(g, set);
    const value = ruleId(g).startsWith("warden/") ? wardenValue(g, practice) : ruleValue(g.options);
    return { files: paths, rules: { [ruleId(g)]: value } };
  });
  return { [RULES_PATH]: `${JSON.stringify({ entries }, null, 2)}\n` };
};

const run = async (gs: Guardrail[], files: string[], ctx: RunContext): Promise<RunResult[]> => {
  const { entries } = JSON.parse(await readFile(join(ctx.generatedDir, "eslint.rules.json"), "utf8"));
  const eslint = new ESLint({
    cwd: ctx.root,
    overrideConfigFile: true,
    overrideConfig: [
      { plugins: { warden: plugin } },
      { files: ["**/*.{ts,tsx,mts,cts}"], languageOptions: { parser: tseslint.parser } },
      { linterOptions: { noInlineConfig: true } },
      ...entries,
    ],
    allowInlineConfig: false,
    warnIgnored: false,
  });
  const results: ESLint.LintResult[] = [];
  let ms = 0;
  for (let i = 0; i < files.length; i += BATCH_FILES) {
    const start = performance.now();
    results.push(...(await eslint.lintFiles(files.slice(i, i + BATCH_FILES))));
    ms = Math.max(ms, performance.now() - start);
  }
  const byRule = new Map<string, Violation[]>();
  for (const g of gs) byRule.set(ruleId(g), []);
  const owner = new Map(gs.map((g) => [ruleId(g), g.id]));
  const parseErrors: Violation[] = [];
  for (const result of results) {
    for (const m of result.messages) {
      if (m.ruleId === null && m.fatal === true) {
        parseErrors.push({ guardrail: PARSE_ERROR, file: relative(ctx.root, result.filePath), line: m.line, message: m.message });
        continue;
      }
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
  const out = gs.map((g): RunResult => {
    const violations = byRule.get(ruleId(g)) as Violation[];
    return { guardrail: g.id, status: violations.length > 0 ? "fail" : "pass", violations, ms };
  });
  return parseErrors.length > 0 ? [...out, { guardrail: PARSE_ERROR, status: "fail", violations: parseErrors, ms }] : out;
};

export const eslintAdapter: Adapter = { id: "eslint", emit, run };
