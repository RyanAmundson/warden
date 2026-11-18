import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scripts = resolve(import.meta.dirname, "../../scripts");

let repo: string;

const git = (...args: string[]): void => {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    stdio: "ignore",
  });
};

const sh = (file: string, ...args: string[]): { code: number | null; out: string; err: string } => {
  const r = spawnSync(file, args, { cwd: repo, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "warden-scripts-"));
  await mkdir(join(repo, "scripts"));
  await copyFile(join(scripts, "self-check.sh"), join(repo, "scripts/self-check.sh"));
  await copyFile(join(scripts, "install-hooks.sh"), join(repo, "scripts/install-hooks.sh"));
  await writeFile(join(repo, "a.txt"), "one\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
});

afterEach(() => rm(repo, { recursive: true, force: true }));

describe("self-check.sh", () => {
  it("refuses unstaged changes to tracked files", async () => {
    await writeFile(join(repo, "a.txt"), "two\n");
    const r = sh("scripts/self-check.sh", "v0.1.0");
    expect(r.code).toBe(1);
    expect(r.err).toContain("stage or discard unstaged changes, then commit");
  });

  it("refuses a staged change whose working copy was restored", async () => {
    await writeFile(join(repo, "a.txt"), "two\n");
    git("add", "a.txt");
    await writeFile(join(repo, "a.txt"), "one\n");
    expect(sh("scripts/self-check.sh", "v0.1.0").code).toBe(1);
  });

  it("judges with the tagged release's code over the working copy's packs and names the base", async () => {
    const bin = [
      "#!/usr/bin/env node",
      "const { readFileSync, realpathSync } = require(\"node:fs\");",
      "const { dirname, join } = require(\"node:path\");",
      "const here = dirname(realpathSync(process.argv[1]));",
      "process.stdout.write(`release ${readFileSync(join(here, \"release.txt\"), \"utf8\")}`);",
      "process.stdout.write(`pack ${readFileSync(join(here, \"packs/core/pack.yaml\"), \"utf8\")}`);",
      "process.stdout.write(`args ${process.argv.slice(2).join(\" \")}\\n`);",
      "",
    ].join("\n");
    const manifest = { name: "warden", version: "0.0.0", bin: { warden: "bin.js" }, scripts: { build: "exit 1", prepare: "true" }, files: ["bin.js", "release.txt", "packs"] };
    await writeFile(join(repo, "package.json"), JSON.stringify(manifest));
    await writeFile(join(repo, "bin.js"), bin);
    await chmod(join(repo, "bin.js"), 0o755);
    await writeFile(join(repo, "release.txt"), "old\n");
    await mkdir(join(repo, "packs/core"), { recursive: true });
    await writeFile(join(repo, "packs/core/pack.yaml"), "old\n");
    git("add", "-A");
    git("commit", "-q", "-m", "release");
    git("tag", "t1");
    await writeFile(join(repo, "release.txt"), "new\n");
    await writeFile(join(repo, "packs/core/pack.yaml"), "new\n");
    git("add", "-A");
    const r = sh("scripts/self-check.sh", "t1");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("release old\npack new\nargs check --base main --trigger git-commit\n");
  });

  it("refuses a dist that differs from a fresh compile, stale files included, with one next action", async () => {
    await symlink(resolve(scripts, "../node_modules"), join(repo, "node_modules"));
    await writeFile(join(repo, ".gitignore"), "node_modules\n");
    await writeFile(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: ".", module: "NodeNext", moduleResolution: "NodeNext", types: [] }, include: ["src"] }));
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "src/x.ts"), "export const x = 1;\n");
    execFileSync("node_modules/.bin/tsc", [], { cwd: repo });
    git("add", "-A");
    git("commit", "-q", "-m", "built");
    git("tag", "t1");
    const clean = sh("scripts/self-check.sh", "t1");
    expect(clean.err).not.toContain("differs from a fresh compile");
    await writeFile(join(repo, "dist/src/old.js"), "export const old = 1;\n");
    git("add", "-A");
    const stale = sh("scripts/self-check.sh", "t1");
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("staged dist/src differs from a fresh compile of the source. Next action: run npm run build:dist, stage dist, then commit.");
  });

  it("refuses a built dist file that is not staged, and a source that does not compile, each with one next action", async () => {
    await symlink(resolve(scripts, "../node_modules"), join(repo, "node_modules"));
    await writeFile(join(repo, ".gitignore"), "node_modules\n");
    await writeFile(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: ".", module: "NodeNext", moduleResolution: "NodeNext", types: [] }, include: ["src"] }));
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "src/x.ts"), "export const x = 1;\n");
    execFileSync("node_modules/.bin/tsc", [], { cwd: repo });
    git("add", "-A");
    git("commit", "-q", "-m", "built");
    git("tag", "t1");
    await writeFile(join(repo, "src/y.ts"), "export const y = 1;\n");
    git("add", "src/y.ts");
    execFileSync("node_modules/.bin/tsc", [], { cwd: repo });
    const unstaged = sh("scripts/self-check.sh", "t1");
    expect(unstaged.code).toBe(1);
    expect(unstaged.err).toContain("staged dist/src differs from a fresh compile of the source. Next action: run npm run build:dist, stage dist, then commit.");
    await writeFile(join(repo, "src/y.ts"), "export const y: number = 'a';\n");
    git("add", "src/y.ts");
    const broken = sh("scripts/self-check.sh", "t1");
    expect(broken.code).toBe(1);
    expect(broken.err).toContain("Next action: run npm run typecheck and fix the errors it names, then commit.");
  });

  it("requires the pinned tag as an argument", () => {
    const r = sh("scripts/self-check.sh");
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage");
  });
});

describe("install-hooks.sh", () => {
  it("installs a hook that runs the pinned tag's script, never the working copy's", async () => {
    await writeFile(join(repo, "scripts/self-check.sh"), '#!/bin/sh\necho "ran $1"\n');
    await chmod(join(repo, "scripts/self-check.sh"), 0o755);
    git("add", "-A");
    git("commit", "-q", "-m", "pin");
    git("tag", "t1");
    expect(sh("scripts/install-hooks.sh", "t1").code).toBe(0);
    await writeFile(join(repo, "scripts/self-check.sh"), "#!/bin/sh\nexit 9\n");
    git("add", "-A");
    git("commit", "-q", "-m", "tamper");
    const r = sh(".git/hooks/pre-commit");
    expect(r.code).toBe(0);
    expect(r.out).toContain("ran t1");
  });

  it("refuses a tag that does not exist", () => {
    expect(sh("scripts/install-hooks.sh", "nope").code).toBe(2);
  });
});
