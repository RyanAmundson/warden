import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KIND_LADDER } from "../records/types.js";
import { parseConfig, readBundledPacks, readPack, readText } from "../records/load.js";
import { builtInReviewAdapters } from "../review/adapter.js";
import { builtInAdapters, prefixOf } from "../runner/run.js";
const ids = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);
export async function packCatalog(root, wardenRoot, source, policyDir = join(root, ".warden")) {
    const configFile = join(policyDir, "config.yaml");
    const text = source ?? await readText(configFile);
    const configured = new Map((text === undefined ? [] : parseConfig(configFile, text).packs).filter((p) => p.enabled !== false).map((p) => [p.id, p.paths]));
    const all = [...new Set([...ids(join(wardenRoot, "packs")), ...ids(join(policyDir, "packs"))])];
    const rows = [];
    for (const id of all) {
        const { pack, source } = await readPack(root, wardenRoot, id, configFile, policyDir);
        const all = pack.practices.flatMap((x) => x.guardrails);
        const kinds = Object.fromEntries(KIND_LADDER.flat().flatMap((k) => (all.some((g) => g.kind === k) ? [[k, all.filter((g) => g.kind === k).length]] : [])));
        rows.push({ pack, row: { id, source, practices: pack.practices.length, kinds, on: configured.has(id), paths: configured.get(id) ?? [] } });
    }
    return rows.sort(({ row: a }, { row: b }) => (a.source === b.source ? a.id.localeCompare(b.id) : a.source === "bundled" ? -1 : 1));
}
export async function bundledPackCatalog(wardenRoot) {
    const bundled = await readBundledPacks(wardenRoot);
    const packs = bundled.map((pack) => {
        const rules = pack.practices.flatMap(({ guardrails }) => guardrails);
        const adapters = [...new Set(rules.filter(({ kind }) => kind !== "instruction").map(prefixOf))].sort();
        const reviewAdapters = [...new Set(pack.capabilities.flatMap(({ review }) => review ? [review.adapter] : []))].sort();
        return { id: pack.id, rules: rules.length, adapters, reviewAdapters };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const describe = (registered, key) => registered.map(([{ id }, description]) => ({
        id,
        description,
        packs: packs.filter((pack) => pack[key].includes(id)).map((pack) => pack.id),
    })).sort((a, b) => a.id.localeCompare(b.id));
    return { packs, adapters: describe(builtInAdapters, "adapters"), reviewAdapters: describe(builtInReviewAdapters, "reviewAdapters") };
}
export async function listPacks(root, wardenRoot, source) {
    return (await packCatalog(root, wardenRoot, source)).map(({ row }) => row);
}
export const initAction = (rows) => `run warden init --packs ${rows.map((r) => r.id).join(",")}`;
export async function runPacks(root, wardenRoot, json) {
    const rows = await listPacks(root, wardenRoot);
    if (json) {
        process.stdout.write(`${JSON.stringify({ packs: rows }, null, 2)}\n`);
        return 0;
    }
    for (const r of rows) {
        process.stdout.write(`${r.id}  ${r.source}  ${r.practices} practices  ${Object.entries(r.kinds).map(([k, n]) => `${k}=${n}`).join(" ")}  ${r.on ? `on  ${r.paths.join(", ")}` : "off"}\n`);
    }
    if (!existsSync(join(root, ".warden", "config.yaml")))
        process.stdout.write(`Next action: ${initAction(rows)}\n`);
    return 0;
}
