import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitHook } from "../src/compiler/emit.js";

const warden = resolve(import.meta.dirname, "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "warden-never-blocks-")));
const bin = join(root, "fixture-bin");
const fakeBin = join(root, "fake-bin");
const SYSTEM_PATH = "/usr/bin:/bin";
const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root });
const run = (executable: string, args: string[], opts: { input?: string; path?: string; env?: Record<string, string | undefined> } = {}) =>
  spawnSync(executable, args, { cwd: root, encoding: "utf8", input: opts.input ?? "", env: { ...process.env, ...opts.env, PATH: opts.path ?? `${bin}:${process.env.PATH}` } });
const cli = (args: string[], opts: Parameters<typeof run>[2] = {}) => run(process.execPath, [join(warden, "bin/warden.js"), ...args], opts);
const hook = (mode: string, input: object, path?: string) => run("sh", [join(warden, "hooks/warden.sh"), mode], { input: JSON.stringify(input), ...(path === undefined ? {} : { path }) });
const edit = (file: string) => ({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(root, file) } });
const bash = (command: string) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const blocking = (stdout: string): boolean => /"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"block"/.test(stdout);

beforeAll(() => {
  mkdirSync(join(root, "src"));
  mkdirSync(bin);
  mkdirSync(fakeBin);
  symlinkSync(join(warden, "bin/warden.js"), join(bin, "warden"));
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, ".gitignore"), "fixture-bin/\nfake-bin/\n");
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "Scaffold");
  expect(cli(["init"]).status).toBe(0);
  git("add", ".");
  git("commit", "-qm", "Track Warden configuration");
}, 120_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("source never asks a harness to block", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });

  it("no source file writes a deny or block decision", () => {
    for (const file of [...files(join(warden, "src")), ...files(join(warden, "hooks"))]) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/permissionDecision:\s*"deny"|decision:\s*"block"|"onFailure"/);
    }
  });

  it("the plugin hook script and the generated commit hook only exit 0", () => {
    for (const script of [readFileSync(join(warden, "hooks/warden.sh"), "utf8"), commitHook("9.9.9", "main")]) {
      const exits = script.match(/(?:^\s*|&&\s*|\|\|\s*)exit\s+\S+/gm) ?? [];
      expect(exits.length).toBeGreaterThan(0);
      for (const e of exits) expect(e.trim().endsWith("exit 0"), e).toBe(true);
      expect(script).not.toMatch(/\bexec\b/);
    }
  });

  it("no daemon next action asks to reset, delete, or rewrite history", () => {
    const daemon = readFileSync(join(warden, "src/runner/daemon.ts"), "utf8");
    expect(daemon).not.toMatch(/every ref|resetting or deleting|remove commit/);
  });
});

describe("the generated pre-commit hook", () => {
  const hookFile = join(root, "pre-commit-under-test");
  beforeAll(() => {
    writeFileSync(hookFile, commitHook("9.9.9", "main"));
    chmodSync(hookFile, 0o755);
  });

  it("exits 0 when warden is not on PATH", () => {
    const r = run(hookFile, [], { path: SYSTEM_PATH });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("Warden did not check this commit");
  });

  it("exits 0 when warden check exits nonzero", () => {
    writeFileSync(join(fakeBin, "warden"), "#!/bin/sh\necho refused >&2\nexit 1\n");
    chmodSync(join(fakeBin, "warden"), 0o755);
    const r = run(hookFile, [], { path: `${fakeBin}:${SYSTEM_PATH}` });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("Warden's commit check exited 1");
  });
});

describe("the plugin hooks", { timeout: 60_000 }, () => {
  it("exit 0 for every event when warden is missing", () => {
    for (const [event, input] of [["guard", edit("src/a.ts")], ["guard", bash("git commit -m x")], ["check", edit("src/a.ts")], ["session-end", {}]] as const) {
      const r = hook(event, input, SYSTEM_PATH);
      expect(r.status, `${event} ${r.stderr}`).toBe(0);
      expect(r.stderr).toContain("Warden did not run");
    }
  });

  it("report a .warden edit and a skipped commit hook without denying them", () => {
    for (const input of [edit(".warden/config.yaml"), bash("git commit --no-verify -m x")]) {
      const r = hook("guard", input);
      expect(r.status, r.stderr).toBe(0);
      expect(blocking(r.stdout)).toBe(false);
      expect(JSON.parse(r.stdout)).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: expect.stringContaining("Next action") } });
    }
  });

  it("exit 0 when warden itself fails", () => {
    const r = run("sh", [join(warden, "hooks/warden.sh"), "guard"], { input: "not json" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("is not JSON");
  });
});

describe("the CLI", { timeout: 120_000 }, () => {
  it("check and audit exit 0 when the lock was written by an older Warden", () => {
    const lock = join(root, ".warden/lock.json");
    const original = readFileSync(lock, "utf8");
    try {
      writeFileSync(lock, original.replace(/"warden": "[^"]+"/, '"warden": "0.1.0"'));
      for (const args of [["check", "--base", "main"], ["check", "--base", "main", "--trigger", "git-commit"], ["audit", "--base", "main"]]) {
        const r = cli(args);
        expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
        expect(r.stderr).toContain("an older release than this Warden");
      }
      const edited = cli(["check", "--hook", "claude"], { input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(root, "src/a.ts") } }) });
      expect(edited.status).toBe(0);
      expect(blocking(edited.stdout)).toBe(false);
    } finally {
      writeFileSync(lock, original);
    }
  });

  it("a commit check exits 0 and still runs while the daemon is not running", () => {
    const r = cli(["check", "--base", "main", "--trigger", "git-commit"], { env: { WARDEN_DAEMON: undefined, WARDEN_HOME: mkdtempSync(join(tmpdir(), "warden-no-daemon-")) } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("Warden's daemon is not running");
  });

  it("check, guard, and session-end exit 0 on bad input or outside a git repository", () => {
    expect(cli(["check", "--tier", "nope"]).status).toBe(0);
    expect(cli(["guard"], { input: "not json" }).status).toBe(0);
    const outside = spawnSync(process.execPath, [join(warden, "bin/warden.js"), "check"], { cwd: tmpdir(), encoding: "utf8" });
    expect(outside.status, outside.stderr).toBe(0);
  });
});
