import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refusal, shellCommands, skipsCommitHook } from "../../src/adapters/claude.js";

const skips = (command: string): (string | undefined)[] => shellCommands(command).map(skipsCommitHook).filter((f) => f !== undefined);

describe("the commit flag parser", () => {
  it.each([
    ["git commit -n", "-n"],
    ["git commit -an", "-an"],
    ["git commit -na -m x", "-na"],
    ["git commit --no-verify", "--no-verify"],
    ["git commit --no-veri -m x", "--no-veri"],
    ["git commit -m x -n", "-n"],
    ["cd src && git commit -n", "-n"],
    ["git -C src -c user.name=x commit -n", "-n"],
    ["GIT_EDITOR=true /usr/bin/git commit -n", "-n"],
    ["echo ok; git commit -q -n", "-n"],
    ["git commit -F msg.txt -n", "-n"],
  ])("refuses %s", (command, flag) => {
    expect(skips(command)).toEqual([flag]);
  });

  it.each([
    'git commit -m "fix -n handling"',
    "git commit -m 'retry with -n'",
    "git commit -m -n",
    "git commit -mn",
    "git commit --message -n",
    "git commit --message=-n",
    "git commit -m x -- -n",
    "git commit -m x # -n",
    "git log -n 3",
    "echo git commit -n",
    "git commit --no-edit",
    "git commit -uno -m x",
    "git commit -S-n -m x",
    'git commit -m "$(cat <<\'EOF\'\nA "quoted" -n line\nEOF\n)"',
  ])("allows %s", (command) => {
    expect(skips(command)).toEqual([]);
  });
});

describe("refusal", () => {
  let root: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "warden-guard-")));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("refuses Edit, Write, and MultiEdit under .warden and nothing else", () => {
    for (const tool of ["Edit", "Write", "MultiEdit"]) {
      expect(refusal(root, JSON.stringify({ tool_name: tool, tool_input: { file_path: join(root, ".warden/lock.json") } }))).toMatch(/^\.warden\/lock\.json is a Warden record.*Next action: /);
    }
    expect(refusal(root, JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(root, "src/.warden.ts") } }))).toBeUndefined();
    expect(refusal(root, JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(root, ".warden/lock.json") } }))).toBeUndefined();
  });

  it("refuses a new file under .warden reached through a symlinked parent", async () => {
    const link = join(await mkdtemp(join(tmpdir(), "warden-link-")), "project");
    await symlink(root, link);
    const input = JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(link, ".warden/new/rules.yaml") } });
    expect(refusal(await realpath(root), input)).toContain(".warden/new/rules.yaml is a Warden record");
  });

  it("names exactly one next action for a refused commit", () => {
    const reason = refusal(root, JSON.stringify({ tool_name: "Bash", tool_input: { command: "git commit -an -m x" } })) as string;
    expect(reason.match(/Next action/g)).toHaveLength(1);
    expect(reason).toContain("with -a in place of -an");
  });

  it("refuses input that is not a hook payload", () => {
    expect(() => refusal(root, "not json")).toThrow("is not JSON. Next action: update Claude Code, then retry the tool call");
    expect(() => refusal(root, JSON.stringify({ tool_name: "Bash", tool_input: {} }))).toThrow("is missing");
  });
});
