import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectedOutputs } from "../compiler/compile.js";
import { LOCK_FORMAT, LOCK_PATH, type Lock, canonicalJson, readLock, sha256 } from "../compiler/lock.js";
import { RecordError, readText } from "../records/load.js";
import { type BenchSettings, type Kind, type RecordSet, kindRank } from "../records/types.js";
import { BASELINE_PATH, type Baseline, carryRenames, projectWideEntries, readBaseline } from "./baseline.js";
import { changeSignatures, changesSinceMergeBase, containsHead, historyOf, lastCommittedText, showAtMergeBase } from "./changed.js";

export interface Tamper {
  file: string;
  detail: "missing-lock" | "leftover-temp" | "hooks-disabled" | "generated-drift" | "source-drift" | "lock-drift" | "loosened" | "removed" | "base-moved" | "weakened-kind" | "unsigned" | "untrusted-signature";
  guardrail?: string;
  was?: string;
  sources?: string[];
}

const SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"];

const SIGNERS_PATH = ".warden/allowed_signers";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const tempsIn = (root: string, dir: string, recursive: boolean): string[] => {
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) return recursive ? tempsIn(root, path, true) : [];
    return entry.name.includes(".warden-tmp-") ? [path] : [];
  });
};

const leftoverTemps = (root: string, lock: Lock | undefined): string[] => {
  const parents = Object.keys(lock?.generated ?? {}).map((key) => dirname(key));
  const shallow = [...new Set(parents)].flatMap((dir) => tempsIn(root, dir, false));
  return [...new Set([...tempsIn(root, ".warden", true), ...shallow])].sort();
};

const readJson = async (root: string, file: string): Promise<unknown> => {
  const text = await readText(join(root, file));
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new RecordError(file, "", `not valid JSON: ${(cause as Error).message}. Next action: fix the JSON in ${file}, then run warden check again`);
  }
};

const parsedOrSkipped = (text: string): unknown[] => {
  try {
    return [JSON.parse(text)];
  } catch {
    return [];
  }
};

export function recordedBases(root: string): string[] {
  return historyOf(root, LOCK_PATH).flatMap((text) =>
    parsedOrSkipped(text).flatMap((lock) => {
      const value = (lock as { config?: { base?: unknown } } | null)?.config?.base;
      return typeof value === "string" ? [value] : [];
    }),
  );
}

export function readBaseLock(root: string, base: string): Lock | undefined {
  const text = showAtMergeBase(root, base, LOCK_PATH);
  if (text === undefined) return undefined;
  let before: Lock;
  try {
    before = JSON.parse(text) as Lock;
  } catch (cause) {
    throw new RecordError(
      LOCK_PATH,
      "",
      `at the merge base with ${base} is not valid JSON (${(cause as Error).message}). Next action: run warden compile on ${base} and commit the lock there, merge ${base} into this branch, then run warden check --base ${base} again.`,
    );
  }
  if ((before.format ?? 0) > LOCK_FORMAT) {
    throw new RecordError(
      LOCK_PATH,
      "/format",
      `the lock at the merge base with ${base} has format ${before.format}; this Warden reads formats up to ${LOCK_FORMAT}. Next action: install Warden ${before.warden}, the release that wrote the lock on ${base}, then run warden check --base ${base} again.`,
    );
  }
  return before;
}

const benchLoosened = (was: BenchSettings | undefined, now: BenchSettings | undefined): boolean =>
  was !== undefined &&
  (now === undefined || now.linearMax > was.linearMax || now.constantMs > was.constantMs || now.minMarginalMs > was.minMarginalMs || now.maxFiles < was.maxFiles);

