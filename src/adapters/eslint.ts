import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import type { ESLint, Linter, Rule } from "eslint";
import { sha256 } from "../compiler/lock.js";
import { RecordError } from "../records/load.js";
import { pathGroups } from "../records/paths.js";
import type { Guardrail, Practice, RecordSet } from "../records/types.js";
import { packEntry, targetOf } from "./pack-code.js";
import { inSandbox } from "./sandbox.js";
import { type Adapter, PARSE_ERROR, type RunContext, type RunResult, type Violation } from "./types.js";

const RULES_PATH = ".warden/generated/eslint.rules.json";

export const BATCH_FILES = 500;

const isPluginRule = (rule: string): boolean => rule.includes("/");

const ruleId = (g: Guardrail): string => (isPluginRule(targetOf(g)) ? targetOf(g) : `${g.id}/${targetOf(g)}`);

const ruleValue = (options: unknown): unknown =>
  options === undefined ? "error" : Array.isArray(options) ? ["error", ...options] : ["error", options];

const owner = (g: Guardrail, set: RecordSet): { practice?: Practice; paths: (string | string[])[]; settings?: Record<string, unknown>; file?: string } => {
  for (const pack of set.packs) {
    for (const practice of pack.practices) {
      if (!practice.guardrails.some((x) => x.id === g.id)) continue;
      const entry = set.config.packs.find((p) => p.id === pack.id);
      const paths = pathGroups(practice.paths, entry ? entry.paths : []).map((grp) => (grp.length === 1 ? (grp[0] as string) : grp));
      return { practice, paths, file: pack.file, ...(entry?.settings === undefined ? {} : { settings: entry.settings }) };
    }
  }
  return { paths: [] };
};

const pluginValue = (g: Guardrail, practice: Practice | undefined, settings: Record<string, unknown> | undefined): unknown => {
  if (practice === undefined) throw new Error(`guardrail ${g.id} uses a plugin rule but belongs to no practice`);
  const extra = typeof g.options === "object" && g.options !== null && !Array.isArray(g.options) ? g.options : {};
  return ["error", { practice: practice.id, statement: practice.statement, ...(settings === undefined ? {} : { settings }), ...extra }];
};

const emit = (gs: Guardrail[], set: RecordSet): Record<string, string> => {
  const users = new Map<string, string>();
  for (const g of gs) {
    const other = users.get(ruleId(g));
    if (other !== undefined) {
      const file = owner(g, set).file ?? "";
      throw new RecordError(file, `/guardrails/${g.id}/implementation`, `ESLint rule ${ruleId(g)} is already the implementation of Guardrail ${other}, and a plugin rule carries one Practice. Next action: remove Guardrail ${g.id} from ${file}, then run warden compile.`);
    }
    users.set(ruleId(g), g.id);
    if (!isPluginRule(targetOf(g)) && (g.id === "warden" || set.packs.some((p) => p.id === g.id))) {
      const file = owner(g, set).file ?? "";
      throw new RecordError(file, `/guardrails/${g.id}/id`, `Guardrail id ${g.id} is also the ESLint namespace of a pack's rules. Next action: rename Guardrail ${g.id} in ${file}, then run warden compile.`);
    }
  }
  const entries = gs.map((g) => {
    const { practice, paths, settings } = owner(g, set);
    const value = isPluginRule(targetOf(g)) ? pluginValue(g, practice, settings) : ruleValue(g.options);
    return { files: paths, rules: { [ruleId(g)]: value } };
  });
  return { [RULES_PATH]: `${JSON.stringify({ entries }, null, 2)}\n` };
};

const NO_COMMENTS = "warden/no-comments";
const NO_SUPPRESSIONS = "warden/no-suppressions";
const BOM = /^\uFEFF/;

const annotatedLine = (lines: string[]): string | undefined => {
  let inBlock = false;
  for (const line of lines) {
    const text = line.trim();
    if (inBlock || text.startsWith("/*")) {
      inBlock = !text.slice(inBlock ? 0 : 2).includes("*/");
      continue;
    }
    if (text !== "" && !text.startsWith("//")) return line;
  }
  return undefined;
};

