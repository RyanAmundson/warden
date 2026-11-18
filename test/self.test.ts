import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { Rule } from "eslint";
import { plugin } from "../eslint-plugin/index.js";
import { eslintAdapter } from "../src/adapters/eslint.js";
import { runBench } from "../src/cli/bench.js";
import { loadRecords } from "../src/records/load.js";
import { runGuardrails } from "../src/runner/run.js";

const repo = resolve(import.meta.dirname, "..");
const config = [
  "warden: 0.1.0",
  "project: warden",
  "base: main",
  "packs:",
  "  - id: core",
  "    paths: [\"**/*.ts\"]",
  "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }",
  "loopBreakerRepeats: 3",
  "",
].join("\n");

const holdsDeliberateViolations = (file: string): boolean =>
  file.startsWith("test/fixtures/") || /^packs\/[^/]+\/fixtures\//.test(file);

const sourceFiles = async (): Promise<string[]> => {
  const files: string[] = [];
  for (const dir of ["src", "eslint-plugin", "test"]) {
    for (const entry of await readdir(join(repo, dir), { recursive: true })) {
      const file = join(dir, entry);
      if (file.endsWith(".ts") && !holdsDeliberateViolations(file)) files.push(file);
    }
  }
  return files;
};

it("Warden source passes its own core pack", async () => {
  const project = await mkdtemp(join(tmpdir(), "warden-self-"));
  try {
    await mkdir(join(project, ".warden/generated"), { recursive: true });
    await writeFile(join(project, ".warden/config.yaml"), config);
    const set = await loadRecords(project, repo);
    const guardrails = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails));
    for (const [file, content] of Object.entries(eslintAdapter.emit(guardrails, set))) {
      await writeFile(join(project, file), content);
    }
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(10);
    const results = await runGuardrails(set, guardrails, files, {
      root: repo,
      generatedDir: join(project, ".warden/generated"),
    });
    expect(results.map((r) => r.guardrail)).toEqual(guardrails.map((g) => g.id));
    expect(results.map((r) => r.status)).toEqual(guardrails.map(() => "pass"));
    const violations = results.flatMap((r) => r.violations.map((v) => `${relative(repo, join(repo, v.file))}:${v.line} ${v.message}`));
    expect(violations).toEqual([]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

it("every shipped pack's Guardrails, and the shared ESLint pass, scale at most linearly", async () => {
  const project = await mkdtemp(join(tmpdir(), "warden-self-bench-"));
  const home = await mkdtemp(join(tmpdir(), "warden-self-home-"));
  vi.stubEnv("WARDEN_HOME", home);
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    const shipped = (await readdir(join(repo, "packs"))).filter((id) => !id.startsWith("."));
    await mkdir(join(project, ".warden"), { recursive: true });
    await writeFile(join(project, ".warden/config.yaml"), config.replace("  - id: core\n    paths: [\"**/*.ts\"]", shipped.map((id) => `  - id: ${id}\n    paths: ["**/*.ts"]`).join("\n")));
    const code = await runBench(project, repo, {});
    expect(code, out).toBe(0);
    expect(out).toContain("eslint-pass");
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

const STAND_IN = "quadratic-stand-in";

const standInPack = [
  "id: standin", "layer: 9", "terms: []", "practices:", "  - id: stand-in", "    statement: A rule that does work for every pair of files.", "    terms: []", "    paths: []", "    conflictsWith: []", "    guardrails:",
  "      - id: stand-in-quadratic", "        kind: lint", "        runs: [commit]", "        budgetMs: 5000", "        version: 1", `        implementation: "eslint:warden/${STAND_IN}"`,
  '        mustFail: "const a = 1;\\n"', '        mustPass: "export const a = 1;\\n"', "",
].join("\n");

it("the self-test bench catches a rule whose time grows with every pair of files, at a tenth of a millisecond a pair", async () => {
  const project = await mkdtemp(join(tmpdir(), "warden-self-bench-"));
  const home = await mkdtemp(join(tmpdir(), "warden-self-home-"));
  vi.stubEnv("WARDEN_HOME", home);
  const realNs = process.hrtime.bigint.bind(process.hrtime);
  const realNow = performance.now.bind(performance);
  let skew = 0n;
  const hrtime = ((prev?: [number, number]): [number, number] => {
    const at = realNs() + skew - (prev === undefined ? 0n : BigInt(prev[0]) * 1_000_000_000n + BigInt(prev[1]));
    return [Number(at / 1_000_000_000n), Number(at % 1_000_000_000n)];
  }) as typeof process.hrtime;
  hrtime.bigint = () => realNs() + skew;
  vi.spyOn(process, "hrtime").mockImplementation(hrtime);
  vi.spyOn(performance, "now").mockImplementation(() => realNow() + Number(skew) / 1e6);
  const rules = plugin.rules as Record<string, Rule.RuleModule>;
  rules[STAND_IN] = {
    meta: plugin.rules["no-comments"].meta,
    create: (context) => ({
      Program() {
        skew += BigInt(/-(\d+)\.ts$/.exec(context.filename)?.[1] ?? "0") * 100_000n;
      },
    }),
  };
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    await mkdir(join(project, ".warden/packs/standin"), { recursive: true });
    await writeFile(join(project, ".warden/packs/standin/pack.yaml"), standInPack);
    await writeFile(join(project, ".warden/config.yaml"), config.replace("tierBudgetMs:", '  - id: standin\n    paths: ["**/*.ts"]\ntierBudgetMs:'));
    const code = await runBench(project, repo, { pack: "standin" });
    expect(code, out).toBe(1);
    expect(out).toMatch(/^ {4}stand-in-quadratic +superlinear +k=\d\.\d+ +DEFECT$/m);
    expect(out).toContain("Next action: make stand-in-quadratic linear in files; see the four points above.");
  } finally {
    delete rules[STAND_IN];
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
