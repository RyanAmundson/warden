import { cmdAdapter } from "../adapters/cmd.js";
import { eslintAdapter } from "../adapters/eslint.js";
import { fsAdapter, graphAdapter } from "../adapters/tree.js";
import { tscAdapter } from "../adapters/tsc.js";
import { statSync } from "node:fs";
import { join } from "node:path";
import { RecordError } from "../records/load.js";
export const adapters = new Map([eslintAdapter, tscAdapter, cmdAdapter, fsAdapter, graphAdapter].map((a) => [a.id, a]));
export const prefixOf = (g) => g.implementation.slice(0, g.implementation.indexOf(":"));
export const unknownAdapters = (set) => {
    const known = [...adapters.keys()];
    return set.packs.flatMap((pack) => pack.practices
        .flatMap((x) => x.guardrails)
        .filter((g) => g.kind !== "instruction" && !adapters.has(prefixOf(g)))
        .map((g) => ({
        code: "unknown-adapter",
        record: g.id,
        file: pack.file,
        message: `Guardrail ${g.id} names adapter "${prefixOf(g)}", which is not registered; the known adapters are ${known.join(", ")}. Next action: set implementation to one of ${known.map((k) => `${k}:<...>`).join(", ")} in ${pack.file}, then run warden compile.`,
    })));
};
export const wholeTree = (g) => adapters.get(prefixOf(g))?.wholeTree === true;
export const refuseUnknownAdapters = (set) => {
    const [unknown] = unknownAdapters(set);
    if (unknown !== undefined)
        throw new RecordError(unknown.file, `/guardrails/${unknown.record}/implementation`, unknown.message);
};
export async function runGuardrails(set, gs, files, ctx) {
    const known = new Set(set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails)));
    const stray = gs.find((g) => !known.has(g));
    if (stray !== undefined)
        throw new Error(`runGuardrails got Guardrail ${stray.id}, which is not in the record set`);
    refuseUnknownAdapters(set);
    const groups = new Map();
    for (const g of gs)
        groups.set(prefixOf(g), [...(groups.get(prefixOf(g)) ?? []), g]);
    const out = [];
    const size = { files: files.length, bytes: files.reduce((n, f) => n + statSync(join(ctx.root, f)).size, 0) };
    for (const [prefix, group] of groups) {
        ctx.onGroup?.(prefix, group.map((g) => g.id));
        const results = await adapters.get(prefix).run(group, files, ctx);
        const passBudget = group.reduce((n, x) => n + x.budgetMs, 0);
        const found = results.find((r) => r.shared !== undefined)?.shared;
        const shared = found === undefined ? undefined : { ...found, budgetMs: passBudget };
        for (const r of results) {
            const g = group.find((x) => x.id === r.guardrail);
            const budget = shared === undefined ? g?.budgetMs : passBudget;
            out.push({ ...size, ...r, ...(shared === undefined ? {} : { shared }), overBudget: ctx.unbudgeted !== true && r.status !== "killed" && g !== undefined && budget !== undefined && r.ms > budget });
        }
    }
    return out;
}
