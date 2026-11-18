import { cmdAdapter } from "../adapters/cmd.js";
import { eslintAdapter } from "../adapters/eslint.js";
import { tscAdapter } from "../adapters/tsc.js";
import type { Adapter, RunContext, RunResult } from "../adapters/types.js";
import { RecordError } from "../records/load.js";
import type { Guardrail } from "../records/types.js";

export const adapters = new Map<string, Adapter>([eslintAdapter, tscAdapter, cmdAdapter].map((a) => [a.id, a]));

export async function runGuardrails(gs: Guardrail[], files: string[], ctx: RunContext): Promise<RunResult[]> {
  const groups = new Map<string, Guardrail[]>();
  for (const g of gs) {
    const prefix = g.implementation.slice(0, g.implementation.indexOf(":"));
    if (!adapters.has(prefix)) {
      throw new RecordError("", `/guardrails/${g.id}/implementation`, `unknown adapter "${prefix}"`);
    }
    groups.set(prefix, [...(groups.get(prefix) ?? []), g]);
  }
  const out: RunResult[] = [];
  for (const [prefix, group] of groups) {
    const start = performance.now();
    const results = await (adapters.get(prefix) as Adapter).run(group, files, ctx);
    const elapsed = performance.now() - start;
    for (const r of results) {
      const g = group.find((x) => x.id === r.guardrail);
      const ms = prefix === "cmd" ? r.ms : elapsed;
      out.push({ ...r, ms, status: r.status === "over-budget" || (g !== undefined && ms > g.budgetMs) ? "over-budget" : r.status });
    }
  }
  return out;
}
