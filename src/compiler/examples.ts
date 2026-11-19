import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { adapters, runGuardrails, unknownAdapters } from "../runner/run.js";
import { enabledOn, literalOf, pathGroups } from "../records/paths.js";
import { exampleSet } from "../records/load.js";
import type { Example, Guardrail, RecordSet } from "../records/types.js";
import { type Adapter, PARSE_ERROR } from "../adapters/types.js";
import type { Finding } from "./consistency.js";

const TSCONFIG = JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: true }, include: ["**/*.ts"] });

export const examplePrefix = (group: string[] | undefined): string => (group ?? []).map(literalOf).reduce((a, b) => (b.length > a.length ? b : a), "");

const exampleFile = (group: string[] | undefined): string => `${examplePrefix(group)}warden-example.ts`;

const SCAFFOLD = ["package.json", "tsconfig.json"];

const ownedBy = (owned: Set<string>) => (key: string): boolean => {
  const path = posix.normalize(key).toLowerCase();
  const first = path.split("/")[0];
  return first === "node_modules" || first === ".warden" || [...owned].some((o) => path === o || path.startsWith(`${o}/`));
};

interface Unremoved {
  project: string;
  cause: string;
}

const unremoved = (failures: Unremoved[]): Error =>
  new Error(
    `Warden could not remove ${failures.length === 1 ? "its example project" : `${failures.length} example projects:`} ${failures.map((f) => `${f.project} (${f.cause})`).join(", ")}. Next action: delete ${failures.map((f) => f.project).join(" and ")}, then run the command again.`,
  );

const removals = new Set<Promise<void>>();

export const exampleProjectsRemoved = async (): Promise<void> => {
  const pending = [...removals];
  removals.clear();
  const failures = (await Promise.allSettled(pending)).flatMap((r) => (r.status === "rejected" ? [r.reason as Unremoved] : []));
  if (failures.length > 0) throw unremoved(failures);
};

export async function thenRemoveExampleProjects(run: () => Promise<void>, report: (cause: unknown) => void): Promise<void> {
  try {
    await run();
  } catch (cause) {
    report(cause);
  }
  try {
    await exampleProjectsRemoved();
  } catch (cause) {
    report(cause);
  }
}

const IDENTITY = { GIT_AUTHOR_NAME: "warden", GIT_AUTHOR_EMAIL: "warden@example.invalid", GIT_COMMITTER_NAME: "warden", GIT_COMMITTER_EMAIL: "warden@example.invalid" };

const git = (project: string, args: string[]): string => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...IDENTITY };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  delete env["GIT_INDEX_FILE"];
  delete env["GIT_COMMON_DIR"];
  return execFileSync("git", args, { cwd: project, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};

export async function withExampleProject<T>(fn: (project: string, base: string) => Promise<T>): Promise<T> {
  const project = await mkdtemp(join(tmpdir(), "warden-examples-"));
  try {
    await writeFile(join(project, "package.json"), "{}\n");
    await writeFile(join(project, "tsconfig.json"), TSCONFIG);
    git(project, ["init", "-q"]);
    git(project, ["add", "-A"]);
    git(project, ["-c", "user.name=warden", "-c", "user.email=warden@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "scaffold"]);
    return await fn(project, git(project, ["rev-parse", "HEAD"]).trim());
  } finally {
    const removal = rm(project, { recursive: true, force: true }).catch((cause: Error) => Promise.reject<void>({ project, cause: cause.message } satisfies Unremoved));
    removals.add(removal);
    removal.then(() => removals.delete(removal), () => undefined);
  }
}

export async function runExamples(project: RecordSet): Promise<Finding[]> {
  const set = exampleSet(project);
  const unknown = unknownAdapters(set).map(({ code, record, message }) => ({ code, record, message }));
  if (unknown.length > 0) return unknown;
  const findings: Finding[] = [];
  await withExampleProject(async (project, base) => {
    const checked: { g: Guardrail; file: string; groups: string[][]; packFile: string }[] = [];
    const ctx = { root: project, generatedDir: join(project, ".warden/generated"), base };
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
              findings.push({ code: "example-failed", record: g.id, message: `Guardrail ${g.id} ${label} example did not ${want}. Next action: change the ${label} example of Guardrail ${g.id} in ${pack.file} so ${g.implementation} ${want === "pass" ? "passes" : "fails"} on it, then run warden compile.` });
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
  ctx: { root: string; generatedDir: string; base: string },
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
