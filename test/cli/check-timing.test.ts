import { execFileSync } from "node:child_process";
import { cp, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { runCheck } from "../../src/cli/check.js";
import { compile } from "../../src/compiler/compile.js";
import { readEvidence } from "../../src/runner/evidence.js";

const wardenRoot = resolve(import.meta.dirname, "../..");

it("records base verification time for accepted and rejected bases", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "warden-check-timing-")));
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args,
  ], { cwd: root });
  const check = (base: string) => runCheck({ root, wardenRoot, base, format: "text", tier: "edit", paths: ["example.ts"] });
  try {
    await cp(join(wardenRoot, "test/fixtures/project-valid"), root, { recursive: true });
    await writeFile(join(root, "example.ts"), "export const example = 1;\n");
    git("init", "-qb", "main");
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    git("add", "-A");
    git("commit", "-qm", "Initial fixture");

    expect(await check("main")).toBe(0);
    expect(await check("missing-base")).toBe(2);
    const runs = readEvidence("fixture").filter((entry) => entry.guardrail === "run");
    expect(runs).toMatchObject([
      { root, outcome: "ran", baseVerificationMs: expect.any(Number) },
      { outcome: "error", baseVerificationMs: expect.any(Number) },
    ]);
    expect(runs[1]).not.toHaveProperty("root");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
