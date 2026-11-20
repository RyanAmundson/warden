import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { changedFiles, changesSinceMergeBase, containsHead, mergeBase, showAtMergeBase } from "../../src/runner/changed.js";

it.each(["origin", "upstream"])("judges an unpublished local main commit against %s", async (remoteName) => {
  const dir = mkdtempSync(join(tmpdir(), "warden-base-comparison-"));
  const remote = join(dir, "remote");
  const checkout = join(dir, "checkout");
  const git = (cwd: string, ...args: string[]): string => execFileSync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args,
  ], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git(dir, "init", "-q", "-b", "main", remote);
    writeFileSync(join(remote, "notes.txt"), "Published\n");
    git(remote, "add", "notes.txt");
    git(remote, "commit", "-qm", "Publish notes");
    git(dir, "clone", "-q", "--origin", remoteName, remote, checkout);

    writeFileSync(join(checkout, "notes.txt"), "Published\nDraft addition\n");
    git(checkout, "commit", "-qam", "Update notes locally");
    const head = git(checkout, "rev-parse", "HEAD");
    const published = git(checkout, "rev-parse", `${remoteName}/main`);

    expect(changedFiles(checkout, "main")).toEqual(["notes.txt"]);
    expect(changedFiles(checkout, "refs/heads/main")).toEqual(["notes.txt"]);
    expect(changedFiles(checkout, `refs/remotes/${remoteName}/main`)).toEqual(["notes.txt"]);
    expect(changedFiles(checkout, head)).toEqual([]);
    expect(changedFiles(checkout, "HEAD")).toEqual([]);
    expect(changedFiles(checkout, "@")).toEqual([]);

    expect(mergeBase(checkout, "main")).toBe(published);
    expect(containsHead(checkout, "main")).toBe(false);
    expect(showAtMergeBase(checkout, "main", "notes.txt")).toBe("Published\n");
    expect((await changesSinceMergeBase(checkout, "main")).lines.get("notes.txt")).toEqual(new Set([2]));

    git(checkout, "remote", "remove", remoteName);
    expect(changedFiles(checkout, "main")).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
