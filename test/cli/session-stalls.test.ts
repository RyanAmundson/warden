import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runCheck } from "../../src/cli/check.js";
import { appendEvidence, readEvidence } from "../../src/runner/evidence.js";

const warden = resolve(import.meta.dirname, "../..");

const root = realpathSync(mkdtempSync(join(tmpdir(), "warden-session-end-")));
const bin = join(root, "fixture-bin");
const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root });
const run = (executable: string, args: string[], input?: object) => {
  const result = spawnSync(executable, args, { cwd: root, encoding: "utf8", ...(input === undefined ? {} : { input: JSON.stringify(input) }), env: { ...process.env, PATH: bin + ":" + process.env.PATH } });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
};
const cli = (...args: string[]) => run(process.execPath, [join(warden, "bin/warden.js"), ...args]);
const hook = (mode: string, input: object) => run("sh", [join(warden, "hooks/warden.sh"), mode], input);

beforeAll(() => {
  mkdirSync(join(root, "src"));
  mkdirSync(bin);
  symlinkSync(join(warden, "bin/warden.js"), join(bin, "warden"));
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, ".gitignore"), "fixture-bin/\n");
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "Scaffold");
  cli("init");
  git("add", ".");
  git("commit", "-qm", "Track Warden configuration");
  git("checkout", "-qb", "feature");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

it("records only unresolved failures when the Claude session ends", async () => {
  const check = async (name: string, session: string, source: string) => {
    const file = join(root, "src", name);
    writeFileSync(file, source);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await runCheck({
        root, wardenRoot: warden, hook: "claude", format: "agent",
        hookInput: JSON.stringify({ hook_event_name: "PostToolUse", session_id: session, cwd: root, tool_name: "Write", tool_input: { file_path: file } }),
      })).toBe(0);
      return output.mock.calls.flat().join("");
    } finally {
      output.mockRestore();
    }
  };
  const issue = "// Describe the result\nexport const result = 1;\n";
  expect(await check("foreign.ts", "other-session", issue)).toContain("  no-comments");
  expect(await check("fixed.ts", "test-session", issue)).toContain("  no-comments");
  expect(await check("disputed.ts", "other-session", issue)).toContain("  no-comments");
  cli("dispute", "warden-no-comments", "src/disputed.ts", "--reason", "The product needs documentation", "--attempt", "Use a Unit document");
  expect(await check("disputed.ts", "test-session", issue)).toContain("  no-comments");
  expect(await check("fixed.ts", "test-session", "export const documentedResult = 1;\n")).not.toContain("src/fixed.ts");
  expect(await check("open.ts", "test-session", issue)).toContain("  no-comments");
  const project = root.split("/").at(-1) as string;
  appendEvidence(project, { at: new Date().toISOString(), root: join(root, "other"), kind: "cost", detail: "A".repeat(1_100_000) });
  const end = { hook_event_name: "SessionEnd", session_id: "test-session", cwd: root, reason: "prompt_input_exit" };
  expect(hook("session-end", end)).toBe("");
  expect(hook("session-end", end)).toBe("");

  const stalled = readEvidence(project).filter((event) => event.kind === "stalled");
  expect(stalled).toEqual([expect.objectContaining({ file: "src/open.ts", guardrail: "warden-no-comments", root, status: "fail" })]);
  expect(JSON.parse(cli("report", "--learning", "--json"))).toContainEqual(expect.objectContaining({ guardrail: "warden-no-comments", stalls: 1 }));
  expect(await check("disputed.ts", "test-session", issue.replace("result = 1", "result = 2"))).toContain("  no-comments");
  expect(hook("session-end", end)).toBe("");
  expect(readEvidence(project).filter((event) => event.kind === "stalled")).toEqual([
    expect.objectContaining({ file: "src/open.ts" }), expect.objectContaining({ file: "src/disputed.ts" }),
  ]);
});
