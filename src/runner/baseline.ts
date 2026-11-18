import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult, Violation } from "../adapters/types.js";

export type Baseline = Record<string, Record<string, number>>;

export const BASELINE_PATH = ".warden/baseline.json";

export function readBaseline(root: string): Baseline {
  try {
    return JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8")) as Baseline;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw cause;
  }
}

export function writeBaseline(root: string, b: Baseline): void {
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(b, null, 2)}\n`);
}

export function applyBaseline(
  results: RunResult[],
  baseline: Baseline,
  scanned: string[],
  existing: (f: string) => boolean,
): { failures: Violation[]; next: Baseline } {
  const next: Baseline = {};
  for (const [g, entries] of Object.entries(baseline)) {
    next[g] = Object.fromEntries(Object.entries(entries).filter(([f]) => f === "" || existing(f)));
  }
  const failures: Violation[] = [];
  for (const r of results) {
    if (r.status === "over-budget") {
      failures.push({ guardrail: r.guardrail, file: "", line: 0, message: "stopped at its time budget (over-budget)" });
      continue;
    }
    const byFile = new Map<string, Violation[]>(["", ...scanned].map((f) => [f, []]));
    for (const v of r.violations) byFile.get(v.file)?.push(v);
    const entries = next[r.guardrail] ?? {};
    for (const [file, vs] of byFile) {
      if (vs.length > (entries[file] ?? 0)) failures.push(...vs);
      else if (vs.length === 0) delete entries[file];
      else entries[file] = vs.length;
    }
    next[r.guardrail] = entries;
  }
  for (const [g, entries] of Object.entries(next)) if (Object.keys(entries).length === 0) delete next[g];
  return { failures, next };
}
