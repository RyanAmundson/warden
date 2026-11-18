import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expectedOutputs } from "../compiler/compile.js";
import { isWardenEntry } from "../compiler/emit.js";
import { LOCK_PATH, type Lock, canonicalJson, readLock, sha256 } from "../compiler/lock.js";
import { RecordError, readText } from "../records/load.js";
import type { RecordSet } from "../records/types.js";
import { BASELINE_PATH, type Baseline, readBaseline } from "./baseline.js";
import { showAtBase } from "./changed.js";

export interface Tamper {
  file: string;
  detail: "missing-lock" | "leftover-temp" | "hooks-disabled" | "generated-drift" | "source-drift" | "lock-drift" | "loosened";
  guardrail?: string;
}

const SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const leftoverTemps = (root: string, dir = ""): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".git" ? [] : leftoverTemps(root, path);
    return entry.name.includes(".warden-tmp-") ? [path] : [];
  });

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
  const text = showAtBase(root, base, LOCK_PATH);
  if (text === undefined) return [];
  const before = JSON.parse(text) as Lock;
  const found: Tamper[] = [];
  for (const [id, g] of Object.entries(before.guardrails)) {
    const now = lock.guardrails[id];
    if (now === undefined || now.budgetMs > g.budgetMs) found.push({ file: LOCK_PATH, detail: "loosened", guardrail: id });
  }
  const baseBaseline = JSON.parse(showAtBase(root, base, BASELINE_PATH) ?? "{}") as Baseline;
  for (const [id, entries] of Object.entries(readBaseline(root))) {
    if (id in lock.guardrails && !(id in before.guardrails)) continue;
    for (const [file, n] of Object.entries(entries)) {
      if (n > (baseBaseline[id]?.[file] ?? 0)) found.push({ file: BASELINE_PATH, detail: "loosened", guardrail: id });
    }
  }
  return found;
};

export async function findTampering(set: RecordSet, wardenRoot: string, base: string): Promise<Tamper[]> {
  const root = set.root;
  const found: Tamper[] = leftoverTemps(root).map((file) => ({ file, detail: "leftover-temp" }));
  const settings = new Map<string, unknown>();
  for (const file of SETTINGS_FILES) {
    const value = await readJson(root, file);
    settings.set(file, value);
    if (isObject(value) && value.disableAllHooks === true) found.push({ file, detail: "hooks-disabled" });
  }
  if (!existsSync(join(root, LOCK_PATH))) return [...found, { file: LOCK_PATH, detail: "missing-lock" }];

  const lock = readLock(root);
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

  return [...found, ...loosened(root, base, lock)];
}