const joined = (before: string, after: string): string => {
  const head = before.trimEnd();
  const tail = after.trimStart();
  if (head === "") return `${before}${tail}`;
  if (tail === "" || /[([]$/.test(head) || /^[)\],;.]/.test(tail)) return `${head}${tail}`;
  return `${head} ${tail}`;
};

const hiddenRules = (removed: string): string[] => {
  const body = removed.replace(/^\/[/*]/, "").replace(/\*\/$/, "");
  const rest = /^\s*eslint-(?:disable|enable)(?:-next-line|-line)?(?=\s|$)(.*)$/s.exec(body)?.[1] ?? "";
  return (rest.split("--")[0] as string).split(",").map((r) => r.trim()).filter((r) => r !== "");
};

const HINTS: Record<string, (removed: string) => string> = {
  [NO_COMMENTS]: () => "Put any meaning in a name.",
  [NO_SUPPRESSIONS]: (removed) => {
    const named = hiddenRules(removed);
    if (named.length > 0) return `Fix the ${named.join(", ")} problem it hid.`;
    if (/@ts-(?:ignore|expect-error|nocheck)/.test(removed)) return "Fix the type error it hid.";
    return "Fix the rule it hid.";
  },
};

const rewrite = (source: string, m: Linter.LintMessage, id: string): string | undefined => {
  const hint = HINTS[id];
  if (hint === undefined) return undefined;
  const lines = source.split("\n");
  const endLine = m.endLine ?? m.line;
  const offset = (line: number, column: number): number => lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1;
  const from = offset(m.line, m.column);
  const to = offset(endLine, m.endColumn ?? (lines[endLine - 1] as string).length + 1);
  const removed = source.slice(from, to);
  if (!/^(\/\/|\/\*)/.test(removed)) return undefined;
  const before = (lines[m.line - 1] as string).slice(0, m.column - 1);
  const after = source.slice(to).split("\n")[0] as string;
  if (before.trim() === "" && after.trim() === "") {
    const annotated = id === NO_SUPPRESSIONS ? annotatedLine(lines.slice(endLine)) : undefined;
    if (annotated !== undefined) return `${annotated.trimEnd()}\n${hint(removed)}`;
    return `${endLine === m.line ? "Delete this line." : `Delete lines ${m.line} to ${endLine}.`}\n${hint(removed)}`;
  }
  return `${joined(before, after).trimEnd()}\n${hint(removed)}`;
};

const shippedDoThis = (shipped: Set<string>, id: string, message: string): string | undefined => {
  const at = message.indexOf(". ");
  return shipped.has(id.slice(0, id.indexOf("/"))) && at !== -1 ? message.slice(at + 2) : undefined;
};

const doThisFor = (doThis: string | undefined): { doThis?: string } => (doThis === undefined ? {} : { doThis });

const shippedRule = (g: Guardrail): boolean => isPluginRule(targetOf(g)) && !targetOf(g).startsWith("warden/");

interface Linted {
  results: ESLint.LintResult[];
  ms: number;
  inputShas?: ReadonlyMap<string, string>;
}

const makeLinter = async (gs: Guardrail[], entries: Linter.Config[], ctx: RunContext): Promise<{ eslint: ESLint; inputShas: Map<string, string> }> => {
  const [{ ESLint: Linting }, { default: tseslint }, { plugin }, { builtinRules }] = await Promise.all([import("eslint"), import("typescript-eslint"), import("../../eslint-plugin/index.js"), import("eslint/use-at-your-own-risk")]);
  const require = createRequire(import.meta.url);
  const espree = createRequire(require.resolve("eslint/package.json"))("espree") as { parse(source: string, options: Linter.ParserOptions): unknown };
  const workflowParser: Linter.Parser = {
    parse(source: string, options: Linter.ParserOptions) {
      return espree.parse(source, { ...options, ecmaFeatures: { ...options.ecmaFeatures, globalReturn: true } });
    },
  };
  const plugins: Record<string, ESLint.Plugin> = { warden: plugin };
  for (const g of gs) {
    const target = targetOf(g);
    if (isPluginRule(target)) continue;
    const core = builtinRules.get(target);
    if (core === undefined) {
      const file = g.packDir === undefined ? "pack.yaml" : join(g.packDir, "pack.yaml");
      throw new RecordError(file, `/guardrails/${g.id}/implementation`, `ESLint has no core rule ${target}. Next action: set implementation of Guardrail ${g.id} to an ESLint core rule in ${file}, then run warden compile.`);
    }
    plugins[g.id] = { rules: { [target]: core } };
  }
  const inputShas = new Map<string, string>();
  const processor: Linter.Processor = {
    meta: { name: "warden-input-evidence" },
    supportsAutofix: true,
    preprocess(source, filename) {
      inputShas.set(relative(ctx.root, filename), sha256(source));
      return [source];
    },
    postprocess(messages) {
      return messages.flat();
    },
  };
  const eslint = new Linting({
    cwd: ctx.root,
    overrideConfigFile: true,
    overrideConfig: [
      { plugins },
      { files: ["**/*.{ts,tsx,mts,cts}"], languageOptions: { parser: tseslint.parser } },
      { files: [".claude/workflows/**/*.mjs"], languageOptions: { parser: workflowParser } },
      { linterOptions: { noInlineConfig: true } },
      { ignores: ["!**/node_modules/"] },
      ...entries,
      ...(ctx.captureLintSource === true ? [{ processor }] : []),
    ],
    allowInlineConfig: false,
    warnIgnored: false,
    stats: true,
  });
  return { eslint, inputShas };
};

