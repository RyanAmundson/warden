import { cmdAdapter } from "../adapters/cmd.js";
import { eslintAdapter } from "../adapters/eslint.js";
import { fsAdapter, graphAdapter } from "../adapters/tree.js";
import { tscAdapter } from "../adapters/tsc.js";
import type { Adapter, RunContext, RunResult } from "../adapters/types.js";
import { RecordError } from "../records/load.js";
import { declaredUnits } from "../records/units.js";
import type { Guardrail, RecordSet } from "../records/types.js";
import type { Finding } from "../compiler/consistency.js";

export const adapters = new Map<string, Adapter>([eslintAdapter, tscAdapter, cmdAdapter, fsAdapter, graphAdapter].map((a) => [a.id, a]));

export const prefixOf = (g: Guardrail): string => g.implementation.slice(0, g.implementation.indexOf(":"));

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

export const wholeTree = (g: Guardrail): boolean => adapters.get(prefixOf(g))?.wholeTree === true;

export const refuseUnknownAdapters = (set: RecordSet): void => {
  const [unknown] = unknownAdapters(set);
  if (unknown !== undefined) throw new RecordError(unknown.file, `/guardrails/${unknown.record}/implementation`, unknown.message);
};

export async function runGuardrails(set: RecordSet, gs: Guardrail[], files: string[], ctx: RunContext): Promise<RunResult[]> {
  const known = new Set(set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails)));
  const stray = gs.find((g) => !known.has(g));
  if (stray !== undefined) throw new Error(`runGuardrails got Guardrail ${stray.id}, which is not in the record set`);
  refuseUnknownAdapters(set);
  const packOf = new Map(set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.map((g) => [g, p.id] as const))));
  const settingsOf = (g: Guardrail): Record<string, unknown> | undefined => set.config.packs.find((p) => p.id === packOf.get(g))?.settings;
  const units = gs.some((g) => g.scope === "project") ? declaredUnits(set) : undefined;
  const unitStructure = units === undefined ? undefined : {
    units,
    ignoreCase: set.unitIgnoreCase === true,
    termDefinitions: set.packs.flatMap((pack) => pack.terms.map(({ id, definition }) => ({ id, definition }))),
  };
  ctx = { ...ctx, settingsOf, ...(unitStructure === undefined ? {} : { unitStructure }) };
  const groups = new Map<string, Guardrail[]>();
  for (const g of gs) groups.set(prefixOf(g), [...(groups.get(prefixOf(g)) ?? []), g]);
  const out: RunResult[] = [];
  for (const [prefix, group] of groups) {
    ctx.onGroup?.(prefix, group.map((g) => g.id));
    const results = await (adapters.get(prefix) as Adapter).run(group, files, ctx);
    const passBudget = group.reduce((n, x) => n + x.budgetMs, 0);
    const found = results.find((r) => r.shared !== undefined)?.shared;
    const shared = found === undefined ? undefined : { ...found, budgetMs: passBudget };
    for (const r of results) {
      const g = group.find((x) => x.id === r.guardrail);
      const budget = shared === undefined ? g?.budgetMs : passBudget;
      out.push({ ...r, ...(shared === undefined ? {} : { shared }), overBudget: ctx.unbudgeted !== true && r.status !== "killed" && g !== undefined && budget !== undefined && r.ms > budget });
    }
  }
  return out;
}
