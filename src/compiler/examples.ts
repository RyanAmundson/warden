import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob, posix } from "node:path";
import { adapters, runGuardrails, unknownAdapters } from "../runner/run.js";
import { pathGroups } from "../records/paths.js";
import type { Example, Guardrail, RecordSet } from "../records/types.js";
import { type Adapter, PARSE_ERROR } from "../adapters/types.js";
import type { Finding } from "./consistency.js";

const TSCONFIG = JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: true }, include: ["**/*.ts"] });

const literal = (glob: string): string => glob.split("*", 1)[0] ?? "";

export const examplePrefix = (group: string[] | undefined): string => (group ?? []).map(literal).reduce((a, b) => (b.length > a.length ? b : a), "");

const exampleFile = (group: string[] | undefined): string => `${examplePrefix(group)}warden-example.ts`;

const SCAFFOLD = ["package.json", "tsconfig.json"];

const ownedBy = (owned: Set<string>) => (key: string): boolean => {
  const path = posix.normalize(key).toLowerCase();
  const first = path.split("/")[0];
  return first === "node_modules" || first === ".warden" || [...owned].some((o) => path === o || path.startsWith(`${o}/`));
};

export const enabledOn = (file: string, groups: string[][]): boolean => groups.length === 0 || groups.some((g) => g.every((glob) => matchesGlob(file, glob)));

export async function withExampleProject<T>(fn: (project: string) => Promise<T>): Promise<T> {
  const project = await mkdtemp(join(tmpdir(), "warden-examples-"));
  try {
    await writeFile(join(project, "package.json"), "{}\n");
    await writeFile(join(project, "tsconfig.json"), TSCONFIG);
    return await fn(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

export async function runExamples(set: RecordSet): Promise<Finding[]> {
  const unknown = unknownAdapters(set).map(({ code, record, message }) => ({ code, record, message }));
  if (unknown.length > 0) return unknown;
  const findings: Finding[] = [];
  await withExampleProject(async (project) => {
    const checked: { g: Guardrail; file: string; groups: string[][]; packFile: string }[] = [];
    const ctx = { root: project, generatedDir: join(project, ".warden/generated") };
    const emittedPaths = set.packs
      .flatMap((p) => p.practices.flatMap((x) => x.guardrails))
      .flatMap((g) => {
        const adapter = g.kind === "instruction" ? undefined : adapters.get(g.implementation.slice(0, g.implementation.indexOf(":")));
        return adapter === undefined ? [] : Object.keys(adapter.emit([g], set));
      });
    const owned = ownedBy(new Set([...SCAFFOLD, ...emittedPaths].map((p) => p.toLowerCase())));
    for (const pack of set.packs) {
      for (const practice of pack.practices) {
        const groups = pathGroups(practice.paths, set.config.packs.find((p) => p.id === pack.id)?.paths ?? []);
        const file = exampleFile(groups[0]);
        for (const g of practice.guardrails) {
          if (g.kind === "instruction") continue;
          const adapter = adapters.get(g.implementation.slice(0, g.implementation.indexOf(":"))) as Adapter;
          checked.push({ g, file, groups, packFile: pack.file });
          const then = `in ${pack.file}, then run warden compile.`;
          for (const [label, want] of [["mustFail", "fail"], ["mustPass", "pass"]] as const) {
            const source = g[label];
            if (source === undefined) {
              findings.push({ code: "example-failed", record: g.id, message: `Guardrail ${g.id} has no ${label} example. Next action: add ${label} to Guardrail ${g.id} ${then}` });
              continue;
            }
            const unsafe = typeof source === "string" ? undefined : Object.keys(source).find(owned);
            if (unsafe !== undefined) {
              findings.push({ code: "example-unsafe", record: g.id, message: `Guardrail ${g.id} ${label} example writes ${unsafe}, which Warden's example project owns (node_modules, .warden, package.json, tsconfig.json, and emitted configs). Next action: move ${unsafe} to another path in the ${label} example of Guardrail ${g.id} ${then}` });
              continue;
            }
            const status = await runExample(set, g, adapter.emit([g], set), source, file, ctx);
            if (status === "parse-error") {
              findings.push({ code: "example-failed", record: g.id, message: `Guardrail ${g.id} ${label} example does not parse. Next action: fix the syntax of the ${label} example of Guardrail ${g.id} ${then}` });
            } else if (status === "over-budget") {
              findings.push({ code: "over-budget", record: g.id, message: `Guardrail ${g.id} ran longer than its ${g.budgetMs} ms budget on its ${label} example. Next action: make the ${label} example of Guardrail ${g.id} finish within ${g.budgetMs} ms ${then}` });
            } else if (status !== want) {
              findings.push({ code: "example-failed", record: g.id, message: `Guardrail ${g.id} ${label} example did not ${want}. Next action: change the ${label} example of Guardrail ${g.id} in ${pack.file} so ${g.implementation} ${want}s on it, then run warden compile.` });
            }
          }
        }
      }
    }
    for (const { g, file, packFile } of checked) {
      if (typeof g.mustPass !== "string") continue;
      for (const other of checked) {
        if (other.g === g || other.g.implementation.startsWith("cmd:") || !enabledOn(file, other.groups)) continue;
        const adapter = adapters.get(other.g.implementation.slice(0, other.g.implementation.indexOf(":"))) as Adapter;
        const status = await runExample(set, other.g, adapter.emit([other.g], set), g.mustPass, file, ctx);
        if (status === "fail") {
          findings.push({ code: "example-conflict", record: g.id, message: `Guardrail ${g.id} mustPass example fails Guardrail ${other.g.id}. Next action: change the mustPass example of Guardrail ${g.id} in ${packFile} so it also passes ${other.g.id}, then run warden compile.` });
        }
      }
    }
  });
  return findings;
}

async function runExample(
  set: RecordSet,
  g: Guardrail,
  emitted: Record<string, string>,
  source: Example,
  file: string,
  ctx: { root: string; generatedDir: string },
): Promise<string> {
  const tree = typeof source === "string" ? { [file]: source } : source;
  const made: string[] = [];
  try {
    for (const [path, content] of Object.entries(emitted)) {
      await mkdir(dirname(join(ctx.root, path)), { recursive: true });
      await writeFile(join(ctx.root, path), content);
    }
    for (const [path, content] of Object.entries(tree)) {
      const dir = await mkdir(dirname(join(ctx.root, path)), { recursive: true });
      if (dir !== undefined) made.push(dir);
      await writeFile(join(ctx.root, path), content);
    }
    const results = await runGuardrails(set, [g], Object.keys(tree), ctx);
    if (results.some((r) => r.guardrail === PARSE_ERROR && r.status === "fail")) return "parse-error";
    const own = results.find((r) => r.guardrail === g.id);
    if (own === undefined) throw new Error(`no result for guardrail ${g.id}`);
    return own.status === "killed" || own.overBudget === true ? "over-budget" : own.status;
  } finally {
    for (const path of Object.keys(tree)) await rm(join(ctx.root, path), { force: true });
    for (const dir of made) await rm(dir, { recursive: true, force: true });
  }
}
