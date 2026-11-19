import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Adapter } from "../../src/adapters/types.js";
import { runBench } from "../../src/cli/bench.js";
import { adapters } from "../../src/runner/run.js";

const wardenRoot = resolve(import.meta.dirname, "../..");
const version = (JSON.parse(readFileSync(join(wardenRoot, "package.json"), "utf8")) as { version: string }).version;

let root: string;
let home: string;
let roots: string[];
let checked: number;

const models: Record<string, (n: number, root: string) => number> = {
  linear: (n) => 2 + n,
  quadratic: (n) => 2 + (n * n) / 10,
  constant: () => 5,
  flaky: (n, r) => (r === roots[0] ? 2 + (n * n) / 10 : 2 + n),
};

const fake: Adapter = {
  id: "fake",
  emit: () => ({}),
  run: async (gs, files, ctx) => {
    if (!roots.includes(ctx.root)) roots.push(ctx.root);
    return gs.map((g) => {
      const model = g.implementation.slice("fake:".length);
      if (model === "copies") {
        const wrong = files.find((f) => !existsSync(join(ctx.root, f)) || readFileSync(join(ctx.root, f), "utf8") !== "const a = 1;\n");
        checked = Math.max(checked, new Set(files).size === files.length && wrong === undefined ? files.length : -1);
        if (wrong !== undefined || checked < 0) return { guardrail: g.id, status: "fail", violations: [{ guardrail: g.id, file: wrong ?? "", line: 1, message: "bad copy" }], ms: 1 };
        return { guardrail: g.id, status: "pass", violations: [], ms: 2 + files.length };
      }
      if (model === "fails") return { guardrail: g.id, status: "fail", violations: [{ guardrail: g.id, file: files[0] as string, line: 1, message: "bad" }], ms: 1 };
      return { guardrail: g.id, status: "pass", violations: [], ms: (models[model] as (n: number, root: string) => number)(files.length, ctx.root) };
    });
  },
};

const guardrail = (id: string, model: string, mustPass = ['        mustPass: "const a = 1;\\n"']): string[] => [
  `      - id: ${id}`, "        kind: runtime", "        runs: [boundary]", "        budgetMs: 5000", "        version: 1", `        implementation: "fake:${model}"`,
  '        mustFail: "bad\\n"', ...mustPass,
];

const pack = (id: string, guardrails: string[][]): string =>
  [`id: ${id}`, "layer: 1", "terms: []", "practices:", `  - id: ${id}-practice`, "    statement: Scales.", "    terms: []", "    paths: []", "    conflictsWith: []", "    guardrails:", ...guardrails.flat(), ""].join("\n");

const setup = async (packs: Record<string, string[][]>, extra: string[] = [], paths = '["src/**/*.ts"]'): Promise<void> => {
  await mkdir(join(root, ".warden"), { recursive: true });
  const entries = Object.keys(packs).flatMap((id) => [`  - id: ${id}`, `    paths: ${paths}`]);
  await writeFile(join(root, ".warden/config.yaml"), ['warden: "0.1.0"', "project: p", "base: main", "packs:", ...entries, "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }", "loopBreakerRepeats: 3", ...extra, ""].join("\n"));
  for (const [id, gs] of Object.entries(packs)) {
    await mkdir(join(root, ".warden/packs", id), { recursive: true });
    await writeFile(join(root, ".warden/packs", id, "pack.yaml"), pack(id, gs));
  }
};

const bench = async (opts: { rule?: string; pack?: string } = {}): Promise<{ code: number; out: string; err: string }> => {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  try {
    return { code: await runBench(root, wardenRoot, opts), out, err };
  } finally {
    vi.restoreAllMocks();
  }
};

const scaling = async (): Promise<Record<string, unknown>[]> =>
  (await readFile(join(home, "evidence/p.jsonl"), "utf8"))
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.kind === "scaling");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-bench-"));
  home = await mkdtemp(join(tmpdir(), "warden-home-"));
  roots = [];
  checked = 0;
  vi.stubEnv("WARDEN_HOME", home);
  adapters.set("fake", fake);
});

