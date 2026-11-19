import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { RecordError } from "../records/load.js";
import { enabledOn, pathGroups } from "../records/paths.js";
import type { Guardrail, RecordSet, Term } from "../records/types.js";
import { packCode } from "./pack-code.js";
import type { Adapter, RunContext, RunResult, Violation } from "./types.js";

export interface Edge {
  target: string;
  line: number;
}

export interface TreeInput {
  files: string[];
  all: string[];
  read: (file: string) => string;
  imports?: Map<string, Edge[]>;
  settings: Record<string, unknown>;
  options: unknown;
  terms: Pick<Term, "id" | "bans">[];
}

export interface Found {
  file: string;
  line?: number;
  message: string;
  doThis?: string;
}

export type TreeCheck = (input: TreeInput) => Found[];

interface Entry {
  guardrail: string;
  groups: string[][];
  settings?: Record<string, unknown>;
}

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const lineAt = (text: string, pos: number): number => text.slice(0, pos).split("\n").length;

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
    const edges: Edge[] = [];
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      const resolved = ts.resolveModuleName(imported.fileName, join(root, file), options, ts.sys, cache).resolvedModule;
      if (resolved === undefined || resolved.isExternalLibraryImport === true) continue;
      const target = relative(root, resolved.resolvedFileName).split(sep).join("/");
      if (!target.startsWith("../")) edges.push({ target, line: lineAt(text, imported.pos) });
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
    const { terms, entries } = JSON.parse(await readFile(join(ctx.generatedDir, `${id}.rules.json`), "utf8")) as { terms: TreeInput["terms"]; entries: Entry[] };
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
      const check = await packCode<TreeCheck>(g, id);
      const begin = performance.now();
      const found = check({ files: files.filter((f) => enabledOn(f, entry.groups)), all: files, read, ...(imports === undefined ? {} : { imports }), settings: entry.settings ?? {}, options: g.options, terms });
      const violations = found.map((v): Violation => {
        if (!known.has(v.file)) {
          const file = join(g.packDir as string, `${id}.js`);
          throw new RecordError(file, "", `${g.implementation} reported ${v.file}, which is not one of the files it was given. Next action: make ${g.implementation} in ${file} report only files from its input, then run warden compile.`);
        }
        return { guardrail: g.id, file: v.file, line: v.line ?? 1, message: v.message, ...(v.doThis === undefined ? {} : { doThis: v.doThis }) };
      });
      out.push({ guardrail: g.id, status: violations.length > 0 ? "fail" : "pass", violations, ms: graphMs + performance.now() - begin });
    }
    return out;
  },
});

export const fsAdapter = treeAdapter("fs");

export const graphAdapter = treeAdapter("graph");
