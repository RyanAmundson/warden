import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KIND_LADDER, type Kind, type Pack } from "../records/types.js";
import { parseConfig, readBundledPacks, readPack, readText } from "../records/load.js";
import { builtInAdapters, prefixOf } from "../runner/run.js";

export interface PackRow {
  id: string;
  source: "bundled" | "local";
  practices: number;
  kinds: Partial<Record<Kind, number>>;
  on: boolean;
  paths: string[];
}

const ids = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);

export async function packCatalog(root: string, wardenRoot: string, source?: string, policyDir = join(root, ".warden")): Promise<{ row: PackRow; pack: Pack }[]> {
  const configFile = join(policyDir, "config.yaml");
  const text = source ?? await readText(configFile);
  const configured = new Map((text === undefined ? [] : parseConfig(configFile, text).packs).filter((p) => p.enabled !== false).map((p) => [p.id, p.paths]));
  const all = [...new Set([...ids(join(wardenRoot, "packs")), ...ids(join(policyDir, "packs"))])];
  const rows: { row: PackRow; pack: Pack }[] = [];
  for (const id of all) {
    const { pack, source } = await readPack(root, wardenRoot, id, configFile, policyDir);
    const all = pack.practices.flatMap((x) => x.guardrails);
    const kinds = Object.fromEntries(KIND_LADDER.flat().flatMap((k) => (all.some((g) => g.kind === k) ? [[k, all.filter((g) => g.kind === k).length]] : [])));
    rows.push({ pack, row: { id, source, practices: pack.practices.length, kinds, on: configured.has(id), paths: configured.get(id) ?? [] } });
  }
  return rows.sort(({ row: a }, { row: b }) => (a.source === b.source ? a.id.localeCompare(b.id) : a.source === "bundled" ? -1 : 1));
}

export async function bundledPackCatalog(wardenRoot: string) {
  const bundled = await readBundledPacks(wardenRoot);
  const packs = bundled.map((pack) => {
    const rules = pack.practices.flatMap(({ guardrails }) => guardrails);
    const adapters = [...new Set(rules.filter(({ kind }) => kind !== "instruction").map(prefixOf))].sort();
    return { id: pack.id, rules: rules.length, adapters };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const adapters = builtInAdapters.map(([adapter, description]) => ({
    id: adapter.id,
    description,
    packs: packs.filter((pack) => pack.adapters.includes(adapter.id)).map(({ id }) => id),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return { packs, adapters };
}

export async function listPacks(root: string, wardenRoot: string, source?: string): Promise<PackRow[]> {
  return (await packCatalog(root, wardenRoot, source)).map(({ row }) => row);
}

export const initAction = (rows: PackRow[]): string => `run warden init --packs ${rows.map((r) => r.id).join(",")}`;

export async function runPacks(root: string, wardenRoot: string, json: boolean): Promise<number> {
  const rows = await listPacks(root, wardenRoot);
  if (json) {
    process.stdout.write(`${JSON.stringify({ packs: rows }, null, 2)}\n`);
    return 0;
  }
  for (const r of rows) {
    process.stdout.write(`${r.id}  ${r.source}  ${r.practices} practices  ${Object.entries(r.kinds).map(([k, n]) => `${k}=${n}`).join(" ")}  ${r.on ? `on  ${r.paths.join(", ")}` : "off"}\n`);
  }
  if (!existsSync(join(root, ".warden", "config.yaml"))) process.stdout.write(`Next action: ${initAction(rows)}\n`);
  return 0;
}