const loosened = (root: string, base: string, lock: Lock): Tamper[] => {
  const before = readBaseLock(root, base);
  if (before === undefined) return [];
  const changed = (was: unknown, now: unknown): boolean => was !== undefined && was !== now;
  const found: Tamper[] = [];
  const tiers = Object.keys(lock.config.tierBudgetMs) as (keyof Lock["config"]["tierBudgetMs"])[];
  const committed = lastCommittedText(root, LOCK_PATH);
  const heads = [lock, ...((committed === undefined ? [] : parsedOrSkipped(committed)) as Lock[])];
  const restoring = base === recordedBases(root).at(-1) && containsHead(root, base);
  if (heads.some((l) => changed(before.config.base, l.config?.base) && !(restoring && l.config?.base === base))) found.push({ file: LOCK_PATH, detail: "base-moved" });
  if (
    changed(before.config.project, lock.config.project) ||
    lock.config.loopBreakerRepeats > before.config.loopBreakerRepeats ||
    benchLoosened(before.config.bench, lock.config.bench) ||
    tiers.some((t) => lock.config.tierBudgetMs[t] > before.config.tierBudgetMs[t])
  ) {
    found.push({ file: LOCK_PATH, detail: "loosened" });
  }
  const covers = (now: string[], was: string[]): boolean => was.every((x) => now.includes(x));
  const widens = (now: string, was: string): boolean => {
    const [a, b] = [now.split(/(\{[^{}]*\})/), was.split(/(\{[^{}]*\})/)];
    if (a.length !== b.length) return false;
    return a.every((part, i) => {
      const old = b[i] as string;
      if (part === old) return true;
      if (i % 2 === 0) return false;
      const members = new Set(part.slice(1, -1).split(","));
      return old.slice(1, -1).split(",").every((m) => members.has(m));
    });
  };
  const pathsCover = (now: string[], was: string[]): boolean => was.every((x) => now.some((y) => widens(y, x)));
  for (const [id, g] of Object.entries(before.guardrails)) {
    const now = lock.guardrails[id];
    const known = now !== undefined && g.kind !== undefined;
    const stronger = known && g.kind === "instruction" && kindRank(now.kind as Kind) < kindRank(g.kind as Kind);
    const cmdLintToRuntime = known && g.kind === "lint" && now.kind === "runtime" && g.implementation.startsWith("cmd:");
    if (known && !cmdLintToRuntime && kindRank(now.kind as Kind) > kindRank(g.kind as Kind)) found.push({ file: LOCK_PATH, detail: "weakened-kind", guardrail: id, was: g.kind });
    const weaker =
      now === undefined ||
      now.budgetMs > g.budgetMs ||
      !covers(now.runs, g.runs) ||
      !pathsCover(now.paths, g.paths) ||
      (!stronger && (now.implementation !== g.implementation || canonicalJson(now.options) !== canonicalJson(g.options)));
    if (weaker) found.push({ file: LOCK_PATH, detail: "loosened", guardrail: id });
  }
  const { renames } = changesSinceMergeBase(root, base);
  const baseBaseline = carryRenames(JSON.parse(showAtMergeBase(root, base, BASELINE_PATH) ?? "{}") as Baseline, renames);
  for (const [id, entries] of Object.entries(carryRenames(readBaseline(root), renames))) {
    if (id in lock.guardrails && !(id in before.guardrails)) continue;
    for (const [file, n] of Object.entries(entries)) {
      if (!existsSync(join(root, file))) continue;
      if (n > (baseBaseline[id]?.[file] ?? 0)) found.push({ file: BASELINE_PATH, detail: "loosened", guardrail: id });
    }
  }
  const sources = Object.keys({ ...before.sources, ...lock.sources }).filter((k) => k.startsWith(".warden/") && before.sources?.[k] !== lock.sources[k]);
  return sources.length === 0 ? found : found.map((t) => (t.file === LOCK_PATH && t.detail === "loosened" ? { ...t, sources } : t));
};

const unsignedChanges = (root: string, base: string): Tamper[] => {
  const signers = showAtMergeBase(root, base, SIGNERS_PATH);
  if (signers === undefined) return [];
  const dir = mkdtempSync(join(tmpdir(), "warden-signers-"));
  try {
    writeFileSync(join(dir, "allowed_signers"), signers);
    return [...changeSignatures(root, base, ".warden", join(dir, "allowed_signers"))]
      .filter(([file, status]) => file !== BASELINE_PATH && status !== "G")
      .map(([file, status]): Tamper => ({ file, detail: status === "N" ? "unsigned" : "untrusted-signature" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export async function findTampering(set: RecordSet, wardenRoot: string, base: string): Promise<Tamper[]> {
  const root = set.root;
  const lock = existsSync(join(root, LOCK_PATH)) ? readLock(root) : undefined;
  const found: Tamper[] = leftoverTemps(root, lock).map((file) => ({ file, detail: "leftover-temp" }));
  for (const file of SETTINGS_FILES) {
    const value = await readJson(root, file);
    if (isObject(value) && value.disableAllHooks === true) found.push({ file, detail: "hooks-disabled" });
  }
  if (lock === undefined) return [...found, { file: LOCK_PATH, detail: "missing-lock" }];

  const expected = await expectedOutputs(set, root, wardenRoot);
  const sources = [...new Set([...Object.keys(lock.sources), ...Object.keys(expected.lock.sources)])].sort();
  const sourceDrift = sources.filter((file) => lock.sources[file] !== expected.lock.sources[file]);
  found.push(...sourceDrift.map((file): Tamper => ({ file, detail: "source-drift" })));
  if (sourceDrift.length === 0 && canonicalJson({ ...lock, tools: null }) !== canonicalJson({ ...expected.lock, tools: null })) {
    found.push({ file: LOCK_PATH, detail: "lock-drift" });
  }

  for (const [file, hash] of Object.entries(lock.generated)) {
    const actual = await readText(join(root, file));
    if (actual === undefined || sha256(actual) !== hash) found.push({ file, detail: "generated-drift" });
  }

  found.push(...projectWideEntries(readBaseline(root)).map((guardrail): Tamper => ({ file: BASELINE_PATH, detail: "loosened", guardrail })));
  return [...found, ...loosened(root, base, lock), ...unsignedChanges(root, base)];
}