const benchmarkLinters = new WeakMap<object, ESLint>();

const lintInProcess = async (gs: Guardrail[], entries: Linter.Config[], files: string[], ctx: RunContext): Promise<Linted> => {
  const scope = ctx.captureLintSource === true ? undefined : ctx.eslintBenchmarkScope;
  let eslint = scope === undefined ? undefined : benchmarkLinters.get(scope);
  let inputShas: Map<string, string> | undefined;
  if (eslint === undefined) {
    ({ eslint, inputShas } = await makeLinter(gs, entries, ctx));
    if (scope !== undefined) benchmarkLinters.set(scope, eslint);
  }
  const results: ESLint.LintResult[] = [];
  let ms = 0;
  for (let i = 0; i < files.length; i += BATCH_FILES) {
    const start = performance.now();
    results.push(...(await eslint.lintFiles(files.slice(i, i + BATCH_FILES))));
    ms += performance.now() - start;
  }
  return { results, ms, ...(ctx.captureLintSource === true ? { inputShas } : {}) };
};

const lintInSandbox = async (gs: Guardrail[], entries: Linter.Config[], files: string[], ctx: RunContext): Promise<Linted> => {
  const codes = await Promise.all(gs.map((g) => packEntry(g, "eslint")));
  const texts = Object.fromEntries(files.map((file) => [file, readFileSync(join(ctx.root, file), "utf8")]));
  const unread = (file: string): string => {
    throw new Error(`pack ESLint rules read no files, but one asked for ${file}`);
  };
  const byPack = new Map<string, typeof codes>();
  for (const c of codes) byPack.set(c.packDir, [...(byPack.get(c.packDir) ?? []), c]);
  const start = performance.now();
  const results: ESLint.LintResult[] = [];
  for (const pack of byPack.values()) {
    const ids = new Set(pack.map((c) => `${c.namespace}/${c.name}`));
    const config = entries.filter((e) => Object.keys(e.rules ?? {}).every((r) => ids.has(r)));
    results.push(...(await inSandbox<{ results: ESLint.LintResult[] }>(pack[0] as (typeof codes)[number], { kind: "eslint", root: ctx.root, entries: pack, config, texts }, unread, ctx.signal)).results);
  }
  const ms = performance.now() - start;
  const inputShas = ctx.captureLintSource === true ? new Map(Object.entries(texts).map(([file, source]) => [file, sha256(source)])) : undefined;
  return { results, ms, ...(inputShas === undefined ? {} : { inputShas }) };
};

