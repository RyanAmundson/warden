import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { RecordError } from "../records/load.js";
import { pathGroups } from "../records/paths.js";
import { type BenchSettings, type Kind, type ProjectConfig, type RecordSet, type Tier, benchSettings } from "../records/types.js";

export const LOCK_FORMAT = 3;

export interface Lock {
  format: number;
  warden: string;
  sources: Record<string, string>;
  tools: Record<string, string>;
  generated: Record<string, string>;
  guardrails: Record<string, LockedGuardrail>;
  config: Pick<ProjectConfig, "project" | "base" | "tierBudgetMs" | "loopBreakerRepeats"> & { bench?: BenchSettings };
}

export interface LockedGuardrail {
  kind: Kind;
  budgetMs: number;
  version: number;
  implementation: string;
  options: unknown;
  runs: Tier[];
  paths: string[];
  settings?: unknown;
  scope?: "project";
  benchmark?: "fixed-input";
}

export const TOOLS = ["eslint", "typescript-eslint", "typescript"] as const;

const wardenRequire = createRequire(import.meta.url);

export const firstLine = (text: string): string => text.split("\n")[0] as string;

const versionOf = (name: string): string => {
  try {
    return (wardenRequire(`${name}/package.json`) as { version: string }).version;
  } catch (cause) {
    throw new RecordError("", "/tools", `Warden's bundled ${name} does not load: ${firstLine((cause as Error).message)}. Next action: reinstall Warden so its bundled ${name} loads, then run warden doctor.`);
  }
};

export const bundledTools = (): Record<string, string> => Object.fromEntries(TOOLS.map((name) => [name, versionOf(name)]));

const OS_JUNK = new Set([".DS_Store", ".localized", "Thumbs.db", "desktop.ini"].map((n) => n.toLowerCase()));

export const isOsJunk = (name: string): boolean => OS_JUNK.has(name.normalize("NFKC").toLowerCase());

export const packFiles = async (base: string, dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(join(base, dir), { recursive: true, withFileTypes: true });
    const link = entries.find((e) => e.isSymbolicLink());
    if (link !== undefined) {
      const path = join(link.parentPath, link.name);
      throw new RecordError(path, "", `is a symbolic link in a pack folder, so the lock cannot hash what it points to. Next action: replace ${path} with a copy of what it points to, then run warden compile.`);
    }
    return entries.filter((e) => e.isFile() && !isOsJunk(e.name)).map((e) => relative(base, join(e.parentPath, e.name)).split(sep).join("/"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
};

export const scriptsOf = (root: string): Record<string, unknown> => {
  const file = join(root, "package.json");
  if (!existsSync(file)) return {};
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, unknown> } | null)?.scripts ?? {};
  } catch (cause) {
    throw new RecordError("package.json", "", `is not valid JSON: ${(cause as Error).message}. Next action: fix the JSON in package.json, then run warden compile.`);
  }
};

export const PROJECT_SOURCE = "./";

export const LOCK_PATH = ".warden/lock.json";

export const FIRST_STAMPING = "0.1.11";

export const olderThan = (a: string, b: string): boolean => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number)) as [number[], number[]];
  const i = x.findIndex((n, j) => n !== y[j]);
  return i !== -1 && (x[i] as number) < (y[i] ?? 0);
};


export const sha256 = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const hashed = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, content]) => [path, sha256(content)]),
  );

export function computeLock(
  set: RecordSet,
  generated: Record<string, string>,
  sources: Record<string, string>,
  warden: string,
): Lock {
  const guardrails = set.packs
    .flatMap((pack) =>
      pack.practices.flatMap((practice) => {
        const entry = set.config.packs.find((p) => p.id === pack.id);
        const paths = pathGroups(practice.paths, entry?.paths ?? []).map((g) => g.join(" & "));
        return practice.guardrails.map((g): [string, LockedGuardrail] => [
          g.id,
          {
            kind: g.kind,
            budgetMs: g.budgetMs,
            version: g.version,
            implementation: g.implementation,
            options: g.options ?? null,
            runs: [...g.runs].sort(),
            paths: g.scope === "project" ? [] : [...paths].sort(),
            ...(g.scope === undefined ? {} : { scope: g.scope }),
            ...(g.benchmark === undefined ? {} : { benchmark: g.benchmark }),
            ...(entry?.settings === undefined ? {} : { settings: entry.settings }),
          },
        ]);
      }),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const { project, base, tierBudgetMs, loopBreakerRepeats } = set.config;
  return {
    format: LOCK_FORMAT,
    warden,
    sources: hashed(sources),
    tools: bundledTools(),
    generated: hashed(generated),
    guardrails: Object.fromEntries(guardrails),
    config: { project, base, tierBudgetMs, loopBreakerRepeats, bench: benchSettings(set.config) },
  };
}

export function readLock(root: string): Lock {
  const lock = JSON.parse(readFileSync(join(root, LOCK_PATH), "utf8")) as Lock;
  if ((lock.format ?? 0) > LOCK_FORMAT) {
    throw new RecordError(LOCK_PATH, "/format", `has format ${lock.format}; this Warden reads formats up to ${LOCK_FORMAT}. Next action: install Warden ${lock.warden}, the release that wrote the lock.`);
  }
  return lock;
}
