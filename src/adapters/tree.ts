import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { RecordError } from "../records/load.js";
import { enabledOn, pathGroups } from "../records/paths.js";
import type { Guardrail, RecordSet, Term } from "../records/types.js";
import { packEntry } from "./pack-code.js";
import { inSandbox } from "./sandbox.js";
import type { Adapter, RunContext, RunResult, Violation } from "./types.js";

export interface Edge {
  target: string;
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
  return { ...ts.parseJsonConfigFileContent(config, ts.sys, root).options, allowJs: true };
};

export async function importGraph(root: string, files: string[], read: (file: string) => string): Promise<Map<string, Edge[]>> {
  const { default: ts } = await import("typescript");
  const options = await compilerOptions(root);
  const cache = ts.createModuleResolutionCache(root, (name) => name, options);
  const graph = new Map<string, Edge[]>();
  for (const file of files.filter((f) => CODE.test(f))) {
    const text = read(file);
    const starts = lineStarts(text);
    const edges: Edge[] = [];
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      const resolved = ts.resolveModuleName(imported.fileName, join(root, file), options, ts.sys, cache).resolvedModule;
      if (resolved === undefined || resolved.isExternalLibraryImport === true) continue;
      const target = relative(root, resolved.resolvedFileName).split(sep).join("/");
      if (!target.startsWith("../")) edges.push({ target, line: lineAt(starts, imported.pos) });
    }
    graph.set(file, edges);
  }
  return graph;
}

const generated = (id: string): string => `.warden/generated/${id}.rules.json`;

const treeAdapter = (id: "fs" | "graph"): Adapter => ({
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
    const graphMs = performance.now() - start;
    const known = new Set(files);
    const out: RunResult[] = [];
    for (const g of gs) {
      const entry = entries.find((e) => e.guardrail === g.id);
      if (entry === undefined) throw new RecordError(generated(id), "", `has no entry for Guardrail ${g.id}. Next action: run warden compile.`);
      const code = await packEntry(g, id);
      const input = { files: files.filter((f) => enabledOn(f, entry.groups)), all: files, ...(imports === undefined ? {} : { imports: [...imports] }), settings: entry.settings ?? {}, options: g.options ?? null, terms };
      const given = (file: string): string => {
        if (!known.has(file)) throw new Error(`${file} is not one of the files the check was given`);
        return read(file);
      };
      const { found, ms } = await inSandbox<{ found: Found[]; ms: number }>(code, { kind: "tree", entry: code, input }, given, ctx.signal);
      const violations = found.map((v): Violation => {
        if (!known.has(v.file)) {
          const file = join(g.packDir as string, `${id}.js`);
          throw new RecordError(file, "", `${g.implementation} reported ${v.file}, which is not one of the files it was given. Next action: make ${g.implementation} in ${file} report only files from its input, then run warden compile.`);
        }
        return { guardrail: g.id, file: v.file, line: v.line ?? 1, ...(v.endLine === undefined ? {} : { endLine: v.endLine }), message: v.message, ...(v.doThis === undefined ? {} : { doThis: v.doThis }) };
      });
      out.push({ guardrail: g.id, status: violations.length > 0 ? "fail" : "pass", violations, ms: graphMs + ms });
    }
    return out;
  },
});

export const fsAdapter = treeAdapter("fs");

export const graphAdapter = treeAdapter("graph");
