import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig, RecordSet, Tier } from "../records/types.js";

export interface Lock {
  warden: string;
  sources: Record<string, string>;
  generated: Record<string, string>;
  guardrails: Record<string, LockedGuardrail>;
  config: Pick<ProjectConfig, "tierBudgetMs" | "loopBreakerRepeats">;
}

export interface LockedGuardrail {
  budgetMs: number;
  version: number;
  implementation: string;
  options: unknown;
  runs: Tier[];
  paths: string[];
}

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
        const paths = practice.paths.length > 0 ? practice.paths : (set.config.packs.find((p) => p.id === pack.id)?.paths ?? []);
        return practice.guardrails.map((g): [string, LockedGuardrail] => [
          g.id,
          {
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
  const { tierBudgetMs, loopBreakerRepeats } = set.config;
  return {
    warden,
    sources: hashed(sources),
    generated: hashed(generated),
    guardrails: Object.fromEntries(guardrails),
    config: { tierBudgetMs, loopBreakerRepeats },
  };
}

export function readLock(root: string): Lock {
  return JSON.parse(readFileSync(join(root, LOCK_PATH), "utf8")) as Lock;
}
