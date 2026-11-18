import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { expectedOutputs } from "../compiler/compile.js";
import { isWardenEntry } from "../compiler/emit.js";
import { LOCK_FORMAT, LOCK_PATH, type Lock, canonicalJson, readLock, sha256 } from "../compiler/lock.js";
import { RecordError, readText } from "../records/load.js";
import type { RecordSet } from "../records/types.js";
import { BASELINE_PATH, type Baseline, carryRenames, projectWideEntries, readBaseline } from "./baseline.js";
import { changesSinceMergeBase, showAtMergeBase } from "./changed.js";

export interface Tamper {
  file: string;
  detail: "missing-lock" | "leftover-temp" | "hooks-disabled" | "generated-drift" | "source-drift" | "lock-drift" | "loosened" | "removed";
  guardrail?: string;
}

const SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"];

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
  const parents = Object.keys(lock?.generated ?? {}).map((key) => dirname(key.split("#")[0] as string));
  const shallow = [...new Set([".claude", ...parents])].flatMap((dir) => tempsIn(root, dir, false));
  return [...new Set([...tempsIn(root, ".warden", true), ...shallow])].sort();
};

const readJson = async (root: string, file: string): Promise<unknown> => {
  const text = await readText(join(root, file));
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new RecordError(file, "", `not valid JSON: ${(cause as Error).message}`);
  }
};

const extractOwned = (settings: unknown, owned: Record<string, unknown[]>): Record<string, unknown[]> =>
  Object.fromEntries(
    Object.entries(owned).map(([path, entries]) => {
      const ours = new Set(entries.map(canonicalJson));
      let node: unknown = settings;
      for (const key of path.split(".")) node = isObject(node) ? node[key] : undefined;
      return [path, Array.isArray(node) ? node.filter((e) => isWardenEntry(e, ours)) : []];
    }),
  );

const loosened = (root: string, base: string, lock: Lock): Tamper[] => {
  const text = showAtMergeBase(root, base, LOCK_PATH);
  if (text === undefined) return [];
  const before = JSON.parse(text) as Lock;
  if ((before.format ?? 0) > LOCK_FORMAT) {
    throw new RecordError(
      LOCK_PATH,
      "/format",
      `the lock at the merge base with ${base} has format ${before.format}; this Warden reads formats up to ${LOCK_FORMAT}. Next action: update this project's Warden to the release that wrote the lock on ${base}, then run warden check again.`,
    );
  }
  const changed = (was: unknown, now: unknown): boolean => was !== undefined && was !== now;
  const found: Tamper[] = [];
  const tiers = Object.keys(lock.config.tierBudgetMs) as (keyof Lock["config"]["tierBudgetMs"])[];
  if (
    changed(before.config.base, lock.config.base) ||
    changed(before.config.project, lock.config.project) ||
    lock.config.loopBreakerRepeats > before.config.loopBreakerRepeats ||
    tiers.some((t) => lock.config.tierBudgetMs[t] > before.config.tierBudgetMs[t])
  ) {
    found.push({ file: LOCK_PATH, detail: "loosened" });
  }
  const covers = (now: string[], was: string[]): boolean => was.every((x) => now.includes(x));
  for (const [id, g] of Object.entries(before.guardrails)) {
    const now = lock.guardrails[id];
    const weaker =
      now === undefined ||
      changed(g.kind, now.kind) ||
      now.budgetMs > g.budgetMs ||
      !covers(now.runs, g.runs) ||
      !covers(now.paths, g.paths) ||
      now.implementation !== g.implementation ||
      canonicalJson(now.options) !== canonicalJson(g.options);
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
  return found;
};

export async function findTampering(set: RecordSet, wardenRoot: string, base: string): Promise<Tamper[]> {
  const root = set.root;
  const lock = existsSync(join(root, LOCK_PATH)) ? readLock(root) : undefined;
  const found: Tamper[] = leftoverTemps(root, lock).map((file) => ({ file, detail: "leftover-temp" }));
  const settings = new Map<string, unknown>();
  for (const file of SETTINGS_FILES) {
    const value = await readJson(root, file);
    settings.set(file, value);
    if (isObject(value) && value.disableAllHooks === true) found.push({ file, detail: "hooks-disabled" });
  }
  if (lock === undefined) return [...found, { file: LOCK_PATH, detail: "missing-lock" }];

  const expected = await expectedOutputs(set, root, wardenRoot);
  const sources = [...new Set([...Object.keys(lock.sources), ...Object.keys(expected.lock.sources)])].sort();
  const sourceDrift = sources.filter((file) => lock.sources[file] !== expected.lock.sources[file]);
  found.push(...sourceDrift.map((file): Tamper => ({ file, detail: "source-drift" })));
  if (sourceDrift.length === 0 && canonicalJson(lock) !== canonicalJson(expected.lock)) {
    found.push({ file: LOCK_PATH, detail: "lock-drift" });
  }

  for (const [key, hash] of Object.entries(lock.generated)) {
    const at = key.indexOf("#");
    const file = at === -1 ? key : key.slice(0, at);
    const actual =
      at === -1
        ? await readText(join(root, file))
        : canonicalJson(extractOwned(settings.has(file) ? settings.get(file) : await readJson(root, file), expected.owned[file] ?? {}));
    if (actual === undefined || sha256(actual) !== hash) found.push({ file, detail: "generated-drift" });
  }

  found.push(...projectWideEntries(readBaseline(root)).map((guardrail): Tamper => ({ file: BASELINE_PATH, detail: "loosened", guardrail })));
  return [...found, ...loosened(root, base, lock)];
}
