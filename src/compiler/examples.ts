import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { adapters, runGuardrails } from "../runner/run.js";
import type { Guardrail, RecordSet } from "../records/types.js";
import { type Adapter, PARSE_ERROR } from "../adapters/types.js";
import type { Finding } from "./consistency.js";

const TSCONFIG = JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: true }, include: ["**/*.ts"] });

const exampleFile = (glob: string | undefined): string => `${(glob ?? "").split("*", 1)[0]}warden-example.ts`;

export async function runExamples(set: RecordSet, wardenRoot: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const project = await mkdtemp(join(tmpdir(), "warden-examples-"));
  try {
    await symlink(join(wardenRoot, "node_modules"), join(project, "node_modules"));
    await writeFile(join(project, "package.json"), "{}\n");
    await writeFile(join(project, "tsconfig.json"), TSCONFIG);
    const checked: { g: Guardrail; file: string }[] = [];
    const ctx = { root: project, generatedDir: join(project, ".warden/generated") };
    for (const pack of set.packs) {
      for (const practice of pack.practices) {
        const globs = practice.paths.length > 0 ? practice.paths : (set.config.packs.find((p) => p.id === pack.id)?.paths ?? []);
        const file = exampleFile(globs[0]);
        for (const g of practice.guardrails) {
          if (g.kind === "legacy" || g.kind === "instruction") continue;
          const adapter = adapters.get(g.implementation.slice(0, g.implementation.indexOf(":")));
          if (adapter === undefined) continue;
          checked.push({ g, file });
          for (const [label, want] of [["mustFail", "fail"], ["mustPass", "pass"]] as const) {
            const source = g[label];
            if (source === undefined) {
              findings.push({ code: "example-failed", record: g.id, message: `Guardrail ${g.id} has no ${label} example.` });
              continue;
            }
            const status = await runExample(g, adapter.emit([g], set), source, file, ctx);
            if (status === "parse-error") {
              findings.push({ code: "example-failed", record: g.id, message: `Guardrail ${g.id} ${label} example does not parse.` });
            } else if (status === "over-budget") {
              findings.push({ code: "over-budget", record: g.id, message: `Guardrail ${g.id} ran longer than its ${g.budgetMs} ms budget on its ${label} example.` });
            } else if (status !== want) {
              findings.push({ code: "example-failed", record: g.id, message: `Guardrail ${g.id} ${label} example did not ${want}.` });
            }
          }
        }
      }
    }
    for (const { g, file } of checked) {
      if (g.mustPass === undefined) continue;
      for (const other of checked) {
        if (other.g === g || other.g.implementation.startsWith("cmd:")) continue;
        const adapter = adapters.get(other.g.implementation.slice(0, other.g.implementation.indexOf(":"))) as Adapter;
        const status = await runExample(other.g, adapter.emit([other.g], set), g.mustPass, file, ctx);
        if (status === "fail") {
          findings.push({ code: "example-conflict", record: g.id, message: `Guardrail ${g.id} mustPass example fails Guardrail ${other.g.id}.` });
        }
      }
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
  return findings;
}

async function runExample(
  g: Guardrail,
  emitted: Record<string, string>,
  source: string,
  file: string,
  ctx: { root: string; generatedDir: string },
): Promise<string> {
  const target = join(ctx.root, file);
  try {
    for (const [path, content] of Object.entries(emitted)) {
      await mkdir(dirname(join(ctx.root, path)), { recursive: true });
      await writeFile(join(ctx.root, path), content);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
    const results = await runGuardrails([g], [file], ctx);
    if (results.some((r) => r.guardrail === PARSE_ERROR && r.status === "fail")) return "parse-error";
    const own = results.find((r) => r.guardrail === g.id);
    if (own === undefined) throw new Error(`no result for guardrail ${g.id}`);
    return own.status;
  } finally {
    await rm(target, { force: true });
  }
}
