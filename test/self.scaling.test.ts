import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { Rule } from "eslint";
import { plugin } from "../eslint-plugin/index.js";
import { runBench } from "../src/cli/bench.js";

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

it("an unnarrowed bench measures the shared ESLint pass once, beside a fixture ESLint Guardrail", async () => {
  const project = await mkdtemp(join(tmpdir(), "warden-self-bench-"));
  const home = await mkdtemp(join(tmpdir(), "warden-self-home-"));
  vi.stubEnv("WARDEN_HOME", home);
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    await mkdir(join(project, ".warden/packs/lintpass"), { recursive: true });
    await writeFile(join(project, ".warden/packs/lintpass/pack.yaml"), lintPassPack);
    await writeFile(join(project, ".warden/config.yaml"), config.replace("  - id: core", "  - id: lintpass"));
    const code = await runBench(project, repo, {});
    expect(code, out).toBe(0);
    expect(out.match(/^ {2}eslint-pass +\w+/gm), out).toHaveLength(1);
    expect(out).toMatch(/^ {4}lint-pass-fixture +\w+/m);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

const lintPassPack = [
  "id: lintpass", "layer: 9", "terms: []", "practices:", "  - id: lint-pass", "    statement: Code carries no comments.", "    terms: []", "    paths: []", "    conflictsWith: []", "    guardrails:",
  "      - id: lint-pass-fixture", "        kind: lint", "        runs: [commit]", "        budgetMs: 5000", "        version: 1", '        implementation: "eslint:warden/no-comments"',
  '        mustFail: "// a\\nconst a = 1;\\n"', '        mustPass: "export const a = 1;\\n"', "",
].join("\n");

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
    expect(out).not.toContain("eslint-pass");
  } finally {
    delete rules[STAND_IN];
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
