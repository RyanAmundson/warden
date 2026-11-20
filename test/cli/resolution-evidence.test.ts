import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ESLint } from "eslint";
import { expect, it, vi } from "vitest";
import { runCheck } from "../../src/cli/check.js";
import { sha256 } from "../../src/compiler/lock.js";
import { readEvidence } from "../../src/runner/evidence.js";

const wardenRoot = resolve(import.meta.dirname, "../..");
const fixture = resolve(wardenRoot, "test/fixtures/project-valid");

it.each([
  { scenario: "a concurrent edit", warm: false },
  { scenario: "a previously cached correction", warm: true },
])("links an ESLint correction to the failed input after $scenario", async ({ warm }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "warden-resolution-")));
  const relative = warm ? "src/cached.ts" : "src/feature.ts";
  const file = join(root, relative);
  const failing = "\uFEFF// Context\r\nexport const feature = 1;\r\n";
  const corrected = "export const feature = 1;\n";
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args,
  ], { cwd: root });
  const check = () => runCheck({ root, wardenRoot, base: "main", format: "json", tier: "edit", paths: [relative] });
  try {
    await cp(fixture, root, { recursive: true });
    await mkdir(join(root, "src"));
    await writeFile(file, corrected);
    git("init", "-q", "-b", "main");
    const compiled = spawnSync(process.execPath, [join(wardenRoot, "bin/warden.js"), "compile"], { cwd: root, encoding: "utf8" });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    git("add", "-A");
    git("commit", "-qm", "base");

    if (warm) {
      expect(await check()).toBe(0);
      await writeFile(file, failing);
    } else {
      const lintFiles = ESLint.prototype.lintFiles;
      vi.spyOn(ESLint.prototype, "lintFiles").mockImplementationOnce(async function (this: ESLint, paths) {
        await writeFile(file, failing);
        return lintFiles.call(this, paths);
      });
    }
    expect(await check()).toBe(1);
    expect(await readFile(file, "utf8")).toBe(failing);
    const fire = readEvidence("fixture").find((e) => e.kind === "fired" && e.file === relative);
    expect(fire).toMatchObject({ guardrail: "warden-no-comments", file: relative, root, tier: "edit", detail: sha256(failing), run: expect.any(String), policy: expect.any(String) });

    await writeFile(file, corrected);
    expect(await check()).toBe(0);
    expect(await check()).toBe(0);
    const events = readEvidence("fixture");
    const resolved = events.filter((e) => String(e.kind) === "resolved" && e.file === relative);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      guardrail: "warden-no-comments", file: relative, root, tier: "edit", status: "pass",
      detail: sha256(corrected), sourceRun: fire?.run, policy: expect.any(String),
    });
    expect(events).toContainEqual(expect.objectContaining({ kind: "cost", guardrail: "run", run: resolved[0]?.run, result: "pass", cached: warm ? 2 : 0 }));
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
