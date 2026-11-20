import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

it("reports a staged file moved out of the worktree as unstaged", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "warden-staged-file-"));
  const root = join(fixture, "project");
  const cli = resolve(import.meta.dirname, "../../bin/warden.js");
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root });
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
  const check = () => run("check", "--tier", "commit", "--base", "main");
  const path = "src/[services]/metrics-service/metrics-service.ts";
  const source = join(root, path);
  const moved = join(fixture, "metrics-service.ts");

  try {
    await mkdir(join(root, ".warden"), { recursive: true });
    git("init", "-q", "-b", "main");
    await writeFile(join(root, ".warden/config.yaml"), `project: staged-file
base: main
packs: [{ id: core, paths: ["**/*.ts"] }]
tierBudgetMs: { edit: 5000, commit: 10000, boundary: 120000 }
loopBreakerRepeats: 3
bench: { baseFiles: 1, maxFiles: 4, minMarginalMs: 1000 }
`);
    git("add", "-A");
    git("commit", "-qm", "Configure Warden");
    const compiled = run("compile");
    expect(compiled.status, compiled.stderr + compiled.stdout).toBe(0);
    git("add", "-A");
    git("commit", "-qm", "Compile Core");

    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, "export const metricsEnabled = true;\n");
    git("add", "--", path);
    await rename(source, moved);

    const missing = check();
    expect(missing.status, missing.stderr + missing.stdout).toBe(1);
    expect(missing.stdout).toContain(`UNSTAGED ${path}`);

    await rename(moved, source);
    const restored = check();
    expect(restored.status, restored.stderr + restored.stdout).toBe(0);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
