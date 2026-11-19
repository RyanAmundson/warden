import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("compile includes the record file and field in a validation error", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-record-diagnostics-"));
  const config = join(root, ".warden/config.yaml");
  const cli = resolve(import.meta.dirname, "../../bin/warden.js");
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    await mkdir(join(root, ".warden"));
    await writeFile(config, `project: record-diagnostics
base: main
packs:
  - id: core
    paths: 1
tierBudgetMs: { edit: 2000, commit: 10000, boundary: 120000 }
loopBreakerRepeats: 3
`);
    const result = spawnSync(process.execPath, [cli, "compile"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("/.warden/config.yaml /packs/0/paths:");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
