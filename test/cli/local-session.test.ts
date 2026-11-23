import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
