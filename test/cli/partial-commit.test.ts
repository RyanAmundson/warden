import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { type Served, serve } from "../../src/cli/daemon.js";
import { buildReport } from "../../src/cli/report.js";
import { RUN_TOTAL, readEvidence } from "../../src/runner/evidence.js";

const warden = resolve(import.meta.dirname, "../..");
const temp = realpathSync(mkdtempSync(join(tmpdir(), "warden-partial-commit-")));
const root = join(temp, "project");
const bin = join(temp, "bin");
const source = (name: string, text: string): void => writeFileSync(join(root, "src", name), text);
let daemon: Served | undefined;
const run = (exe: string, args: string[]) => spawnSync(exe, args, { cwd: root, encoding: "utf8", env: { ...process.env, PATH: bin + ":" + process.env.PATH } });
const gitResult = (...args: string[]) => run("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args]);
const git = (...args: string[]) => {
  const r = gitResult(...args);
  expect(r.status, r.stdout + r.stderr).toBe(0);
  return r.stdout;
};

beforeAll(async () => {
  vi.stubEnv("WARDEN_HOME", join(temp, "warden-home"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(temp, "claude"));
  vi.stubEnv("WARDEN_DAEMON", undefined);
  vi.stubEnv("GIT_INDEX_FILE", undefined);
  daemon = await serve(warden, 0);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(bin);
  symlinkSync(join(warden, "bin/warden.js"), join(bin, "warden"));
  git("init", "-q", "-b", "main");
  git("config", "core.hooksPath", ".warden/generated/hooks");
  source("a.ts", "export const a = 1;\n");
  source("b.ts", "export const b = 1;\n");
  git("add", ".");
  git("commit", "-qm", "Scaffold");
  const init = run(process.execPath, [join(warden, "bin/warden.js"), "init"]);
  expect(init.status, init.stdout + init.stderr).toBe(0);
  git("add", ".");
  git("commit", "-qm", "Configure Warden");
  git("checkout", "-qb", "feature");
  source("b.ts", "export const b = 2;\n");
  git("add", "src/b.ts");
  git("commit", "-qm", "Update b");
});

afterAll(async () => {
  try {
    await daemon?.close();
  } finally {
    vi.unstubAllEnvs();
    rmSync(temp, { recursive: true, force: true });
  }
});

it("commits the selected path while leaving an earlier branch file's new edits unstaged", async () => {
  source("b.ts", "// Document the next result\nexport const b = 3;\n");
  source("staged.ts", "export const staged = true;\n");
  git("add", "src/staged.ts");
  source("a.ts", "// Explain the current value\nexport const a = 2;\n");
  const refused = gitResult("commit", "-qm", "Update a with a comment", "--", "src/a.ts");
  expect(refused.status).toBe(1);
  expect(refused.stdout + refused.stderr).toContain("FAIL src/a.ts:1");
  source("a.ts", "export const a = 2;\n");
  git("commit", "-qm", "Update a alone", "--", "src/a.ts");
  expect(git("show", "HEAD:src/a.ts")).toBe("export const a = 2;\n");
  expect(git("show", "HEAD:src/b.ts")).toBe("export const b = 2;\n");
  expect(git("status", "--short", "--", "src/b.ts", "src/staged.ts")).toBe(" M src/b.ts\nA  src/staged.ts\n");
  expect(readFileSync(join(root, "src/b.ts"), "utf8")).toBe("// Document the next result\nexport const b = 3;\n");

  const evidence = readEvidence("project");
  const receipt = evidence.filter((event) => event.kind === "cost" && event.guardrail === RUN_TOTAL).at(-1);
  const bytesPerFile = Buffer.byteLength("export const a = 2;\n");
  expect(receipt).toMatchObject({ scope: "full", exit: 0, tree: git("rev-parse", "HEAD^{tree}").trim(), files: 2, bytes: 2 * bytesPerFile });
  const batches = evidence.filter((event) => event.kind === "cost" && event.shared === "eslint" && event.run === receipt?.run);
  expect(batches.map(({ files, bytes }) => ({ files, bytes }))).toEqual([
    { files: 1, bytes: bytesPerFile },
    { files: 1, bytes: bytesPerFile },
  ]);
  const lint = evidence.filter((event) => event.kind === "cost" && event.shared === "eslint" && event.tier === "commit");
  const runs = new Set(lint.map((event) => event.run));
  const overhead = [...runs].map((id) => lint.filter((event) => event.run === id).reduce((ms, event) =>
    ms + (event.ms ?? 0) - Object.values(event.rules ?? {}).reduce((total, ruleMs) => total + ruleMs, 0), 0));
  const report = await buildReport(root, warden);
  expect(report.tiers.find(({ tier }) => tier === "commit")?.passes[0]).toMatchObject({
    shared: "eslint", runs: runs.size, slowestMs: Math.round(Math.max(...overhead)),
  });
});

it("keeps full-file lint scope for an ordinary commit using a saved staging area", () => {
  source("b.ts", "export const b = 2;\n");
  source("a.ts", "export const a = 3;\n");
  source("staged.ts", "export const staged = true;\n");
  source("draft.ts", "export const draft = true;\n");
  vi.stubEnv("GIT_INDEX_FILE", join(temp, "saved-staging-area"));
  try {
    git("read-tree", "HEAD");
    git("add", "--", "src/a.ts", "src/staged.ts");
    git("commit", "-qm", "Commit the saved staging area");
  } finally {
    vi.stubEnv("GIT_INDEX_FILE", undefined);
  }
  const receipt = readEvidence("project").filter((event) => event.kind === "cost" && event.guardrail === RUN_TOTAL).at(-1);
  expect(receipt).toMatchObject({ scope: "full", exit: 0, tree: git("rev-parse", "HEAD^{tree}").trim(), files: 4 });
  expect(git("ls-files", "--others", "--exclude-standard", "--", "src/draft.ts")).toBe("src/draft.ts\n");
});

it("checks a path-selected commit from a saved staging area", () => {
  source("b.ts", "export const b = 4;\n");
  source("a.ts", "export const a = 4;\n");
  vi.stubEnv("GIT_INDEX_FILE", join(temp, "path-staging-area"));
  try {
    git("read-tree", "HEAD");
    git("commit", "-qm", "Commit just a from the saved staging area", "--", "src/a.ts");
  } finally {
    vi.stubEnv("GIT_INDEX_FILE", undefined);
  }
  expect(git("show", "HEAD:src/a.ts")).toBe("export const a = 4;\n");
  expect(git("show", "HEAD:src/b.ts")).toBe("export const b = 2;\n");
  expect(readFileSync(join(root, "src/b.ts"), "utf8")).toBe("export const b = 4;\n");
});
