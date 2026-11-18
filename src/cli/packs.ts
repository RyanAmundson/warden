import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KIND_LADDER, type Kind } from "../records/types.js";
import { parseConfig, readPack, readText } from "../records/load.js";

export interface PackRow {
  id: string;
  source: "bundled" | "local";
  practices: number;
  kinds: Partial<Record<Kind, number>>;
  on: boolean;
  paths: string[];
}

const ids = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);

export async function listPacks(root: string, wardenRoot: string): Promise<PackRow[]> {
  const configFile = join(root, ".warden", "config.yaml");
  const text = await readText(configFile);
  const configured = new Map((text === undefined ? [] : parseConfig(configFile, text).packs).map((p) => [p.id, p.paths]));
  const all = [...new Set([...ids(join(wardenRoot, "packs")), ...ids(join(root, ".warden", "packs"))])];
  const rows: PackRow[] = [];
  for (const id of all) {
    const { pack, source } = await readPack(root, wardenRoot, id, configFile);
    const all = pack.practices.flatMap((x) => x.guardrails);
    const kinds = Object.fromEntries(KIND_LADDER.flat().flatMap((k) => (all.some((g) => g.kind === k) ? [[k, all.filter((g) => g.kind === k).length]] : [])));
    rows.push({ id, source, practices: pack.practices.length, kinds, on: configured.has(id), paths: configured.get(id) ?? [] });
  }
  return rows.sort((a, b) => (a.source === b.source ? a.id.localeCompare(b.id) : a.source === "bundled" ? -1 : 1));
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
