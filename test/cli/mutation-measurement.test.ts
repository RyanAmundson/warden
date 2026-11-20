import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "../../bin/warden.js");

it("uses the active policy to measure caught and surviving must-fail variants", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-mutation-test-")));
  const root = join(dir, "project");
  const pack = join(root, ".warden/packs/local/pack.yaml");
  const evidence = join(dir, "home/evidence/fixture.jsonl");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, env: { ...process.env, WARDEN_HOME: join(dir, "home") }, encoding: "utf8",
  });
  const git = (...args: string[]) => execFileSync("git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd: root, stdio: "pipe" });
  const put = (file: string, source: string) => writeFileSync(file, source);
  try {
    mkdirSync(join(root, ".warden/packs/local"), { recursive: true });
    git("init", "-q", "-b", "main");
    put(join(root, ".warden/config.yaml"), `project: fixture
base: main
packs: [{ id: local, paths: ["src/**/*.ts"] }]
tierBudgetMs: { edit: 2000, commit: 10000, boundary: 120000 }
loopBreakerRepeats: 3
bench: { baseFiles: 1, maxFiles: 8, minMarginalMs: 1000 }
`);
    put(pack, `id: local
layer: 1
terms: []
practices:
  - id: use-collection-operations
    statement: Use collection operations for iteration.
    terms: []
    paths: []
    conflictsWith: []
    guardrails:
      - id: no-explicit-loop
        kind: lint
        version: 1
        budgetMs: 5000
        runs: [edit]
        implementation: eslint:no-restricted-syntax
        options: [ForStatement]
        mustPass: "const doubled = [1, 2].map((n) => n * 2);"
        mustFail: "for (let i = 0; i < 2; i++) { Math.abs(i); }"
        mutations:
          bounded-for: "for (const a = { n: 0 }; a.n < 2; a.n++) { Math.abs(a.n); }"
          bounded-while: "let i = 0; while (i < 2) { Math.abs(i++); }"
      - id: duplicate-samples
        kind: lint
        version: 1
        budgetMs: 5000
        runs: [edit]
        implementation: eslint:no-restricted-syntax
        options: [WhileStatement]
        mustPass: "const doubled = [1, 2].map((n) => n * 2);"
        mustFail: "let i = 0; while (i < 2) { Math.abs(i++); }"
        mutations:
          repeated-control:
            "src//warden-example.ts": "let i = 0; while (i < 2) { Math.abs(i++); }"
`);
    const built = run("compile");
    expect(built.status, built.stdout + built.stderr).toBe(0);
    git("add", ".");
    git("commit", "-qm", "Configure the collection practice");

    const missingBase = run("review", "mutations", "--rule", "no-explicit-loop");
    expect(missingBase.status).toBe(2);
    expect(missingBase.stderr).toContain("--base");

    const duplicate = run("review", "mutations", "--base", "main", "--rule", "duplicate-samples");
    expect(duplicate.status).toBe(2);
    expect(duplicate.stderr).toContain("duplicates");

    const measured = run("review", "mutations", "--base", "main", "--rule", "no-explicit-loop", "--format", "json");
    expect(measured.status, measured.stdout + measured.stderr).toBe(0);
    const mutants = { caught: ["bounded-for"], missed: ["bounded-while"] };
    expect(JSON.parse(measured.stdout)).toEqual([{ pack: "local", guardrail: "no-explicit-loop", ...mutants }]);
    expect(JSON.parse(readFileSync(evidence, "utf8"))).toMatchObject({ kind: "hollow", root, mutations: mutants });

    const current = run("report", "--learning", "--format", "json");
    expect(current.status, current.stderr).toBe(0);
    const measureOf = (stdout: string) => JSON.parse(stdout).find((row: { guardrail: string }) => row.guardrail === "no-explicit-loop");
    expect(measureOf(current.stdout)).toMatchObject({ mutationStrength: 0.5, mutations: mutants });
    const proposed = run("review", "proposals");
    expect(proposed.status, proposed.stderr).toBe(0);
    expect(JSON.parse(proposed.stdout)).toEqual([{
      action: "edit", pack: "local", practice: "use-collection-operations", guardrail: "no-explicit-loop",
      evidence: [{ kind: "hollow-mutation", at: expect.any(String), policy: expect.any(String), mutations: mutants }],
    }]);
    expect(run("review", "proposals").stdout).toBe(proposed.stdout);

    const manifest = join(root, "package.json");
    put(manifest, "{");
    const invalidManifest = run("report", "--learning", "--format", "json");
    expect(invalidManifest.status, invalidManifest.stderr).toBe(0);
    expect(measureOf(invalidManifest.stdout)).toMatchObject({
      resolved: 0,
      mutationStrength: null,
      mutationPolicyIssue: expect.stringContaining("package.json"),
    });
    const unverifiedProposals = run("review", "proposals");
    expect(unverifiedProposals).toMatchObject({ status: 0, stdout: "[]\n" });
    expect(unverifiedProposals.stderr).toContain("Mutation-backed Edit proposals are unavailable.");
    rmSync(manifest);

    put(pack, readFileSync(pack, "utf8").replace("a.n < 2", "a.n < 3"));
    const stale = run("report", "--learning", "--format", "json");
    expect(stale.status, stale.stderr).toBe(0);
    expect(measureOf(stale.stdout)).toMatchObject({ mutationStrength: null });
    expect(run("review", "proposals")).toMatchObject({ status: 0, stdout: "[]\n" });
    const unsigned = run("review", "mutations", "--base", "main", "--rule", "no-explicit-loop");
    expect(unsigned.status).toBe(2);
    expect(unsigned.stderr).toContain("source-drift");
    expect(readFileSync(evidence, "utf8").trim().split("\n")).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
