import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import * as changed from "../../src/runner/changed.js";
import { type Daemon, startWatching } from "../../src/runner/daemon.js";
import { appendEvidence } from "../../src/runner/evidence.js";

const wardenRoot = resolve(import.meta.dirname, "../..");

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=Warden Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function init(root: string, project: string): void {
  mkdirSync(join(root, ".warden"), { recursive: true });
  writeFileSync(join(root, ".warden/config.yaml"), `project: ${project}
base: main
packs: []
tierBudgetMs: { edit: 1000, commit: 1000, boundary: 1000 }
loopBreakerRepeats: 3
`);
  git(root, "init", "-qb", "main");
  git(root, "config", "core.hooksPath", join(root, "no-hooks"));
  git(root, "add", ".warden/config.yaml");
  git(root, "commit", "-qm", "Register fixture");
}

it("discovers every linked worktree with one listing per repository on each discovery", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "warden-discovery-")));
  const primary = join(scratch, "primary");
  const linked = join(scratch, "linked");
  const moved = join(scratch, "moved");
  const sibling = join(scratch, "sibling");
  const separate = join(scratch, "separate");
  const list = vi.spyOn(changed, "worktrees");
  let daemon: Daemon | undefined;

  try {
    init(primary, "primary");
    init(separate, "separate");
    git(primary, "worktree", "add", "--detach", linked);
    appendEvidence("primary", { at: new Date().toISOString(), kind: "registered", root: linked });
    appendEvidence("separate", { at: new Date().toISOString(), kind: "registered", root: separate });
    daemon = startWatching({ wardenRoot, port: 0 });
    await daemon.discover();
    expect([...daemon.projects.keys()].sort()).toEqual([linked, primary, separate].sort());

    await daemon.settled();
    git(primary, "worktree", "move", linked, moved);
    mkdirSync(linked);
    git(primary, "worktree", "add", "--detach", sibling);
    list.mockClear();
    await Promise.all([daemon.discover(), daemon.discover()]);
    expect([...daemon.projects.keys()]).toEqual(expect.arrayContaining([moved, primary, separate, sibling]));
    expect(list.mock.calls.filter(([root]) => root.endsWith("/.git"))).toHaveLength(2);
  } finally {
    await daemon?.stop();
    list.mockRestore();
    rmSync(scratch, { recursive: true, force: true });
  }
});

it("watches new evidence and other repositories while a worktree listing waits", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "warden-discovery-wait-")));
  const slow = join(scratch, "slow");
  const separate = join(scratch, "separate");
  const linked = join(scratch, "linked");
  const registered = join(scratch, "registered");
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  const original = changed.worktrees;
  const module: { worktrees(root: string): changed.Worktree[] | Promise<changed.Worktree[]> } = changed;
  const list = vi.spyOn(module, "worktrees").mockImplementation(async (root) => {
    if (root === join(slow, ".git")) {
      started = true;
      await waiting;
    }
    return original(root);
  });
  let daemon: Daemon | undefined;

  try {
    init(slow, "slow");
    init(separate, "separate");
    init(registered, "registered");
    git(separate, "worktree", "add", "--detach", linked);
    appendEvidence("slow", { at: new Date().toISOString(), kind: "registered", root: slow });
    appendEvidence("separate", { at: new Date().toISOString(), kind: "registered", root: separate });
    const live = startWatching({ wardenRoot, port: 0, intervalMs: 60_000 });
    daemon = live;
    await vi.waitFor(() => expect(started).toBe(true));
    appendEvidence("registered", { at: new Date().toISOString(), kind: "registered", root: registered });
    await vi.waitFor(() => {
      expect(live.projects.has(linked)).toBe(true);
      expect(live.projects.has(registered)).toBe(true);
    });
  } finally {
    release?.();
    await daemon?.stop();
    list.mockRestore();
    rmSync(scratch, { recursive: true, force: true });
  }
});
