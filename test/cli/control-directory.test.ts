import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("identifies a linked control directory and accepts the restored directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-control-directory-"));
  const cli = resolve(import.meta.dirname, "../../bin/warden.js");
  const control = join(root, ".warden");
  const backup = join(root, "warden-backup");
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root });
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
  const check = () => run("check", "--tier", "boundary", "--base", "main");

  try {
    git("init", "-q", "-b", "main");
    await mkdir(control);
    await writeFile(join(control, "config.yaml"), `project: control-directory
base: main
packs: []
tierBudgetMs: { edit: 5000, commit: 10000, boundary: 120000 }
loopBreakerRepeats: 3
`);
    const compiled = run("compile");
    expect(compiled.status, compiled.stderr + compiled.stdout).toBe(0);
    git("add", "-A");
    git("commit", "-qm", "Compile Warden project");

    await rename(control, backup);
    await symlink(backup, control, "dir");
    const linked = check();
    expect(linked.status, linked.stderr + linked.stdout).toBe(2);
    expect(linked.stderr).toContain("is a symbolic link. Next action: move the link aside, restore the tracked .warden directory");

    await rename(control, join(root, "warden-link"));
    await rename(backup, control);
    const restored = check();
    expect(restored.status, restored.stderr + restored.stdout).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
