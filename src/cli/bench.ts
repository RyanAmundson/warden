import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Adapter, RunResult } from "../adapters/types.js";
import { wardenVersion } from "../compiler/compile.js";
import { enabledOn, examplePrefix, withExampleProject } from "../compiler/examples.js";
import { RecordError, loadRecords } from "../records/load.js";
import { pathGroups } from "../records/paths.js";
import type { BenchSettings, Guardrail, Pack, RecordSet } from "../records/types.js";
import { ESLINT_PASS, type Measurement, type Verdict, appendEvidence } from "../runner/evidence.js";
import { adapters, runGuardrails } from "../runner/run.js";

export const BENCH_DEFAULTS: BenchSettings = { baseFiles: 25, maxFiles: 3200, minMarginalMs: 20, linearMax: 1.15, sublinearMax: 0.9, constantMs: 5 };

const RUNS = 3;

const RANK: Verdict[] = ["constant", "sublinear", "linear", "superlinear"];

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export const slope = (points: [number, number][], f: number): number => {
  const xs = points.map(([n]) => Math.log(n));
  const ys = points.map(([, ms]) => Math.log(Math.max(ms - f, 0.001)));
  const mx = mean(xs);
  const my = mean(ys);
  return xs.reduce((n, x, i) => n + (x - mx) * ((ys[i] as number) - my), 0) / xs.reduce((n, x) => n + (x - mx) ** 2, 0);
};

interface Subject {
  id: string;
  g: Guardrail;
  pack: Pack;
  practice: string;
  prefix: string;
  groups: string[][];
  time: (r: RunResult) => number;
}

const prefixOf = (g: Guardrail): string => g.implementation.slice(0, g.implementation.indexOf(":"));

const copyOf = (g: Guardrail, prefix: string, i: number): { path: string; original: string; content: string }[] =>
  typeof g.mustPass === "string"
    ? [{ path: `${prefix}warden-example-${i}.ts`, original: `${prefix}warden-example.ts`, content: g.mustPass }]
    : Object.entries(g.mustPass ?? {}).map(([path, content]) => ({ path: `${prefix}bench-${i}/${path}`, original: path, content }));

const refuseUnmatched = (s: Subject): void => {
  if (prefixOf(s.g) === "cmd") return;
  const lost = copyOf(s.g, s.prefix, 0).find((c) => enabledOn(c.original, s.groups) && !enabledOn(c.path, s.groups));
  if (lost === undefined) return;
  throw new RecordError(
    s.pack.file,
    `/guardrails/${s.g.id}/mustPass`,
    `Guardrail ${s.g.id} would not run on ${lost.path}, a copy of its mustPass example, because it is outside ${s.groups.map((g) => g.join(" & ")).join(", ")}. Next action: change the paths of Practice ${s.practice} in ${s.pack.file} so they also match files in a subfolder, or make the mustPass example of Guardrail ${s.g.id} a single file, then run warden bench.`,
  );
};

const writeTree = async (root: string, tree: Record<string, string>): Promise<void> => {
  for (const [path, content] of Object.entries(tree)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};

const measure = (set: RecordSet, s: Subject, cfg: BenchSettings): Promise<Measurement> =>
  withExampleProject(async (project) => {
    const ctx = { root: project, generatedDir: join(project, ".warden/generated"), unbudgeted: true };
    await writeTree(project, (adapters.get(prefixOf(s.g)) as Adapter).emit([s.g], set));
    const files: string[] = [];
    let copies = 0;
    const sample = async (n: number): Promise<number> => {
      for (; copies < n; copies++) {
        const copy = copyOf(s.g, s.prefix, copies);
        await writeTree(project, Object.fromEntries(copy.map((c) => [c.path, c.content])));
        files.push(...copy.map((c) => c.path));
      }
      const times: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const results = await runGuardrails(set, [s.g], files, ctx);
        const bad = results.find((r) => r.status !== "pass");
        if (bad !== undefined) {
          throw new RecordError(
            s.pack.file,
            `/guardrails/${s.g.id}/mustPass`,
            `Guardrail ${s.g.id} failed on a copy of its mustPass example at ${bad.violations[0]?.file ?? files[0]}. Next action: change the mustPass example of Guardrail ${s.g.id} in ${s.pack.file} so every copy of it passes, then run warden bench.`,
          );
        }
        const own = results.find((r) => r.guardrail === s.g.id);
        if (own === undefined) throw new Error(`no result for guardrail ${s.g.id}`);
        times.push(s.time(own));
      }
      return median(times);
    };
    const seen = new Map<number, number>();
    const at = async (n: number): Promise<number> => {
      if (!seen.has(n)) seen.set(n, await sample(n));
      return seen.get(n) as number;
    };
    const sizes = async (base: number): Promise<[number, number][]> => {
      const points: [number, number][] = [];
      for (const m of [1, 2, 4, 8]) points.push([base * m, await at(base * m)]);
      return points;
    };
    const f = await at(1);
    let base = cfg.baseFiles;
    while ((await at(base)) - f < cfg.minMarginalMs) {
      if (base * 16 > cfg.maxFiles) return { verdict: "constant", points: await sizes(cfg.baseFiles), f };
      base *= 2;
    }
    const points = await sizes(base);
    if ((points[3] as [number, number])[1] - f < cfg.constantMs) return { verdict: "constant", points, f };
    const k = slope(points, f);
    return { verdict: k > cfg.linearMax ? "superlinear" : k < cfg.sublinearMax ? "sublinear" : "linear", k, points, f };
  });

