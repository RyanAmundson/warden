import { cmdAdapter } from "../adapters/cmd.js";
import { eslintAdapter } from "../adapters/eslint.js";
import { tscAdapter } from "../adapters/tsc.js";
import type { Adapter, RunContext, RunResult } from "../adapters/types.js";
import { RecordError } from "../records/load.js";
import type { Guardrail, RecordSet } from "../records/types.js";
import type { Finding } from "../compiler/consistency.js";

export const adapters = new Map<string, Adapter>([eslintAdapter, tscAdapter, cmdAdapter].map((a) => [a.id, a]));

const prefixOf = (g: Guardrail): string => g.implementation.slice(0, g.implementation.indexOf(":"));

export const unknownAdapters = (set: RecordSet): (Finding & { file: string })[] => {
  const known = [...adapters.keys()];
  return set.packs.flatMap((pack) =>
    pack.practices
      .flatMap((x) => x.guardrails)
      .filter((g) => g.kind !== "instruction" && !adapters.has(prefixOf(g)))
      .map((g) => ({
        code: "unknown-adapter",
        record: g.id,
        file: pack.file,
        message: `Guardrail ${g.id} names adapter "${prefixOf(g)}", which is not registered; the known adapters are ${known.join(", ")}. Next action: set implementation to one of ${known.map((k) => `${k}:<...>`).join(", ")} in ${pack.file}, then run warden compile.`,
      })),
  );
};

export async function runGuardrails(gs: Guardrail[], files: string[], ctx: RunContext): Promise<RunResult[]> {
  const groups = new Map<string, Guardrail[]>();
  for (const g of gs) {
    const prefix = prefixOf(g);
    if (!adapters.has(prefix)) {
      throw new RecordError("", `/guardrails/${g.id}/implementation`, `unknown adapter "${prefix}"`);
    }
    groups.set(prefix, [...(groups.get(prefix) ?? []), g]);
  }
  const out: RunResult[] = [];
  for (const [prefix, group] of groups) {
    const results = await (adapters.get(prefix) as Adapter).run(group, files, ctx);
    for (const r of results) {
      const g = group.find((x) => x.id === r.guardrail);
      out.push({ ...r, overBudget: ctx.unbudgeted !== true && r.status !== "killed" && g !== undefined && r.ms > g.budgetMs });
    }
  }
  return out;
}
