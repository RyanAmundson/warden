import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RecordError } from "../records/load.js";
import { enabledOn, pathGroups } from "../records/paths.js";
import { unitLookup } from "../records/units.js";
import type { Guardrail, RecordSet, Term } from "../records/types.js";
import { packEntry } from "./pack-code.js";
import { inSandbox } from "./sandbox.js";
import type { Adapter, RunContext, RunResult, Violation } from "./types.js";

export interface Edge {
  target: string;
  specifier: string;
  line: number;
}

interface Found {
  file: string;
  line?: number;
  endLine?: number;
  message: string;
  doThis?: string;
}

interface Entry {
  guardrail: string;
  groups: string[][];
  settings?: Record<string, unknown>;
}

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const lineStarts = (text: string): number[] => {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
};

const lineAt = (starts: number[], pos: number): number => {
  let [low, high] = [0, starts.length - 1];
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] as number) <= pos) low = mid;
    else high = mid - 1;
  }
  return low + 1;
};

const compilerOptions = async (root: string): Promise<import("typescript").CompilerOptions> => {
  const { default: ts } = await import("typescript");
  const base = { allowJs: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const file = join(root, "tsconfig.json");
  if (!existsSync(file)) return base;
  const { config, error } = ts.readConfigFile(file, ts.sys.readFile);
  if (error !== undefined) {
    throw new RecordError(file, "", `does not parse: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}. Next action: fix ${file}, then run the same warden command again.`);
  }
  return { ...ts.parseJsonConfigFileContent(config, { ...ts.sys, readDirectory: () => [] }, root).options, allowJs: true };
};

const memoizePath = <T>(lookup: (path: string) => T): ((path: string) => T) => {
  const values = new Map<string, T>();
  return (path) => {
    if (!values.has(path)) values.set(path, lookup(path));
    return values.get(path) as T;
  };
};

export async function importGraph(root: string, files: string[], read: (file: string) => string): Promise<Map<string, Edge[]>> {
  const { default: ts } = await import("typescript");
  const options = await compilerOptions(root);
  const cache = ts.createModuleResolutionCache(root, (name) => name, options);
  const host = {
    ...ts.sys,
    fileExists: memoizePath(ts.sys.fileExists),
    directoryExists: memoizePath(ts.sys.directoryExists),
  };
  const graph = new Map<string, Edge[]>();
  for (const file of files) {
    if (!CODE.test(file)) continue;
    const edges: Edge[] = [];
    graph.set(file, edges);
    const text = read(file);
    const { importedFiles } = ts.preProcessFile(text, true, true);
    if (importedFiles.length === 0) continue;
    const starts = lineStarts(text);
    const from = join(root, file);
    for (const imported of importedFiles) {
      const resolved = ts.resolveModuleName(imported.fileName, from, options, host, cache).resolvedModule;
      if (resolved === undefined || resolved.isExternalLibraryImport === true) continue;
      const target = relative(root, resolved.resolvedFileName).split(sep).join("/");
      if (!target.startsWith("../")) edges.push({ target, specifier: imported.fileName, line: lineAt(starts, imported.pos) });
    }
  }
  return graph;
}

const generated = (id: string): string => `.warden/generated/${id}.rules.json`;

const LOADER = fileURLToPath(new URL(`./module-loader${extname(fileURLToPath(import.meta.url))}`, import.meta.url));

const LOAD_TIMEOUT_MS = 120_000;

const loadError = (stderr: string): string => {
  const lines = stderr.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.find((line) => /^[A-Za-z]*Error\b/.test(line)) ?? lines.at(-1) ?? "it printed nothing";
};

const moduleLoader = (root: string): ((file: string) => unknown) => {
  const loaded = new Map<string, { value: unknown } | { error: string }>();
  return (file) => {
    let result = loaded.get(file);
    if (result === undefined) {
      const child = spawnSync(process.execPath, [LOADER, join(root, file)], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: LOAD_TIMEOUT_MS, stdio: ["ignore", "ignore", "pipe", "pipe"] });
      const written = (child.output[3] ?? "") as string;
      if (child.error !== undefined) result = { error: `${file} did not load: ${child.error.message}` };
      else if (child.status !== 0) result = { error: `${file} did not load: ${loadError(child.stderr)}` };
      else if (written === "") result = { error: `${file} did not load: it exited before Warden's loader wrote its exports` };
      else result = { value: JSON.parse(written) as unknown };
      loaded.set(file, result);
    }
    if ("error" in result) throw new Error(result.error);
    return result.value;
  };
};

