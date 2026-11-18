import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildReport } from "../../src/cli/report.js";

const wardenRoot = resolve(import.meta.dirname, "../..");
const at = "2026-11-18T00:00:00.000Z";

let root: string;
let home: string;

const guardrailYaml = (id: string, kind: string, rule: string, runs = "[edit, commit]"): string[] => [
  `      - id: ${id}`, `        kind: ${kind}`, `        runs: ${runs}`, "        budgetMs: 5000", "        version: 1", `        implementation: "eslint:${rule}"`,
  '        mustFail: "var a = 1;\\n"', '        mustPass: "const y = 1;\\n"',
];

const pack = (id: string, guardrails: string[][]): string =>
  [`id: ${id}`, "layer: 1", "terms: []", "practices:", `  - id: ${id}-practice`, "    statement: Many rules.", "    terms: []", "    paths: []", "    conflictsWith: []", "    guardrails:", ...guardrails.flat(), ""].join("\n");

const evidence = async (rows: Record<string, unknown>[]): Promise<void> => {
  await mkdir(join(home, "evidence"), { recursive: true });
  await writeFile(join(home, "evidence/p.jsonl"), `${rows.map((r) => JSON.stringify({ at, ...r })).join("\n")}\n`);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-report-"));
  home = await mkdtemp(join(tmpdir(), "warden-home-"));
  vi.stubEnv("WARDEN_HOME", home);
  await mkdir(join(root, ".warden/packs/local"), { recursive: true });
  await mkdir(join(root, ".warden/packs/other"), { recursive: true });
  await writeFile(
    join(root, ".warden/config.yaml"),
    'warden: "0.1.0"\nproject: p\nbase: main\npacks:\n  - id: local\n    paths: ["**/*.ts"]\n  - id: other\n    paths: ["**/*.ts"]\ntierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }\nloopBreakerRepeats: 3\n',
  );
  await writeFile(join(root, ".warden/packs/local/pack.yaml"), pack("local", [guardrailYaml("a", "lint", "no-var"), guardrailYaml("b", "lint", "no-debugger"), guardrailYaml("c", "review", "no-eval")]));
  await writeFile(join(root, ".warden/packs/other/pack.yaml"), pack("other", [guardrailYaml("d", "review", "no-empty", "[commit]")]));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

it("a Guardrail that leaves a shared pass is charged by its newest row, and the pass it left is no longer current", async () => {
  await evidence([
    ...[300, 300, 300].map((ms) => ({ kind: "cost", shared: "eslint", guardrails: 3, members: ["a", "b", "c"], status: "pass", ms })),
    { kind: "cost", shared: "eslint", guardrails: 2, members: ["a", "b"], status: "pass", ms: 100 },
    { kind: "cost", guardrail: "c", status: "pass", ms: 40 },
  ]);
  const report = await buildReport(root, wardenRoot);
  expect(report.shared.map((s) => s.members)).toEqual([["a", "b"]]);
  const c = report.guardrails.find((g) => g.guardrail === "c");
  expect(c).toMatchObject({ medianMs: 40, slowestMs: 40 });
  expect(c?.costShared).toBeUndefined();
});

it("a Guardrail that joins a shared pass after running alone is charged to the pass", async () => {
  await evidence([
    { kind: "cost", guardrail: "c", status: "pass", ms: 40 },
    { kind: "cost", shared: "eslint", guardrails: 3, members: ["a", "b", "c"], status: "pass", ms: 300 },
  ]);
  const report = await buildReport(root, wardenRoot);
  expect(report.shared.map((s) => s.members)).toEqual([["a", "b", "c"]]);
  expect(report.guardrails.find((g) => g.guardrail === "c")?.costShared).toBe("eslint");
});
