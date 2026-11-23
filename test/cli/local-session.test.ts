import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expect, it } from "vitest";

const bin = resolve(import.meta.dirname, "../../bin/warden.js");

it("exposes the enabled checks and rejects arbitrary execution requests from the local session", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-local-session-"));
  try {
    const project = join(root, "project");
    const env = { ...process.env, WARDEN_HOME: join(root, "state"), GIT_CONFIG_GLOBAL: "/dev/null" };
    await mkdir(join(project, ".warden"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project, env });
    await writeFile(join(project, ".warden/config.yaml"), [
      "project: local-session-fixture",
      "base: main",
      "packs: [{ id: core, paths: [] }]",
      "tierBudgetMs: { edit: 2000, commit: 10000, boundary: 120000 }",
      "loopBreakerRepeats: 3",
    ].join("\n"));
    const call = (name: string, args: object = {}) => ({ name, arguments: args });
    const requests = [
      ["tools/list", {}],
      ["tools/call", call("list_checks")],
      ["tools/call", call("validate", { check: "anything", command: "npm test" })],
      ["tools/call", call("Bash", { command: "npm test" })],
      ["tools/call", call("validate", { check: "fixture-check" })],
    ];
    const input = requests.map(([method, params], id) => JSON.stringify({ jsonrpc: "2.0", id, method, params })).join("\n") + "\n";
    const run = spawnSync(process.execPath, [bin, "local-session-tools"], { cwd: project, env, encoding: "utf8", input, timeout: 5000 });
    expect(run.status, run.stderr).toBe(0);
    const [tools, checks, ...rejections] = run.stdout.trim().split("\n").map((line) => JSON.parse(line).result);
    expect(tools.tools.map((tool: { name: string }) => tool.name)).toEqual(["list_checks", "validate"]);
    expect(JSON.parse(checks.content[0].text)).toContainEqual(expect.objectContaining({ pack: "core", tiers: ["edit"] }));
    expect(rejections.map((result) => [result.isError, result.content[0].text])).toEqual([
      [true, expect.stringContaining("Provide a registered check ID")],
      [true, expect.stringContaining("Available tools")],
      [true, expect.stringContaining("daemon is not running")],
    ]);
    const launch = spawnSync(process.execPath, [bin, "local-session", "--print"], { cwd: project, env, encoding: "utf8", timeout: 5000 });
    expect(launch.status).toBe(2);
    expect(launch.stderr).toContain("run warden init");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("enforces local session permissions and runs only registered checks on edited code", async () => {
  const temp = await mkdtemp(join(tmpdir(), "warden-local-session-check-"));
  const project = join(temp, "project");
  const state = join(temp, "state");
  const commands = join(temp, "bin");
  const env = { ...process.env, WARDEN_HOME: state, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    PATH: commands + delimiter + process.env["PATH"] };
  const run = (args: string[], input?: string, override = {}) =>
    spawnSync(process.execPath, [bin, ...args], { cwd: project, env: { ...env, ...override }, encoding: "utf8", input, timeout: 8000 });
  const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.test", ...args], { cwd: project, env });
  const write = (file: string, content: string | object) => writeFile(join(project, file),
    typeof content === "string" ? content : JSON.stringify(content));
  const heartbeat = async (home: string) => {
    await mkdir(join(home, "daemon"), { recursive: true });
    await writeFile(join(home, "daemon/heartbeat.json"), JSON.stringify({ pid: process.pid, port: 1, at: new Date().toISOString() }));
  };
  try {
    await mkdir(join(project, ".warden/packs/local"), { recursive: true });
    await mkdir(commands);
    await mkdir(join(project, "test"));
    await writeFile(join(commands, "claude"),
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), daemon: process.env.WARDEN_DAEMON }));\n",
      { mode: 0o755 });
    git("init", "-qb", "main");
    const green = "export const status = 'ready';\n";
    const red = "export const status = 'pending';\n";
    const script = "import assert from 'node:assert/strict';\nimport { status } from '../status.mjs';\nassert.equal(status, 'ready');\n";
    await write(".warden/config.yaml", {
      project: "local-session-contract", base: "main", packs: [{ id: "local", paths: [] }],
      tierBudgetMs: { edit: 2000, commit: 10000, boundary: 120000 }, loopBreakerRepeats: 3,
    });
    await write(".warden/packs/local/pack.yaml", {
      id: "local", layer: 100, terms: [], practices: [{
        id: "verify-status", statement: "The fixture status is ready.", terms: [], paths: [], conflictsWith: [],
        guardrails: [{
          id: "fixture-contract", kind: "runtime", runs: ["edit"], version: 1, budgetMs: 2000,
          implementation: "cmd:node --test test/verify.mjs", sources: ["test/verify.mjs"],
          mustPass: { "test/verify.mjs": script, "status.mjs": green }, mustFail: { "test/verify.mjs": script, "status.mjs": red },
        }],
      }],
    });
    await write("status.mjs", red);
    await write("test/verify.mjs", script);
    const compiled = run(["compile"]);
    expect(compiled.status, compiled.stderr + compiled.stdout).toBe(0);
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "Approve fixture policy");
    git("config", "core.hooksPath", ".warden/generated/hooks");
    await heartbeat(state);
    const launch = run(["local-session", "--print"]);
    expect(launch.status, launch.stderr).toBe(0);
    const { args, daemon } = JSON.parse(launch.stdout) as { args: string[]; daemon?: string };
    const value = (flag: string) => args[args.indexOf(flag) + 1] as string;
    expect(args).toEqual(expect.arrayContaining(["--restricted", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]));
    expect(value("--setting-sources")).toBe("");
    expect(value("--permission-mode")).toBe("dontAsk");
    expect(value("--tools")).toBe("Read,Glob,Grep,Edit,Write,MultiEdit");
    expect(value("--allowedTools")).toBe("Read,Glob,Grep,Edit,Write,MultiEdit,mcp__warden__list_checks,mcp__warden__validate");
    expect(JSON.parse(value("--mcp-config"))).toEqual({ mcpServers: { warden: { command: process.execPath, args: [bin, "local-session-tools"] } } });
    const { hooks } = JSON.parse(value("--settings"));
    expect(hooks.PreToolUse[0]).toEqual({ matcher: "^(Edit|Write|MultiEdit)$",
      hooks: [{ type: "command", command: expect.stringMatching(/guard --local-session$/), onFailure: "block" }] });
    expect(hooks.PostToolUse[0].hooks[0].command).toMatch(/check --format agent --hook claude$/);
    expect(hooks.SessionEnd[0].hooks[0].command).toMatch(/session-end$/);
    expect(daemon).toBeUndefined();

    const inside = join(project, "state");
    await heartbeat(inside);
    const unsafe = run(["local-session"], undefined, { WARDEN_HOME: inside });
    expect(unsafe.status).toBe(2);
    expect(unsafe.stderr).toContain("outside the project");
    await rm(inside, { recursive: true, force: true });

    await symlink(join(project, ".git"), join(project, "metadata-alias"));
    const guard = (file_path: string) => run(["guard", "--local-session"], JSON.stringify({ tool_name: "Write", tool_input: { file_path } }));
    for (const file of [".git/config", ".WARDEN/config.yaml", ".claude/settings.json", "metadata-alias/config", "../outside"]) {
      const denied = guard(file);
      expect(denied.status, denied.stderr).toBe(0);
      expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    }
    expect(guard("status.mjs").stdout).toBe("");

    const validate = (check: string, tier = "edit") => {
      const input = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/call",
        params: { name: "validate", arguments: { check, tier } } }) + "\n";
      const result = run(["local-session-tools"], input, { WARDEN_DAEMON: "" });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout).result;
    };
    for (const [check, tier] of [["unknown", "edit"], ["fixture-contract", "boundary"]] as const) {
      const denied = validate(check, tier);
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toContain("unavailable");
    }
    const failure = validate("fixture-contract");
    expect(failure.isError).toBe(true);
    expect(JSON.parse(failure.content[0].text)).toMatchObject({ exit: 1, report: {
      failures: [expect.objectContaining({ guardrail: "fixture-contract" })],
    } });
    await write("status.mjs", green);
    const pass = validate("fixture-contract");
    expect(pass.isError, pass.content[0].text).toBe(false);
    expect(JSON.parse(pass.content[0].text)).toMatchObject({ exit: 0, report: { failures: [] } });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 15000);
