import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Adapter, RunResult } from "../adapters/types.js";
import type { Finding } from "./consistency.js";
import { enabledOn, examplePrefix, withExampleProject } from "./examples.js";
import { canonicalJson, sha256 } from "./lock.js";
import { RecordError } from "../records/load.js";
import { pathGroups } from "../records/paths.js";
import { type BenchSettings, type Guardrail, type Pack, type RecordSet, benchSettings } from "../records/types.js";
import { readBenchCache, writeBenchCache } from "../runner/cache.js";
import type { Measurement, Verdict } from "../runner/evidence.js";
import { adapters, runGuardrails } from "../runner/run.js";

const RUNS = 3;

const FIXED_RUNS = 9;

export const RANK: Verdict[] = ["constant", "sublinear", "linear", "superlinear"];

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export const slope = (points: [number, number][], f: number): number => {
  const xs = points.map(([n]) => Math.log(n));
  const ys = points.map(([, ms]) => Math.log(Math.max(ms - f, 0.001)));
  const mx = mean(xs);
  const my = mean(ys);
  return xs.reduce((n, x, i) => n + (x - mx) * ((ys[i] as number) - my), 0) / xs.reduce((n, x) => n + (x - mx) ** 2, 0);
};

export interface Subject {
  id: string;
  g: Guardrail;
  pack: Pack;
  practice: string;
  prefix: string;
  groups: string[][];
  time: (r: RunResult) => number;
}

export const prefixOf = (g: Guardrail): string => g.implementation.slice(0, g.implementation.indexOf(":"));

const copyOf = (g: Guardrail, prefix: string, i: number): { path: string; original: string; content: string }[] =>
  typeof g.mustPass === "string"
    ? [{ path: `${prefix}warden-example-${i}.ts`, original: `${prefix}warden-example.ts`, content: g.mustPass }]
    : Object.entries(g.mustPass ?? {}).map(([path, content]) => ({ path: i === 0 ? path : `${prefix}bench-${i}/${path}`, original: path, content }));

const refuseUnmatched = (s: Subject, rerun: string): void => {
  if (prefixOf(s.g) === "cmd") return;
  const lost = copyOf(s.g, s.prefix, 1).find((c) => enabledOn(c.original, s.groups) && !enabledOn(c.path, s.groups));
  if (lost === undefined) return;
  throw new RecordError(
    s.pack.file,
    `/guardrails/${s.g.id}/mustPass`,
    `Guardrail ${s.g.id} would not run on ${lost.path}, a copy of its mustPass example, because it is outside ${s.groups.map((g) => g.join(" & ")).join(", ")}. Next action: change the paths of Practice ${s.practice} in ${s.pack.file} so they also match files in a subfolder, or make the mustPass example of Guardrail ${s.g.id} a single file, then run ${rerun}.`,
  );
};

const WRITE_BATCH = 64;

const writeTree = async (root: string, tree: Record<string, string>): Promise<void> => {
  const entries = Object.entries(tree);
  for (let i = 0; i < entries.length; i += WRITE_BATCH) {
    await Promise.all(
      entries.slice(i, i + WRITE_BATCH).map(async ([path, content]) => {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
      }),
    );
  }
};

const measure = (set: RecordSet, s: Subject, cfg: BenchSettings, rerun: string, signal?: AbortSignal): Promise<Measurement> =>
  withExampleProject(async (project) => {
    const ctx = { root: project, generatedDir: join(project, ".warden/generated"), unbudgeted: true, signal };
    await writeTree(project, (adapters.get(prefixOf(s.g)) as Adapter).emit([s.g], set));
    const files: string[] = [];
    let copies = 0;
    const sample = async (n: number, runs = RUNS): Promise<number> => {
      signal?.throwIfAborted();
      const tree: Record<string, string> = {};
      for (; copies < n; copies++) {
        for (const c of copyOf(s.g, s.prefix, copies)) {
          tree[c.path] = c.content;
          files.push(c.path);
        }
      }
      await writeTree(project, tree);
      const times: number[] = [];
      for (let i = 0; i < runs; i++) {
        signal?.throwIfAborted();
        const results = await runGuardrails(set, [s.g], files, ctx);
        signal?.throwIfAborted();
        const bad = results.find((r) => r.status !== "pass");
        if (bad !== undefined) {
          throw new RecordError(
            s.pack.file,
            `/guardrails/${s.g.id}/mustPass`,
            `Guardrail ${s.g.id} failed on a copy of its mustPass example at ${bad.violations[0]?.file || files[0]}. Next action: change the mustPass example of Guardrail ${s.g.id} in ${s.pack.file} so every copy of it passes, then run ${rerun}.`,
          );
        }
        const own = results.find((r) => r.guardrail === s.g.id);
        if (own === undefined) throw new Error(`no result for guardrail ${s.g.id}`);
        times.push(s.time(own));
      }
      return Math.min(...times);
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
    const f = await sample(1, FIXED_RUNS);
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

export const benchSubject = async (set: RecordSet, s: Subject, cfg: BenchSettings, rerun: string, signal?: AbortSignal): Promise<Measurement & { previous?: Measurement }> => {
  refuseUnmatched(s, rerun);
  const first = await measure(set, s, cfg, rerun, signal);
  if (first.verdict !== "superlinear") return first;
  return { ...(await measure(set, s, cfg, rerun, signal)), previous: first };
};

export const subjectsOf = (set: RecordSet, gs: Guardrail[]): Subject[] =>
  set.packs.flatMap((pack) =>
    pack.practices.flatMap((x) => {
      const groups = pathGroups(x.paths, set.config.packs.find((p) => p.id === pack.id)?.paths ?? []);
      const prefix = examplePrefix(groups[0]);
      return x.guardrails.filter((g) => gs.includes(g)).map((g): Subject => ({ id: g.id, g, pack, practice: x.id, prefix, groups, time: (r) => r.ruleMs ?? r.ms }));
    }),
  );


const r1 = (n: number): number => Math.round(n * 10) / 10;

export const pointsText = (m: Measurement): string => `${m.points.map(([n, ms]) => `${n} files ${r1(ms)}ms`).join(", ")}; fixed ${r1(m.f)}ms`;

export async function admit(set: RecordSet, warden: string): Promise<Finding[]> {
  const cfg = benchSettings(set.config);
  const gs = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.filter((g) => g.kind !== "instruction")));
  const findings: Finding[] = [];
  for (const s of subjectsOf(set, gs)) {
    const key = sha256(canonicalJson(["bench", s.g.id, s.g.version, s.g.implementation, s.g.options ?? null, warden, cfg, s.groups]));
    if (readBenchCache(key) !== undefined) continue;
    let m: Measurement;
    try {
      m = await benchSubject(set, s, cfg, "warden compile");
    } catch (cause) {
      if (!(cause instanceof RecordError)) throw cause;
      findings.push({ code: "bench-failed", record: s.g.id, message: cause.message });
      continue;
    }
    if (m.verdict === "superlinear") {
      findings.push({
        code: "superlinear",
        record: s.g.id,
        message: `Guardrail ${s.g.id} is superlinear in files (k=${(m.k as number).toFixed(2)}, measured twice); points: ${pointsText(m)}. Next action: make ${s.g.id} linear in files, then run warden compile.`,
      });
      continue;
    }
    writeBenchCache(key, m);
  }
  return findings;
}
