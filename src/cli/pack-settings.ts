import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { type IncomingMessage } from "node:http";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { loadRecords, parseConfig } from "../records/load.js";
import { jevReadiness, packDetails } from "./pack-details.js";
import { listPacks, packCatalog } from "./packs.js";

export class PackSettingsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const revisionOf = (text: string): string => createHash("sha256").update(text).digest("hex");

function readConfig(root: string, project: string) {
  const folder = join(root, ".warden");
  const file = join(folder, "config.yaml");
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root || !lstatSync(folder).isDirectory()) {
    throw new PackSettingsError(422, "Use a real project checkout and a regular .warden directory.");
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new PackSettingsError(422, "Use a regular project-owned config file.");
  const text = readFileSync(file, "utf8");
  const config = parseConfig(file, text);
  if (config.project !== project) throw new PackSettingsError(409, "This checkout now belongs to a different Warden project.");
  return { file, folder, text, config, stat, revision: revisionOf(text) };
}

export async function packSettings(root: string, project: string, wardenRoot: string) {
  const { text, revision } = readConfig(root, project);
  const catalog = await packCatalog(root, wardenRoot, text);
  const details = catalog.map(({ pack }) => packDetails(root, pack));
  const jevPackIds = details.filter(({ checks }) => checks.some(({ model }) => model?.startsWith("jev-"))).map(({ id }) => id);
  return {
    root,
    revision,
    packs: catalog.map(({ row: { id, on } }) => ({ id, on, required: id === "core" && on })),
    details,
    jev: { ...jevReadiness(), packIds: jevPackIds },
  };
}

type PackChange = { id: string; enabled: boolean };

function parseChanges(value: unknown): PackChange[] {
  if (!Array.isArray(value) || value.length === 0) throw new PackSettingsError(400, "Choose at least one pack change.");
  const seen = new Set<string>();
  for (const row of value) {
    if (row === null || typeof row !== "object" || typeof row.id !== "string" || typeof row.enabled !== "boolean" || seen.has(row.id)) {
      throw new PackSettingsError(400, "Send each pack ID once with a boolean selection.");
    }
    seen.add(row.id);
  }
  return value;
}

export async function savePackSettings(root: string, project: string, wardenRoot: string, revision: unknown, input: unknown) {
  const current = readConfig(root, project);
  if (current.revision !== revision) throw new PackSettingsError(409, "The config changed. Reload Layers before saving again.");
  const changes = parseChanges(input);
  const available = new Map((await listPacks(root, wardenRoot, current.text)).map((pack) => [pack.id, pack]));
  const document = parseDocument(current.text);
  let changed = false;
  for (const { id, enabled } of changes) {
    const pack = available.get(id);
    if (!pack) throw new PackSettingsError(422, `Pack ${id} is unavailable in this checkout.`);
    if (id === "core" && !enabled) throw new PackSettingsError(422, "Core protects the other rules and must stay enabled.");
    if (pack.on === enabled) continue;
    const index = current.config.packs.findIndex((entry) => entry.id === id);
    if (index === -1) document.addIn(["packs"], { id, paths: ["**/*"] });
    else if (enabled) document.deleteIn(["packs", index, "enabled"]);
    else document.setIn(["packs", index, "enabled"], false);
    changed = true;
  }
  if (!changed) return { changed: false };
  const output = String(document);
  await loadRecords(root, wardenRoot, output);
  const temp = join(current.folder, `config.pack-${randomUUID()}.tmp`);
  const latest = readConfig(root, project);
  if (latest.revision !== current.revision || latest.stat.ino !== current.stat.ino || latest.stat.dev !== current.stat.dev) {
    throw new PackSettingsError(409, "The config changed. Reload Layers before saving again.");
  }
  const fd = openSync(temp, "wx", current.stat.mode & 0o777);
  try {
    try {
      writeFileSync(fd, output);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, current.file);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
  return { changed: true };
}

export async function packSettingsBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers.origin !== `http://${request.headers.host}` || request.headers["content-type"] !== "application/json") {
    throw new PackSettingsError(403, "Save pack changes from the local Warden dashboard.");
  }
  let body = "";
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    body += chunk;
    if (Buffer.byteLength(body) > 64 * 1024) throw new PackSettingsError(413, "The pack change request is too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new PackSettingsError(400, "Send pack changes as JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PackSettingsError(400, "Send a pack settings object.");
  return value as Record<string, unknown>;
}
