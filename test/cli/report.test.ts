import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildReport, runReport } from "../../src/cli/report.js";

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

const runRow = (run: string, tier: string, ms: number, outcome = "ran"): Record<string, unknown> => ({ kind: "cost", guardrail: "run", run, tier, outcome, ms, files: 1, bytes: 10 });

const perRunRows = (): Record<string, unknown>[] => [
  { kind: "cost", guardrail: "c", status: "pass", ms: 999 },
  { kind: "cost", shared: "eslint", guardrails: 2, members: ["a", "b"], status: "pass", ms: 50, run: "r1", tier: "edit", files: 2, bytes: 20, rules: { a: 10, b: 20 } },
  { kind: "cost", guardrail: "c", pack: "local", status: "pass", ms: 40, run: "r1", tier: "edit", files: 4, bytes: 40 },
  runRow("r1", "edit", 300),
  { kind: "cost", shared: "eslint", guardrails: 2, members: ["a", "b"], status: "pass", ms: 30, run: "r2", tier: "edit", files: 1, bytes: 10, rules: { a: 5, b: 5 } },
  { kind: "cost", guardrail: "c", pack: "local", status: "pass", ms: 30, run: "r2", tier: "edit", files: 2, bytes: 20 },
  runRow("r2", "edit", 100),
  runRow("r3", "edit", 200),
  runRow("r4", "edit", 3, "tampered"),
  { kind: "cost", guardrail: "d", pack: "other", status: "pass", ms: 15, run: "r5", tier: "commit", files: 1, bytes: 10 },
  runRow("r5", "commit", 60),
];

it("a tier's combined total is the median of its ran run records, and early exits are counted apart", async () => {
  await evidence(perRunRows());
  const edit = (await buildReport(root, wardenRoot)).tiers.find((t) => t.tier === "edit");
  expect(edit).toMatchObject({ medianMs: 200, slowestMs: 300, runs: 3, earlyExits: 1, budgetMs: 1000, withinBudget: true });
  expect(edit?.medianMs).toBeLessThan(40 + 50 + 30 + 30 + 300);
});

it("a pack total sums its Guardrails' time in each run, leaves out runs where it did no work, and the pass overhead is its own row", async () => {
  await evidence(perRunRows());
  const { tiers } = await buildReport(root, wardenRoot);
  const edit = tiers.find((t) => t.tier === "edit");
  expect(edit?.packs).toEqual([{ pack: "local", medianMs: 55, slowestMs: 70, runs: 2 }]);
  expect(edit?.passes).toEqual([{ shared: "eslint", members: ["a", "b"], medianMs: 20, slowestMs: 20, runs: 2 }]);
  const commit = tiers.find((t) => t.tier === "commit");
  expect(commit?.packs).toEqual([{ pack: "other", medianMs: 15, slowestMs: 15, runs: 1 }]);
  expect(commit?.passes).toEqual([]);
});

it("a Guardrail's own rows give its median time per file", async () => {
  await evidence(perRunRows());
  const c = (await buildReport(root, wardenRoot)).guardrails.find((g) => g.guardrail === "c");
  expect(c?.medianMsPerFile).toBe(12.5);
});

it("the text report prints each tier's combined total, its pack totals, and the pass overhead once", async () => {
  await evidence(perRunRows());
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    expect(await runReport(root, wardenRoot, false)).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
  expect(out).toContain("tier edit: median 200ms, slowest 300ms of 1000ms over 3 runs, 1 early exits\n  pack local  median 55ms  slowest 70ms  runs 2\n  pass eslint (2 guardrails, parse and setup)  median 20ms  slowest 20ms  runs 2\n");
  expect(out).toContain("tier commit: median 60ms, slowest 60ms of 2000ms over 1 runs\n  pack other  median 15ms  slowest 15ms  runs 1\n");
  expect(out).toMatch(/ c {2}kind=review.*perFile=12.5ms/);
});

it("the report shows the newest bench verdict for each pack and Guardrail with its own Warden version and date, marks a superlinear one a defect, and shows a flip", async () => {
  const points = [[25, 30], [50, 60], [100, 120], [200, 240]];
  const later = "2026-11-19T00:00:00.000Z";
  await evidence([
    { kind: "scaling", guardrail: "a", verdict: "superlinear", k: 1.9, points, f: 1, warden: "0.1.0" },
    { kind: "scaling", guardrail: "a", verdict: "linear", k: 1.02, points, f: 1, warden: "0.1.1", at: later, previous: { verdict: "superlinear", k: 1.6, points, f: 1 } },
    { kind: "scaling", guardrail: "b", verdict: "superlinear", k: 1.71, points, f: 1, warden: "0.1.0", previous: { verdict: "superlinear", k: 1.8, points, f: 1 } },
    { kind: "scaling", pack: "local", verdict: "superlinear", k: 1.71, points, f: 1, warden: "0.1.0" },
    { kind: "scaling", guardrail: "eslint-pass", verdict: "linear", k: 0.98, points, f: 1, warden: "0.1.0" },
  ]);
  const { scaling } = await buildReport(root, wardenRoot);
  expect(scaling).toEqual([
    { pack: "local", verdict: "superlinear", k: 1.71, warden: "0.1.0", at },
    { guardrail: "a", verdict: "linear", k: 1.02, warden: "0.1.1", at: later, flippedFrom: "superlinear" },
    { guardrail: "b", verdict: "superlinear", k: 1.71, warden: "0.1.0", at },
    { guardrail: "eslint-pass", verdict: "linear", k: 0.98, warden: "0.1.0", at },
  ]);
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    await runReport(root, wardenRoot, false);
  } finally {
    vi.restoreAllMocks();
  }
  expect(out).toContain(
    [
      "scaling (warden bench)",
      "  pack local  superlinear  k=1.71  DEFECT  (warden 0.1.0, 2026-11-18)",
      "    a  linear  k=1.02  flipped from superlinear  (warden 0.1.1, 2026-11-19)",
      "    b  superlinear  k=1.71  DEFECT  (warden 0.1.0, 2026-11-18)",
      "  eslint-pass  linear  k=0.98  (warden 0.1.0, 2026-11-18)",
      "",
    ].join("\n"),
  );
});
