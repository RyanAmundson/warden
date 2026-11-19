import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Adapter } from "../adapters/types.js";
import { RecordError, loadRecords, readText } from "../records/load.js";
import type { Guardrail, RecordSet } from "../records/types.js";
import { BASELINE_PATH, measureBaseline, readBaseline, writeBaseline } from "../runner/baseline.js";
import { hasCommit, isRepository } from "../runner/changed.js";
import { SIGNERS_FILE, readBaseLock } from "../runner/tamper.js";
import { adapters, prefixOf, refuseUnknownAdapters } from "../runner/run.js";
import { admit } from "./bench.js";
import { checkConsistency, type Finding } from "./consistency.js";
import { COMMIT_HOOK, commitHook, stamp } from "./emit.js";
import { runExamples } from "./examples.js";
import { checkCommands, emitSkills } from "./skills.js";
import { LOCK_PATH, type Lock, computeLock, packFiles, sha256 } from "./lock.js";

const sourceFiles = async (set: RecordSet, projectRoot: string, wardenRoot: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const config = await readText(join(projectRoot, ".warden/config.yaml"));
  if (config === undefined) throw new RecordError(join(projectRoot, ".warden/config.yaml"), "", "file not found");
  out[".warden/config.yaml"] = config;
  const signers = await readText(join(wardenRoot, SIGNERS_FILE));
  if (signers !== undefined) out[SIGNERS_FILE] = signers;
  for (const { id } of set.config.packs) {
    for (const [dir, base] of [[`packs/${id}`, wardenRoot], [`.warden/packs/${id}`, projectRoot]] as const) {
      for (const key of await packFiles(base, dir)) out[key] = (await readText(join(base, key))) as string;
    }
  }
  return out;
};

const emitAll = (set: RecordSet): Record<string, string> => {
  refuseUnknownAdapters(set);
  const groups = new Map<string, Guardrail[]>();
  for (const g of set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails))) {
    if (g.kind === "instruction") continue;
    const prefix = prefixOf(g);
    groups.set(prefix, [...(groups.get(prefix) ?? []), g]);
  }
  const emitted: Record<string, string> = {};
  const pairs: [Adapter, Guardrail[]][] = [...groups].map(([prefix, gs]) => [adapters.get(prefix) as Adapter, gs]);
  for (const [adapter, gs] of pairs) {
    for (const [path, content] of Object.entries(adapter.emit(gs, set))) {
      if (path in emitted) throw new Error(`more than one adapter emits ${path}`);
      emitted[path] = content;
    }
  }
  return emitted;
};

const writeAll = async (root: string, outputs: Record<string, string>): Promise<void> => {
  const staged: [string, string][] = [];
  try {
    for (const [file, content] of Object.entries(outputs)) {
      const target = join(root, file);
      const temp = `${target}.warden-tmp-${process.pid}`;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(temp, content, { mode: file === COMMIT_HOOK ? 0o755 : 0o644 });
      staged.push([temp, target]);
    }
    for (const [temp, target] of staged) await rename(temp, target);
  } finally {
    for (const [temp] of staged) await rm(temp, { force: true });
  }
};

export interface Expected {
  lock: Lock;
  files: Record<string, string>;
}

export const wardenVersion = async (wardenRoot: string): Promise<string> =>
  (JSON.parse(await readFile(join(wardenRoot, "package.json"), "utf8")) as { version: string }).version;

export async function expectedOutputs(set: RecordSet, projectRoot: string, wardenRoot: string): Promise<Expected> {
  const version = await wardenVersion(wardenRoot);
  const sources = await sourceFiles(set, projectRoot, wardenRoot);
  const sourceHash = sha256(
    Object.entries(sources)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, content]) => `${path}\0${content}\0`)
      .join(""),
  );

  const emitted: Record<string, string> = { ...emitAll(set), [COMMIT_HOOK]: commitHook(version, set.config.base) };
  for (const [path, content] of Object.entries(emitSkills(set))) {
    if (path in emitted) throw new Error(`more than one output is ${path}`);
    emitted[path] = content;
  }
  const files = Object.fromEntries(Object.entries(emitted).map(([key, content]) => [key, stamp(key, content, version, sourceHash)]));
  return { lock: computeLock(set, files, sources, version), files };
}

const previousGuardrails = (text: string | undefined): Lock["guardrails"] | undefined => {
  if (text === undefined) return undefined;
  try {
    return (JSON.parse(text) as Lock).guardrails;
  } catch {
    return undefined;
  }
};

export async function compile(projectRoot: string, wardenRoot: string): Promise<{ findings: Finding[]; written: string[] }> {
  const set = await loadRecords(projectRoot, wardenRoot);
  const findings = [...checkConsistency(set), ...(await runExamples(set)), ...(await checkCommands(set, wardenRoot))];
  if (findings.length > 0) return { findings, written: [] };
  const slow = await admit(set, await wardenVersion(wardenRoot));
  if (slow.length > 0) return { findings: slow, written: [] };

  const { lock, files: outputs } = await expectedOutputs(set, projectRoot, wardenRoot);

  const previous = previousGuardrails(await readText(join(projectRoot, LOCK_PATH)));
  await writeAll(projectRoot, outputs);
  await writeAll(projectRoot, { [LOCK_PATH]: `${JSON.stringify(lock, null, 2)}\n` });
  const written = [...Object.keys(outputs), LOCK_PATH];
  if (previous === undefined || !isRepository(projectRoot)) return { findings: [], written };
  const checked = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.filter((g) => g.kind !== "instruction")));
  const atBase = hasCommit(projectRoot, set.config.base) ? (readBaseLock(projectRoot, set.config.base)?.guardrails ?? {}) : {};
  const added = new Set(checked.filter((g) => !(g.id in previous) && !(g.id in atBase)).map((g) => g.id));
  const prefixes = new Set(checked.filter((g) => added.has(g.id)).map(prefixOf));
  const { baseline } = await measureBaseline(set, checked.filter((g) => prefixes.has(prefixOf(g))));
  const located = Object.entries(baseline)
    .filter(([id]) => added.has(id))
    .map(([id, entries]) => [id, Object.fromEntries(Object.entries(entries).filter(([file]) => file !== ""))] as const)
    .filter(([, entries]) => Object.keys(entries).length > 0);
  if (located.length === 0) return { findings: [], written };
  writeBaseline(projectRoot, { ...readBaseline(projectRoot), ...Object.fromEntries(located) });
  return { findings: [], written: [...written, BASELINE_PATH] };
}
