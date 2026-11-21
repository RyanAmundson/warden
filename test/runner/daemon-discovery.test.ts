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
    daemon.discover();
    expect([...daemon.projects.keys()].sort()).toEqual([linked, primary, separate].sort());

    git(primary, "worktree", "move", linked, moved);
    mkdirSync(linked);
    git(primary, "worktree", "add", "--detach", sibling);
    list.mockClear();
    daemon.discover();
    expect([...daemon.projects.keys()]).toEqual(expect.arrayContaining([moved, primary, separate, sibling]));
    expect(list).toHaveBeenCalledTimes(2);
  } finally {
    await daemon?.stop();
    list.mockRestore();
    rmSync(scratch, { recursive: true, force: true });
  }
});
