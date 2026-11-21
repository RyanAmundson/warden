import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { changesSinceMergeBase, fetchedTips, newCommits, reachable } from "../../src/runner/changed.js";

it("keeps history checks accurate when tips stay put, advance, or disappear", async () => {
  const root = mkdtempSync(join(tmpdir(), "warden-history-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-qb", "main");
    git("commit", "--allow-empty", "-qm", "Start fixture");
    const start = git("rev-parse", "HEAD");
    git("commit", "--allow-empty", "-qm", "Advance main");
    const tip = git("rev-parse", "HEAD");
    const tree = git("rev-parse", "HEAD^{tree}");
    const missing = "1000000000000000000000000000000000000000";

    expect(await newCommits(root, [tip], [tip, start])).toEqual([]);
    expect((await newCommits(root, [tip], [start, missing])).map((entry) => entry.commit)).toEqual([tip]);
    expect(await reachable(root, start, [missing, tree, tip])).toBe(true);
    expect(await reachable(root, tip, [start, missing, tree])).toBe(false);
    expect(await reachable(root, missing, [tip])).toBe(false);

    git("remote", "add", "origin", ".");
    for (const [branch, commit] of [["fetched", start], ["local-update", tip]] as const) {
      const ref = `refs/remotes/origin/${branch}`;
      const subject = branch === "fetched" ? "fetch origin" : "local update";
      git("update-ref", "--create-reflog", "-m", `${subject}: ${"record ".repeat(105)}`, ref, commit);
      const log = join(root, ".git", "logs", ref);
      writeFileSync(log, readFileSync(log, "utf8").repeat(850));
    }
    expect(await fetchedTips(root)).toEqual([start]);
    expect((await newCommits(root, [tip], [])).map((entry) => entry.commit)).toEqual([tip]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("reads every changed path and line in a 5,000-file commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "warden-large-commit-"));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, stdio: "pipe" });
  };
  try {
    git("init", "-q", "-b", "main");
    git("config", "maintenance.auto", "false");
    git("commit", "--allow-empty", "-qm", "Start fixture");
    const data = (text: string): string => `data ${Buffer.byteLength(text)}\n${text}\n`;
    const text = `Row: ${"value ".repeat(42)}\n`;
    const changes = [
      "blob\nmark :1\n",
      data(text),
      "blob\nmark :2\n",
      data("A pasted diff illustrates the hunk syntax.\r@@ -20 +20 @@\n"),
      "commit refs/heads/bulk-change\ncommitter Test <test@example.invalid> 0 +0000\n",
      data("Add generated fixture data"),
      "from refs/heads/main\nM 100644 :2 file-0.txt\n",
      ...Array.from({ length: 4999 }, (_, index) => `M 100644 :1 file-${index + 1}.txt\n`),
      "\ndone\n",
    ].join("");
    execFileSync("git", ["fast-import", "--quiet"], { cwd: root, input: changes, stdio: ["pipe", "ignore", "pipe"] });
    git("switch", "-q", "bulk-change");

    const { lines } = await changesSinceMergeBase(root, "main");
    expect(lines.size).toBe(5000);
    expect(lines.get("file-0.txt")).toEqual(new Set([1]));
    expect(lines.get("file-4999.txt")).toEqual(new Set([1]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
