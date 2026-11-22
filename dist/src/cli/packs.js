import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KIND_LADDER } from "../records/types.js";
import { parseConfig, readPack, readText } from "../records/load.js";
const ids = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);
export async function packCatalog(root, wardenRoot, source) {
    const configFile = join(root, ".warden", "config.yaml");
    const text = source ?? await readText(configFile);
    const configured = new Map((text === undefined ? [] : parseConfig(configFile, text).packs).filter((p) => p.enabled !== false).map((p) => [p.id, p.paths]));
    const all = [...new Set([...ids(join(wardenRoot, "packs")), ...ids(join(root, ".warden", "packs"))])];
    const rows = [];
    for (const id of all) {
        const { pack, source } = await readPack(root, wardenRoot, id, configFile);
        const all = pack.practices.flatMap((x) => x.guardrails);
        const kinds = Object.fromEntries(KIND_LADDER.flat().flatMap((k) => (all.some((g) => g.kind === k) ? [[k, all.filter((g) => g.kind === k).length]] : [])));
        rows.push({ pack, row: { id, source, practices: pack.practices.length, kinds, on: configured.has(id), paths: configured.get(id) ?? [] } });
    }
    return rows.sort(({ row: a }, { row: b }) => (a.source === b.source ? a.id.localeCompare(b.id) : a.source === "bundled" ? -1 : 1));
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
