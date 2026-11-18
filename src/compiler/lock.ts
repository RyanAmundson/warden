import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathGroups } from "../records/paths.js";
import type { Kind, ProjectConfig, RecordSet, Tier } from "../records/types.js";

export const LOCK_FORMAT = 1;

export interface Lock {
  format: number;
  warden: string;
  sources: Record<string, string>;
  tools: Record<string, string>;
  generated: Record<string, string>;
  guardrails: Record<string, LockedGuardrail>;
  config: Pick<ProjectConfig, "project" | "base" | "tierBudgetMs" | "loopBreakerRepeats">;
}

export interface LockedGuardrail {
  kind: Kind;
  budgetMs: number;
  version: number;
  implementation: string;
  options: unknown;
  runs: Tier[];
  paths: string[];
}

export const TOOLS = ["eslint", "typescript-eslint", "typescript"] as const;

const wardenRequire = createRequire(import.meta.url);

export const bundledTools = (): Record<string, string> =>
  Object.fromEntries(TOOLS.map((name) => [name, (wardenRequire(`${name}/package.json`) as { version: string }).version]));

export const LOCK_PATH = ".warden/lock.json";

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
        const paths = pathGroups(practice.paths, set.config.packs.find((p) => p.id === pack.id)?.paths ?? []).map((g) => g.join(" & "));
        return practice.guardrails.map((g): [string, LockedGuardrail] => [
          g.id,
          {
            kind: g.kind,
            budgetMs: g.budgetMs,
            version: g.version,
            implementation: g.implementation,
            options: g.options ?? null,
            runs: [...g.runs].sort(),
            paths: [...paths].sort(),
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
    config: { project, base, tierBudgetMs, loopBreakerRepeats },
  };
}

export function readLock(root: string): Lock {
  return JSON.parse(readFileSync(join(root, LOCK_PATH), "utf8")) as Lock;
}
