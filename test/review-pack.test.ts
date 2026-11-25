import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { expectedOutputs } from "../src/compiler/compile.js";
import { runExamples } from "../src/compiler/examples.js";
import { loadRecords } from "../src/records/load.js";
import { skillPath } from "../src/compiler/skills.js";
import { LOCK_PATH } from "../src/compiler/lock.js";
import { withVerdict } from "./verdict.js";

const warden = resolve(import.meta.dirname, "..");
const gate = join(warden, "packs/review/gate.js");
const cli = join(warden, "dist/src/cli/main.js");
const green = "import test from 'node:test'; test('a', () => {});\n";
const regression = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { v } from '../lib.mjs';",
  "test('a', () => assert.equal(v, 2));",
  "",
].join("\n");

const settings = { tests: ["test/**/*.test.mjs"], test: "node --test --test-isolation=none" };
let root: string;

const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, encoding: "utf8" });
const put = (file: string, content: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
};
const env = (base = "main", overrides = {}) => ({ ...process.env, WARDEN_BASE: base, WARDEN_SETTINGS: JSON.stringify({ ...settings, ...overrides }) });
const run = (base = "main", overrides = {}) => spawnSync(process.execPath, [gate], { cwd: root, encoding: "utf8", env: env(base, overrides) });
const change = (path = "test/a.test.mjs") => {
  put("lib.mjs", "export const v = 2;\n");
  put(path, regression);
};
const worktrees = () => git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "));
const refusal = (result: ReturnType<typeof run>, code: number, action: string) => {
  expect(result.status, result.stderr).toBe(code);
  expect(result.stderr.match(/Next action:/g)).toHaveLength(1);
  expect(result.stderr).toContain(action);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "warden-review-project-")));
  git("init", "-q", "-b", "main");
  put(".gitignore", "node_modules/\n");
  put("lib.mjs", "export const v = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

it("emits the generated review skill and passes the boundary gate through the CLI", async () => {
  put(".warden/config.yaml", [
    "warden: 0.1.0", "project: review-test", "base: main", "packs:",
    '  - { id: review, paths: ["**/*"], settings: { tests: ["test/**/*.test.mjs"], test: "node --test --test-isolation=none" } }',
    "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 120000 }", "loopBreakerRepeats: 3", "",
  ].join("\n"));
  const set = await loadRecords(root, warden);
  expect(await runExamples(set)).toEqual([]);
  const { files, lock } = await expectedOutputs(set, root, warden);
  put(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  for (const [path, content] of Object.entries(files)) put(path, content);
  const skill = readFileSync(join(root, skillPath("change-review")), "utf8");
  for (const step of ["warden check --rule review-gate", "warden review brief", "warden review triage"]) expect(skill).toContain(step);
  git("add", ".warden");
  git("commit", "-qm", "configure review");
  change();
  const check = (status?: string) => withVerdict(["check"], spawnSync(process.execPath, [cli, "check", "--rule", "review-gate", "--tier", "boundary", "--base", "main"], {
    cwd: root, encoding: "utf8", env: { ...process.env, WARDEN_TEST_EXIT: status },
  }));
  put("test/ops.test.mjs", "if (process.env.WARDEN_TEST_EXIT) process.exit(Number(process.env.WARDEN_TEST_EXIT));");
  const operational = check("2");
  expect(operational.status, operational.stdout + operational.stderr).toBe(2);
  expect(operational.stdout + operational.stderr).toContain("a test failure must exit 1");
  const pass = check();
  expect(pass.status, pass.stdout + pass.stderr).toBe(0);
});

it("refuses passing tests on the base until a regression test replaces them", () => {
  put("test/a.test.mjs", green);
  refusal(run(), 1, "so a test fails on main");
  change();
  expect(run().status).toBe(0);
});

it("reports an operational exit on the base and accepts an ordinary regression failure", () => {
  change();
  put("status.mjs", "import { v } from './lib.mjs'; process.exit(v === 2 ? 0 : 2);");
  git("add", "status.mjs");
  git("commit", "-qm", "add test command");
  refusal(run("main", { test: "node status.mjs" }), 2, "the test command on the base exited 2");
  expect(run().status).toBe(0);
});

it("does not carry first-run state from the change into the base", () => {
  put("test/first-run.test.mjs", [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "writeFileSync(join(process.env.HOME, 'first-run'), '', { flag: 'wx' });",
  ].join("\n"));
  refusal(run(), 1, "so a test fails on main");
});

it("refuses an empty change until a regression test is added", () => {
  refusal(run(), 1, "add a test under test/**/*.test.mjs");
  change();
  expect(run().status).toBe(0);
});

it("refuses tests that fail on the change until the change passes", () => {
  put("test/a.test.mjs", regression);
  refusal(run(), 1, "fix the failing tests");
  change();
  expect(run().status).toBe(0);
});

it("refuses stale generated output until the rebuild is staged", () => {
  put("build.mjs", "import { writeFileSync } from 'node:fs'; import { v } from './lib.mjs'; writeFileSync('out', String(v));");
  put("out", "1");
  git("add", "-A");
  git("commit", "-qm", "add build");
  change();
  const opts = { build: { command: "node build.mjs", output: "out" } };
  refusal(run("main", opts), 1, "git add -- out");
  git("add", "--", "out");
  const rebuilt = run("main", opts);
  expect(rebuilt.status, rebuilt.stderr).toBe(0);
});

it("refuses a missing base, then passes with a valid ref", () => {
  change();
  refusal(run("missing"), 2, "git fetch origin missing");
  expect(run().status).toBe(0);
});

it("passes file names as arguments and preserves the project and dependencies", () => {
  change("test/a file's.test.mjs");
  put("node_modules/keep", "present");
  const before = git("status", "--porcelain");
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(git("status", "--porcelain")).toBe(before);
  expect(worktrees()).toEqual([`worktree ${root}`]);
  expect(readFileSync(join(root, "node_modules/keep"), "utf8")).toBe("present");
});

it.each(["change", "base"])("removes scratch abandoned during %s tests", async (snapshot) => {
  change();
  put("hold.mjs", "import { existsSync, writeFileSync } from 'node:fs'; if (existsSync('hold.mjs') === (process.env.WARDEN_TEST_SNAPSHOT === 'change')) { writeFileSync(process.env.WARDEN_TEST_READY, process.env.HOME); setInterval(() => {}, 1000); }");
  const hold = join(root, "hold.mjs");
  const ready = join(root, "ready");
  const child = spawn(process.execPath, [gate], {
    cwd: root, detached: true, stdio: "ignore",
    env: { ...env("main", { test: `node '${hold}'` }), WARDEN_TEST_READY: ready, WARDEN_TEST_SNAPSHOT: snapshot },
  });
  const exited = once(child, "close");
  let scratch: string | undefined;
  try {
    for (let i = 0; i < 100 && !existsSync(ready) && child.exitCode === null; i++) await setTimeout(20);
    expect(existsSync(ready)).toBe(true);
    scratch = dirname(readFileSync(ready, "utf8"));
    expect(worktrees()).toHaveLength(snapshot === "base" ? 2 : 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
    await exited;
    const launch = async () => {
      const rerun = spawn(process.execPath, [gate], { cwd: root, stdio: ["ignore", "ignore", "pipe"], env: env() });
      let error = "";
      rerun.stderr.on("data", (chunk) => { error += chunk; });
      const [status] = await once(rerun, "close");
      expect(status, error).toBe(0);
    };
    await Promise.all([launch(), launch()]);
  }
  expect(worktrees()).toEqual([`worktree ${root}`]);
  expect(existsSync(scratch!)).toBe(false);
});