const treeAdapter = (id: "fs" | "graph" | "module"): Adapter => ({
  id,
  wholeTree: true,
  emit(gs: Guardrail[], set: RecordSet): Record<string, string> {
    const entries = gs.map((g): Entry => {
      const pack = set.packs.find((p) => p.practices.some((x) => x.guardrails.includes(g)));
      const practice = pack?.practices.find((x) => x.guardrails.includes(g));
      if (pack === undefined || practice === undefined) throw new Error(`guardrail ${g.id} belongs to no practice`);
      const settings = set.config.packs.find((p) => p.id === pack.id)?.settings;
      return { guardrail: g.id, groups: pathGroups(practice.paths, set.config.packs.find((p) => p.id === pack.id)?.paths ?? []), ...(settings === undefined ? {} : { settings }) };
    });
    const terms = set.packs.flatMap((p) => p.terms.map(({ id: term, bans }) => ({ id: term, bans })));
    return { [generated(id)]: `${JSON.stringify({ terms, entries }, null, 2)}\n` };
  },
  async run(gs: Guardrail[], files: string[], ctx: RunContext): Promise<RunResult[]> {
    const { terms, entries } = JSON.parse(await readFile(join(ctx.generatedDir, `${id}.rules.json`), "utf8")) as { terms: Pick<Term, "id" | "bans">[]; entries: Entry[] };
    const texts = new Map<string, string>();
    const read = (file: string): string => {
      if (!texts.has(file)) texts.set(file, readFileSync(join(ctx.root, file), "utf8"));
      return texts.get(file) as string;
    };
    const start = performance.now();
    const imports = id === "graph" ? await importGraph(ctx.root, files, read) : undefined;
    const known = new Set(files);
    const nonRegular = new Set(ctx.projectInventory?.nonRegular);
    const projectRoot = ctx.projectInventory === undefined ? undefined : realpathSync(ctx.root);
    const unitStructure = ctx.unitStructure;
    const owner = unitStructure === undefined ? undefined : unitLookup(unitStructure.units, unitStructure.ignoreCase);
    const structure = owner === undefined ? undefined : {
      ...unitStructure,
      owners: Object.fromEntries(files.map((file) => [file, owner(posix.dirname(file))?.id ?? null])),
    };
    const prepMs = performance.now() - start + (ctx.projectInventory?.discoveryMs ?? 0);
    const loadModule = id === "module" ? moduleLoader(ctx.root) : undefined;
    const out: RunResult[] = [];
    for (const g of gs) {
      const entry = entries.find((e) => e.guardrail === g.id);
      if (entry === undefined) throw new RecordError(generated(id), "", `has no entry for Guardrail ${g.id}. Next action: run warden compile.`);
      const code = await packEntry(g, id);
      const input = { files: g.scope === "project" ? files : files.filter((f) => enabledOn(f, entry.groups)), ...(nonRegular.size > 0 ? { nonRegular: [...nonRegular] } : {}), all: files, ...(imports === undefined ? {} : { imports: [...imports] }), settings: entry.settings ?? {}, options: g.options ?? null, terms, ...(loadModule === undefined ? {} : { loads: true }), ...(g.scope === "project" && structure !== undefined ? { unitStructure: structure } : {}) };
      const insideWorktree = (file: string, verb: string): void => {
        if (!known.has(file)) throw new Error(`${file} is not one of the files the check was given`);
        const root = projectRoot ?? realpathSync(ctx.root);
        const path = join(root, file);
        const rel = relative(root, realpathSync(path));
        if (nonRegular.has(file) || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || (projectRoot !== undefined && !lstatSync(path).isFile())) {
          throw new Error(`${file} must be a regular file in the worktree to be ${verb}`);
        }
      };
      const given = (file: string): string => {
        if (projectRoot === undefined) {
          if (!known.has(file)) throw new Error(`${file} is not one of the files the check was given`);
        } else insideWorktree(file, "read");
        return read(file);
      };
      const load = loadModule === undefined ? undefined : (file: string): unknown => {
        insideWorktree(file, "loaded");
        return loadModule(file);
      };
      const { found, ms } = await inSandbox<{ found: Found[]; ms: number }>(code, { kind: "tree", entry: code, input }, given, ctx.signal, load);
      const violations = found.map((v): Violation => {
        if (!known.has(v.file) && !(g.scope === "project" && v.file === "")) {
          const file = join(g.packDir as string, `${id}.js`);
          throw new RecordError(file, "", `${g.implementation} reported ${v.file}, which is not one of the files it was given. Next action: make ${g.implementation} in ${file} report only files from its input, then run warden compile.`);
        }
        return { guardrail: g.id, file: v.file, line: v.line ?? 1, ...(v.endLine === undefined ? {} : { endLine: v.endLine }), message: v.message, ...(v.doThis === undefined ? {} : { doThis: v.doThis }) };
      });
      out.push({ guardrail: g.id, status: violations.length > 0 ? "fail" : "pass", violations, ms: prepMs + ms });
    }
    return out;
  },
});

export const fsAdapter = treeAdapter("fs");

export const graphAdapter = treeAdapter("graph");

export const moduleAdapter = treeAdapter("module");
