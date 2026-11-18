import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claudeSettingsAdapter } from "../adapters/claude.js";
import type { Adapter } from "../adapters/types.js";
import { RecordError, loadRecords, readText } from "../records/load.js";
import type { Guardrail, RecordSet } from "../records/types.js";
import { adapters } from "../runner/run.js";
import { checkConsistency, type Finding } from "./consistency.js";
import { mergeSettings, stamp } from "./emit.js";
import { runExamples } from "./examples.js";
import { LOCK_PATH, canonicalJson, computeLock, sha256 } from "./lock.js";

const SETTINGS_KEY = "#";

const sourceFiles = async (set: RecordSet, projectRoot: string, wardenRoot: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const config = await readText(join(projectRoot, ".warden/config.yaml"));
  if (config === undefined) throw new RecordError(join(projectRoot, ".warden/config.yaml"), "", "file not found");
  out[".warden/config.yaml"] = config;
  for (const { id } of set.config.packs) {
    for (const [key, base] of [[`packs/${id}/pack.yaml`, wardenRoot], [`.warden/packs/${id}/pack.yaml`, projectRoot]] as const) {
      const text = await readText(join(base, key));
      if (text !== undefined) out[key] = text;
    }
  }
  return out;
};

const emitAll = (set: RecordSet): Record<string, string> => {
  const groups = new Map<string, Guardrail[]>();
  for (const g of set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails))) {
    if (g.kind === "instruction") continue;
    const prefix = g.implementation.slice(0, g.implementation.indexOf(":"));
    if (!adapters.has(prefix)) throw new RecordError("", `/guardrails/${g.id}/implementation`, `unknown adapter "${prefix}"`);
    groups.set(prefix, [...(groups.get(prefix) ?? []), g]);
  }
  const emitted: Record<string, string> = {};
  const pairs: [Adapter, Guardrail[]][] = [...groups].map(([prefix, gs]) => [adapters.get(prefix) as Adapter, gs]);
  pairs.push([claudeSettingsAdapter, []]);
  for (const [adapter, gs] of pairs) {
    for (const [path, content] of Object.entries(adapter.emit(gs, set))) {
      if (path in emitted) throw new Error(`more than one adapter emits ${path}`);
      emitted[path] = content;
    }
  }
  return emitted;
};

const write = async (root: string, file: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

export async function compile(projectRoot: string, wardenRoot: string): Promise<{ findings: Finding[]; written: string[] }> {
  const set = await loadRecords(projectRoot, wardenRoot);
  const findings = [...checkConsistency(set), ...(await runExamples(set, wardenRoot))];
  if (findings.length > 0) return { findings, written: [] };

  const version = (JSON.parse(await readFile(join(wardenRoot, "package.json"), "utf8")) as { version: string }).version;
  const sources = await sourceFiles(set, projectRoot, wardenRoot);
  const sourceHash = sha256(
    Object.entries(sources)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, content]) => `${path}\0${content}\0`)
      .join(""),
  );

  const files: Record<string, string> = {};
  const owned: Record<string, Record<string, unknown[]>> = {};
  for (const [key, content] of Object.entries(emitAll(set))) {
    const at = key.indexOf(SETTINGS_KEY);
    if (at === -1) {
      files[key] = stamp(key, content, version, sourceHash);
      continue;
    }
    const entries: unknown = JSON.parse(content);
    if (!Array.isArray(entries)) throw new Error(`${key} must emit a JSON array`);
    const file = key.slice(0, at);
    owned[file] = { ...owned[file], [key.slice(at + 1)]: entries };
  }

  const generated = { ...files };
  const written: string[] = [];
  for (const [file, content] of Object.entries(files)) {
    await write(projectRoot, file, content);
    written.push(file);
  }
  for (const [file, entries] of Object.entries(owned)) {
    await write(projectRoot, file, mergeSettings(file, await readText(join(projectRoot, file)), entries));
    generated[`${file}#warden`] = canonicalJson(entries);
    written.push(file);
  }

  const lock = computeLock(set, generated, sources, version);
  await write(projectRoot, LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  written.push(LOCK_PATH);
  return { findings: [], written };
}
