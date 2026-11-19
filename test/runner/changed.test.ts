import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { changesSinceMergeBase } from "../../src/runner/changed.js";

it("reads every changed path and line in a 5,000-file commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "warden-large-commit-"));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, stdio: "pipe" });
  };
  try {
    git("init", "-q", "-b", "main");
    git("config", "maintenance.auto", "false");
    git("commit", "--allow-empty", "-qm", "Start fixture");
    git("switch", "-qc", "bulk-change");
    for (let number = 0; number < 5000; number++) writeFileSync(join(root, `file-${number}.txt`), `Row ${number}: ${"value ".repeat(42)}\n`);
    writeFileSync(join(root, "file-0.txt"), "A pasted diff illustrates the hunk syntax.\r@@ -20 +20 @@\n");
    git("add", "-A");
    git("commit", "-qm", "Add generated fixture data");

    const { lines } = await changesSinceMergeBase(root, "main");
    expect(lines.size).toBe(5000);
    expect(lines.get("file-0.txt")).toEqual(new Set([1]));
    expect(lines.get("file-4999.txt")).toEqual(new Set([1]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
