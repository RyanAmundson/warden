import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { serve } from "../../src/cli/daemon.js";
import { compile } from "../../src/compiler/compile.js";
import * as changed from "../../src/runner/changed.js";
import { type Daemon, openAlerts, startWatching, stateFile } from "../../src/runner/daemon.js";
import { appendEvidence, readEvidence } from "../../src/runner/evidence.js";

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

it("reads each unchecked commit once when listing alerts for a repository", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "warden-alerts-")));
  const lookup = vi.spyOn(changed, "commitsOf");
  try {
    const root = join(scratch, "repo");
    init(root, "repo");
    const first = changed.headCommit(root)!;
    writeFileSync(join(root, "changed.txt"), "updated");
    git(root, "add", "changed.txt");
    git(root, "commit", "-qm", "Update fixture");
    const second = changed.headCommit(root)!;
    const missing = "0".repeat(first.length);
    const repo = join(root, ".git");
    const atOtherWorktree = join(scratch, "other");
    const alert = { project: "repo", root, repo, detail: "unchecked-commit", next: "check the commit" };
    const open = [
      { ...alert, file: first },
      { ...alert, file: second },
      { ...alert, file: missing },
      { ...alert, root: atOtherWorktree, file: second },
    ];
    mkdirSync(resolve(stateFile(), ".."), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ roots: { [root]: { open } } }));

    const trace = join(scratch, "git-trace.jsonl");
    vi.stubEnv("GIT_TRACE2_EVENT", trace);
    try {
      expect(openAlerts(root)).toEqual(open);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(lookup.mock.calls).toEqual([[root, [first, second, missing]]]);
    const commands = readFileSync(trace, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
      .filter(({ event }) => event === "start")
      .map(({ argv }) => argv);
    expect(commands.filter((argv) => argv?.includes("--batch-check=%(objectname) %(objecttype)"))).toHaveLength(1);
    expect(commands.filter((argv) => argv?.includes("--verify"))).toEqual([]);

    const backlog = Array.from({ length: 260 }, (_, i) => ({ ...alert, file: (i + 1).toString(16).padStart(first.length, "0") }));
    writeFileSync(stateFile(), JSON.stringify({ roots: { [root]: { open: backlog } } }));
    lookup.mockClear().mockReturnValue([]);

    expect(openAlerts(root)).toEqual(backlog);
    expect(lookup.mock.calls).toEqual([
      [root, backlog.slice(0, 256).map((d) => d.file)],
      [root, backlog.slice(256).map((d) => d.file)],
    ]);
  } finally {
    lookup.mockRestore();
    rmSync(scratch, { recursive: true, force: true });
  }
});

it.each([false, true])("serves dashboard health while a merge-base lookup waits (HEAD changes: %s)", async (moveHead) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "warden-merge-base-wait-")));
  const root = join(scratch, "repo");
  const bin = join(scratch, "bin");
  const active = join(scratch, "merge-base-active");
  let dashboard: Awaited<ReturnType<typeof serve>> | undefined;

  try {
    init(root, "repo");
    await compile(root, wardenRoot);
    git(root, "add", ".warden");
    git(root, "commit", "-qm", "Record fixture lock");
    appendEvidence("repo", { at: new Date().toISOString(), kind: "registered", root });
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$1" = merge-base ] && [ "$2" != --is-ancestor ]; then
  touch "$WARDEN_FIXTURE_ACTIVE"
  sleep 1
  rm "$WARDEN_FIXTURE_ACTIVE"
fi
exec "$WARDEN_FIXTURE_GIT" "$@"
`, { mode: 0o755 });
    vi.stubEnv("WARDEN_FIXTURE_GIT", realGit);
    vi.stubEnv("WARDEN_FIXTURE_ACTIVE", active);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);

    dashboard = await serve(wardenRoot, 0, { intervalMs: 60_000 });
    await vi.waitFor(() => expect(existsSync(active)).toBe(true), { timeout: 1500 });
    const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/health`);
    expect(response.status).toBe(200);
    expect(existsSync(active)).toBe(true);
    if (moveHead) {
      writeFileSync(join(root, "notes.txt"), "Updated during the scan");
      git(root, "add", "notes.txt");
      git(root, "commit", "-qm", "Update fixture notes");
    }
    await dashboard.daemon.settled();
    const errors = readEvidence("repo").filter((entry) => entry.kind === "tampered" && entry.detail === "record-error");
    if (moveHead) expect(errors.some((entry) => entry.next?.includes("rerun Warden against the current HEAD"))).toBe(true);
    else {
      expect(errors).toEqual([]);
      expect([...dashboard.daemon.projects.get(root)!.open.values()].map((alert) => alert.detail)).toEqual(["hook-unwired"]);
    }
  } finally {
    await dashboard?.close();
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 10_000);