afterEach(async () => {
  adapters.delete("fake");
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

it("a time proportional to files is linear, one fixed time is constant, and both pass", async () => {
  await setup({ local: [guardrail("lin", "linear"), guardrail("flat", "constant")] });
  const { code, out } = await bench();
  expect(code).toBe(0);
  expect(out).toMatch(/^ {2}pack local +linear +k=1\.0\d$/m);
  expect(out).toMatch(/^ {4}lin +linear +k=1\.0\d$/m);
  expect(out).toMatch(/^ {4}flat +constant$/m);
  expect(out).not.toContain("Next action");
  const rows = await scaling();
  const lin = rows.find((e) => e.guardrail === "lin");
  expect(lin).toMatchObject({ verdict: "linear", f: 3, warden: version, points: [[25, 27], [50, 52], [100, 102], [200, 202]] });
  expect(rows.find((e) => e.guardrail === "flat")).toMatchObject({ verdict: "constant", f: 5, points: [[25, 5], [50, 5], [100, 5], [200, 5]] });
  expect(rows.find((e) => e.pack === "local")).toMatchObject({ verdict: "linear" });
});

it("a time proportional to files squared is superlinear twice, fails as a defect, and names one next action", async () => {
  await setup({ local: [guardrail("lin", "linear")], slow: [guardrail("quad", "quadratic")] });
  const { code, out } = await bench();
  expect(code).toBe(1);
  expect(out).toMatch(/^ {2}pack slow +superlinear +k=2\.\d+ +DEFECT$/m);
  expect(out).toMatch(/^ {4}quad +superlinear +k=2\.\d+ +DEFECT$/m);
  expect(out).toContain("quad points: 25 files 64.5ms, 50 files 252ms, 100 files 1002ms, 200 files 4002ms; fixed 2.1ms");
  expect(out.split("\n").filter((l) => l.startsWith("Next action:"))).toEqual(["Next action: make quad linear in files; see the four points above."]);
  expect(roots).toHaveLength(3);
  const quad = (await scaling()).find((e) => e.guardrail === "quad");
  expect(quad).toMatchObject({ verdict: "superlinear", previous: { verdict: "superlinear" } });
});

it("a result that is superlinear once and linear when measured again passes and keeps both", async () => {
  await setup({ local: [guardrail("flip", "flaky")] });
  const { code } = await bench();
  expect(code).toBe(0);
  expect(roots).toHaveLength(2);
  expect((await scaling()).find((e) => e.guardrail === "flip")).toMatchObject({ verdict: "linear", previous: { verdict: "superlinear" } });
});

it("a copied mustPass example that fails its Guardrail exits 2 with a next action that names it", async () => {
  await setup({ local: [guardrail("bad", "fails")] });
  const { code, err } = await bench();
  expect(code).toBe(2);
  expect(err.match(/Next action:/g)).toHaveLength(1);
  expect(err).toContain("Guardrail bad failed on a copy of its mustPass example at src/warden-example-0.ts");
  expect(err).toContain("Next action: change the mustPass example of Guardrail bad");
});

it("--rule and --pack narrow the bench, and an unknown id exits 2 with a next action", async () => {
  await setup({ local: [guardrail("lin", "linear"), guardrail("flat", "constant")], slow: [guardrail("quad", "quadratic")] });
  expect((await bench({ rule: "lin" })).code).toBe(0);
  expect((await scaling()).map((e) => e.guardrail ?? e.pack)).toEqual(["lin", "local"]);
  expect((await bench({ pack: "local" })).code).toBe(0);
  const missing = await bench({ rule: "nope" });
  expect(missing.code).toBe(2);
  expect(missing.err).toContain('no Practice or Guardrail has id "nope". Next action:');
  expect((await bench({ pack: "nope" })).code).toBe(2);
});

it("bench settings in config.yaml replace the defaults, and an unknown setting exits 2", async () => {
  await setup({ local: [guardrail("lin", "linear")] }, ["bench:", "  baseFiles: 30", "  linearMax: 1.01"]);
  expect((await bench()).code).toBe(1);
  expect((await scaling()).find((e) => e.guardrail === "lin")).toMatchObject({ verdict: "superlinear", points: [[30, 32], [60, 62], [120, 122], [240, 242]] });
  await setup({ local: [guardrail("lin", "linear")] }, ["bench:", "  baseFile: 30"]);
  const r = await bench();
  expect(r.code).toBe(2);
  expect(r.err).toContain("/bench");
});

it("a copy that lands outside the Guardrail's paths exits 2 with one next action, since the rule would never run on it", async () => {
  await setup({ local: [guardrail("tree", "linear", ["        mustPass:", '          src/a.ts: "const a = 1;\\n"'])] }, [], '["src/*.ts"]');
  const { code, err } = await bench();
  expect(code).toBe(2);
  expect(err.match(/Next action:/g)).toHaveLength(1);
  expect(err).toContain("Guardrail tree would not run on src/bench-1/src/a.ts, a copy of its mustPass example, because it is outside src/*.ts.");
  expect(roots).toEqual([]);
});

it("every copy the bench writes exists with its mustPass content before the Guardrail runs, for single-file and tree examples", async () => {
  const tree = ["        mustPass:", '          src/a.ts: "const a = 1;\\n"', '          src/deep/b.ts: "const a = 1;\\n"'];
  await setup({ local: [guardrail("single", "copies"), guardrail("tree", "copies", tree)] }, [], '["src/**/*.ts"]');
  const { code, out } = await bench();
  expect(code, out).toBe(0);
  expect(checked).toBe(400);
});
