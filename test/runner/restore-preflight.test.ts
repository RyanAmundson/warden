import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { RecordSet } from "../../src/records/types.js";
import { formatFeedback } from "../../src/runner/feedback.js";

it("checks for unrelated tracked edits before a Warden recovery commits the index", () => {
  const root = mkdtempSync(join(tmpdir(), "warden-restore-preflight-"));
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args,
  ], { cwd: root, encoding: "utf8" });
  const put = (file: string, content: string) => writeFileSync(join(root, file), content);
  const restored = ".warden/example.yaml";
  const unrelated = "notes.txt";
  try {
    git("init", "-q", "-b", "main");
    mkdirSync(join(root, ".warden"));
    put(restored, "name: before\n");
    put(unrelated, "Original notes.\n");
    git("add", "-f", ".");
    git("commit", "-qm", "Add sample files");
    const base = git("rev-parse", "HEAD").trim();
    const set: RecordSet = {
      root, packs: [], config: { project: "fixture", base: "main", packs: [], tierBudgetMs: { edit: 1, commit: 1, boundary: 1 }, loopBreakerRepeats: 3 },
    };
    const nextAction = (aliased: boolean) => {
      const restore = { base, paths: [restored], known: [restored], stray: [], unstage: [], aliased };
      const json = formatFeedback([], set, "json", { tampered: [{ file: restored, detail: "unsigned", restore }] });
      return (JSON.parse(json) as { next: string }).next;
    };
    const next = nextAction(true);
    const end = next.indexOf(" && git --literal-pathspecs restore");
    expect(end).toBeGreaterThan(0);
    const preflight = next.slice("run ".length, end);
    const run = () => spawnSync("sh", ["-c", preflight], { cwd: root, encoding: "utf8" });
    expect(nextAction(false)).toContain("commit --only");
    expect(nextAction(false)).not.toContain("git diff --quiet");

    put(restored, "name: after\n");
    git("add", "-f", restored);
    expect(run()).toMatchObject({ status: 0, stderr: "" });

    put(unrelated, "Updated notes.\n");
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("Move unrelated staged and unstaged changes aside") });
    expect(git("diff", "--name-only")).toBe(`${unrelated}\n`);
    git("add", unrelated);
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("Move unrelated staged and unstaged changes aside") });
    expect(git("diff", "--cached", "--name-only")).toContain(unrelated);
    expect(git("rev-parse", "HEAD").trim()).toBe(base);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
