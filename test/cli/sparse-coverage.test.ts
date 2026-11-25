import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { readEvidence } from "../../src/runner/evidence.js";
import { withVerdict } from "../verdict.js";

const wardenRoot = resolve(import.meta.dirname, "../..");

it("records partial coverage for changed paths outside a sparse checkout", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "warden-sparse-coverage-")));
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args,
  ], { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  const warden = (...args: string[]) => {
    const result = withVerdict(args, spawnSync(process.execPath, [join(wardenRoot, "bin/warden.js"), ...args], {
      cwd: root, env: { ...process.env, WARDEN_DAEMON: "off" }, encoding: "utf8",
    }));
    expect(result.status, result.stdout + result.stderr).toBe(0);
  };
  const lastRun = () => readEvidence("fixture").filter((e) => e.kind === "cost" && e.guardrail === "run" && e.root === root).at(-1);
  try {
    await cp(join(wardenRoot, "test/fixtures/project-valid"), root, { recursive: true });
    const config = join(root, ".warden/config.yaml");
    await writeFile(config, (await readFile(config, "utf8")).replace("tierBudgetMs:", '  - id: local\n    paths: ["src/**"]\ntierBudgetMs:'));
    const pack = join(root, ".warden/packs/local");
    await mkdir(pack, { recursive: true });
    await writeFile(join(pack, "pack.yaml"), [
      "id: local",
      "layer: 2",
      "terms: []",
      "practices:",
      "  - id: project-structure",
      "    statement: The project has a visible status module.",
      "    terms: []",
      "    paths: []",
      "    conflictsWith: []",
      "    guardrails:",
      "      - id: project-status",
      "        kind: legacy",
      "        runs: [commit]",
      "        budgetMs: 5000",
      "        version: 1",
      '        implementation: "cmd:test -f src/visible/status.ts"',
      '        mustFail: { "other.txt": "sample" }',
      '        mustPass: { "src/visible/status.ts": "export const status = true;" }',
    ].join("\n"));
    await mkdir(join(root, "src/visible"), { recursive: true });
    await mkdir(join(root, "src/optional"));
    await writeFile(join(root, "src/visible/status.ts"), "export const status = 'ready';\n");
    await writeFile(join(root, "src/optional/model.ts"), "export const amount = 1;\n");
    await writeFile(join(root, "src/optional/notes.md"), "Initial notes\n");
    git("init", "-q", "-b", "main");
    warden("compile");
    git("add", "-A");
    git("commit", "-qm", "Add sample project");
    git("switch", "-qc", "update");
    git("sparse-checkout", "set", ".warden", "src/visible");
    await writeFile(join(root, "src/visible/status.ts"), "export const status = 'updated';\n");
    git("add", "src/visible/status.ts");
    warden("check", "--base", "main");
    expect(lastRun()).toMatchObject({ result: "pass", scope: "partial" });
    expect(lastRun()).toHaveProperty("sparseProjectFiles", 2);
    expect(lastRun()).not.toHaveProperty("tree");
    await writeFile(join(root, "src/visible/status.ts"), "export const status = 'ready';\n");
    git("add", "src/visible/status.ts");

    git("sparse-checkout", "disable");
    await writeFile(join(root, "src/optional/model.ts"), "export const amount = 2;\n");
    await writeFile(join(root, "src/optional/notes.md"), "Updated notes\n");
    git("add", "-A");
    git("commit", "-qm", "Update optional module");
    const tree = git("rev-parse", "HEAD^{tree}");

    git("sparse-checkout", "set", ".warden", "src/visible");
    warden("check", "--base", "main");
    expect(lastRun()).toMatchObject({ result: "pass", scope: "partial" });
    expect(lastRun()).toHaveProperty("sparseCoverage", {
      "src/optional/model.ts": ["lint"],
      "src/optional/notes.md": [],
    });
    expect(lastRun()).not.toHaveProperty("tree");

    git("sparse-checkout", "disable");
    warden("check", "--base", "main");
    expect(lastRun()).toMatchObject({ result: "pass", scope: "full", tree });

    git("sparse-checkout", "set", ".warden", "src/visible");
    git("revert", "--no-commit", "HEAD");
    warden("check", "--base", "main");
    expect(lastRun()).toMatchObject({ result: "pass", scope: "partial" });
    expect(lastRun()).toHaveProperty("sparseCoverage", {
      "src/optional/model.ts": ["lint"],
      "src/optional/notes.md": [],
    });
    expect(lastRun()).not.toHaveProperty("tree");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
