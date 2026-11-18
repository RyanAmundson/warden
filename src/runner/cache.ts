import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Violation } from "../adapters/types.js";
import type { Measurement } from "./evidence.js";
import { canonicalJson, sha256 } from "../compiler/lock.js";
import type { Guardrail } from "../records/types.js";
import { wardenHome } from "./evidence.js";

export const cacheKey = (file: string, contentSha: string, g: Guardrail, lockSha: string, warden: string): string =>
  sha256(canonicalJson(["violation-range", g.id, g.version, g.implementation, g.options ?? null, file, contentSha, lockSha, warden]));

const cacheDir = (project: string): string => join(wardenHome(), "cache", project);

export function readCache(project: string, key: string): Violation[] | undefined {
  try {
    return JSON.parse(readFileSync(join(cacheDir(project), `${key}.json`), "utf8")) as Violation[];
  } catch {
    return undefined;
  }
}

export function writeCache(project: string, key: string, violations: Violation[]): void {
  mkdirSync(cacheDir(project), { recursive: true });
  const target = join(cacheDir(project), `${key}.json`);
  const temp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(violations));
  renameSync(temp, target);
}

const benchDir = (): string => join(wardenHome(), "bench");

export function readBenchCache(key: string): Measurement | undefined {
  try {
    return JSON.parse(readFileSync(join(benchDir(), `${key}.json`), "utf8")) as Measurement;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

export function writeBenchCache(key: string, m: Measurement): void {
  mkdirSync(benchDir(), { recursive: true });
  writeFileSync(join(benchDir(), `${key}.json`), JSON.stringify(m));
}