export const benchSubject = async (set: RecordSet, s: Subject, cfg: BenchSettings): Promise<Measurement & { previous?: Measurement }> => {
  refuseUnmatched(s);
  const first = await measure(set, s, cfg);
  if (first.verdict !== "superlinear") return first;
  return { ...(await measure(set, s, cfg)), previous: first };
};

const worst = (ms: Measurement[]): Measurement =>
  ms.reduce((a, b) => (RANK.indexOf(b.verdict) > RANK.indexOf(a.verdict) || (b.verdict === a.verdict && (b.k ?? 0) > (a.k ?? 0)) ? b : a));

export const subjectsOf = (set: RecordSet, gs: Guardrail[]): Subject[] =>
  set.packs.flatMap((pack) =>
    pack.practices.flatMap((x) => {
      const groups = pathGroups(x.paths, set.config.packs.find((p) => p.id === pack.id)?.paths ?? []);
      const prefix = examplePrefix(groups[0]);
      return x.guardrails.filter((g) => gs.includes(g)).map((g): Subject => ({ id: g.id, g, pack, practice: x.id, prefix, groups, time: (r) => r.ruleMs ?? r.ms }));
    }),
  );

const select = (set: RecordSet, rule: string | undefined, pack: string | undefined): Guardrail[] => {
  if (pack !== undefined && !set.packs.some((p) => p.id === pack)) {
    throw new RecordError("", "/pack", `no pack has id "${pack}". Next action: run warden packs to list pack ids, then run warden bench --pack <id>.`);
  }
  const gs = set.packs
    .filter((p) => pack === undefined || p.id === pack)
    .flatMap((p) => p.practices.flatMap((x) => x.guardrails.filter((g) => g.kind !== "instruction" && (rule === undefined || g.id === rule || x.id === rule))));
  if (rule !== undefined && gs.length === 0) {
    throw new RecordError("", "/rule", `no Practice or Guardrail has id "${rule}". Next action: run warden report to list Guardrail ids, then run warden bench --rule <id>.`);
  }
  return gs;
};

const r1 = (n: number): number => Math.round(n * 10) / 10;

export async function runBench(root: string, wardenRoot: string, opts: { rule?: string; pack?: string }): Promise<number> {
  try {
    const set = await loadRecords(root, wardenRoot);
    const cfg = { ...BENCH_DEFAULTS, ...set.config.bench };
    const subjects = subjectsOf(set, select(set, opts.rule, opts.pack));
    const warden = await wardenVersion(wardenRoot);
    const at = new Date().toISOString();
    const rows: { indent: string; label: string; m: Measurement; id?: string }[] = [];
    const record = (key: { guardrail: string } | { pack: string }, m: Measurement): void => appendEvidence(set.config.project, { at, kind: "scaling", ...key, ...m, warden });
    for (const pack of set.packs) {
      const own = subjects.filter((s) => s.pack === pack);
      if (own.length === 0) continue;
      const measured: Measurement[] = [];
      const inner: typeof rows = [];
      for (const s of own) {
        const m = await benchSubject(set, s, cfg);
        record({ guardrail: s.id }, m);
        measured.push(m);
        inner.push({ indent: "    ", label: s.id, m, id: s.id });
      }
      const { previous: _, ...packM } = worst(measured) as Measurement & { previous?: Measurement };
      record({ pack: pack.id }, packM);
      rows.push({ indent: "  ", label: `pack ${pack.id}`, m: packM }, ...inner);
    }
    const lint = subjects.find((s) => prefixOf(s.g) === "eslint");
    if (lint !== undefined) {
      const m = await benchSubject(set, { ...lint, id: ESLINT_PASS, time: (r) => r.ms - (r.ruleMs ?? 0) }, cfg);
      record({ guardrail: ESLINT_PASS }, m);
      rows.push({ indent: "  ", label: ESLINT_PASS, m, id: ESLINT_PASS });
    }
    const width = Math.max(0, ...rows.map((r) => r.indent.length + r.label.length)) + 2;
    const lines = [`scaling (warden bench at ${warden}, ${at.slice(0, 10)})`];
    for (const { indent, label, m } of rows) {
      const k = m.k === undefined ? "" : `k=${m.k.toFixed(2)}`;
      lines.push(`${`${indent}${label}`.padEnd(width)}${m.verdict.padEnd(13)}${k}${m.verdict === "superlinear" ? "  DEFECT" : ""}`.trimEnd());
    }
    const defects = rows.filter((r) => r.id !== undefined && r.m.verdict === "superlinear");
    for (const { id, m } of defects) {
      lines.push(`${id} points: ${m.points.map(([n, ms]) => `${n} files ${r1(ms)}ms`).join(", ")}; fixed ${r1(m.f)}ms`);
    }
    if (defects.length > 0) lines.push(`Next action: make ${defects.map((d) => d.id).join(", ")} linear in files; see the four points above.`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return defects.length > 0 ? 1 : 0;
  } catch (cause) {
    if (!(cause instanceof RecordError)) throw cause;
    process.stderr.write(`${cause.file} ${cause.pointer}: ${cause.message}\n`);
    return 2;
  }
}