const run = async (gs: Guardrail[], files: string[], ctx: RunContext): Promise<RunResult[]> => {
  const all = (JSON.parse(await readFile(join(ctx.generatedDir, "eslint.rules.json"), "utf8")) as { entries: Linter.Config[] }).entries;
  const entriesFor = (subset: Guardrail[]): Linter.Config[] => {
    const owned = new Set(subset.map(ruleId));
    return all.filter((e) => Object.keys(e.rules ?? {}).every((r) => owned.has(r)));
  };
  const local = gs.filter((g) => !shippedRule(g));
  const shipped = gs.filter(shippedRule);
  const shippedNamespaces = new Set(shipped.map((g) => targetOf(g).split("/", 1)[0] as string));
  const localRun = local.length === 0 ? undefined : await lintInProcess(local, entriesFor(local), files, ctx);
  const shippedRun = shipped.length === 0 ? undefined : await lintInSandbox(shipped, entriesFor(shipped), files, ctx);
  const runs = [localRun, shippedRun].filter((r) => r !== undefined);
  const results = runs.flatMap(({ results, inputShas }) => results.map((result) => ({ result, inputShas })));
  const ms = runs.reduce((sum, r) => sum + r.ms, 0);
  const byRule = new Map<string, Violation[]>();
  for (const g of gs) byRule.set(ruleId(g), []);
  const owner = new Map(gs.map((g) => [ruleId(g), g.id]));
  const parseErrors: Violation[] = [];
  const ruleMs = new Map<string, number>();
  const judgedFiles = new Map<string, Map<string, string>>();
  for (const { result, inputShas } of results) {
    const file = relative(ctx.root, result.filePath);
    const sha = result.messages.some((m) => m.fatal === true) ? undefined : inputShas?.get(file);
    for (const pass of result.stats?.times.passes ?? []) {
      for (const [id, t] of Object.entries(pass.rules ?? {})) {
        ruleMs.set(id, (ruleMs.get(id) ?? 0) + t.total);
        if (sha === undefined) continue;
        const judged = judgedFiles.get(id) ?? new Map<string, string>();
        judged.set(file, sha);
        judgedFiles.set(id, judged);
      }
    }
    if (result.messages.length > 0 && result.source === undefined) throw new Error(`eslint returned messages for ${result.filePath} without its source`);
    const source = (result.source ?? "").replace(BOM, "");
    const suppressed = new Set(result.messages.filter((m) => m.ruleId === NO_SUPPRESSIONS).map((m) => `${m.line}:${m.column}`));
    for (const m of result.messages) {
      if (m.ruleId === NO_COMMENTS && suppressed.has(`${m.line}:${m.column}`)) continue;
      if (m.ruleId === null && m.fatal === true) {
        const parsed = { guardrail: PARSE_ERROR, file, line: m.line, message: m.message };
        if (!parseErrors.some((p) => p.file === parsed.file && p.line === parsed.line)) parseErrors.push(parsed);
        continue;
      }
      const id = m.ruleId === null ? undefined : m.ruleId;
      const bucket = id === undefined ? undefined : byRule.get(id);
      if (bucket === undefined) {
        throw new Error(`eslint reported ${id ?? "a fatal error"} in ${result.filePath}: ${m.message}`);
      }
      bucket.push({
        guardrail: owner.get(id as string) as string,
        file,
        line: m.line,
        endLine: m.endLine ?? m.line,
        message: m.message,
        ...doThisFor(rewrite(source, m, id as string) ?? shippedDoThis(shippedNamespaces, id as string, m.message)),
      });
    }
  }
  const shared = { id: "eslint", guardrails: gs.length, members: gs.map((g) => g.id) };
  const out = gs.map((g): RunResult => {
    const id = ruleId(g);
    const violations = byRule.get(id) as Violation[];
    const judged = judgedFiles.get(id);
    const inputShas = (shippedRule(g) ? shippedRun : localRun)?.inputShas;
    return { guardrail: g.id, status: violations.length > 0 ? "fail" : "pass", violations, ms, shared, ruleMs: ruleMs.get(id) ?? 0, ...(inputShas === undefined ? {} : { inputShas }), ...(judged === undefined ? {} : { judgedFiles: judged }) };
  });
  return parseErrors.length > 0 ? [...out, { guardrail: PARSE_ERROR, status: "fail", violations: parseErrors, ms, shared }] : out;
};

export const eslintAdapter: Adapter = { id: "eslint", emit, run };
