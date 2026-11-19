import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classify, exitCode, touchedLines, triage, type RawFinding, type Touched } from "../../src/review/findings.js";

const raw = (over: Partial<RawFinding> = {}): RawFinding => ({
  n: 1,
  severity: "important",
  title: "t",
  file: "a.ts",
  line: 3,
  reproducesOn: ["head"],
  spec: false,
  flaky: false,
  correction: "c",
  ...over,
});
const touched: Touched = { "a.ts": [[2, 4]] };
const shape = (r: RawFinding, round = 1, t: Touched = touched) => {
  const { kind, action, blocks } = classify(r, t, round);
  return { kind, action, blocks };
};

describe("classify", () => {
  it("an environment finding is env and does not block", () => {
    expect(shape(raw({ severity: "environment", flaky: true, spec: true }))).toEqual({ kind: "env", action: "fix-environment", blocks: false });
  });
  it("a flaky finding is flake and does not block", () => {
    expect(shape(raw({ flaky: true, earlier: 1, spec: true }))).toEqual({ kind: "flake", action: "rerun-alone", blocks: false });
  });
  it("a finding raised in an earlier round is unfixed and blocks", () => {
    expect(shape(raw({ earlier: 2, spec: true }))).toEqual({ kind: "unfixed", action: "back-to-builder", blocks: true });
  });
  it("a spec finding is spec-unmet and blocks", () => {
    expect(shape(raw({ spec: true, reproducesOn: ["base"] }))).toEqual({ kind: "spec-unmet", action: "back-to-builder", blocks: true });
  });
  it("a finding that reproduces on base is pre-existing and files a task", () => {
    expect(shape(raw({ reproducesOn: ["head", "base"] }))).toEqual({ kind: "pre-existing", action: "file-task", blocks: false });
  });
  it("a new finding on a touched line after round 1 is a regression and blocks", () => {
    expect(shape(raw(), 2)).toEqual({ kind: "regression", action: "back-to-builder", blocks: true });
  });
  it("a finding on a touched line that also reproduces on previous is touched", () => {
    expect(shape(raw({ reproducesOn: ["head", "previous"] }), 2)).toEqual({ kind: "touched", action: "back-to-builder", blocks: true });
  });
  it("a finding on a touched line in round 1 is touched and blocks", () => {
    expect(shape(raw())).toEqual({ kind: "touched", action: "back-to-builder", blocks: true });
  });
  it("a finding with no location blocks as touched", () => {
    expect(shape(raw({ file: undefined, line: undefined }))).toEqual({ kind: "touched", action: "back-to-builder", blocks: true });
  });
  it("a finding outside the touched lines is untouched and files a task", () => {
    expect(shape(raw({ line: 40 }))).toEqual({ kind: "untouched", action: "file-task", blocks: false });
    expect(shape(raw({ file: "z.ts" }))).toEqual({ kind: "untouched", action: "file-task", blocks: false });
  });
  it("a critical untouched finding blocks", () => {
    expect(shape(raw({ line: 40, severity: "critical" }))).toEqual({ kind: "untouched", action: "file-task", blocks: true });
  });
});

describe("touchedLines", () => {
  it("touchedLines reads new-side ranges, including untracked files", () => {
    const root = mkdtempSync(join(tmpdir(), "warden-findings-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: join(root, "no-config") } });
    git("init", "-q");
    git("config", "user.email", "a@b.c");
    git("config", "user.name", "a");
    writeFileSync(join(root, "a.ts"), "1\n2\n3\n4\n5\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(root, "a.ts"), "1\n2\nX\n4\n5\n");
    git("commit", "-q", "-am", "change");
    writeFileSync(join(root, "b.ts"), "x\ny\n");
    expect(touchedLines(root, "HEAD~1", "HEAD")).toEqual({ "a.ts": [[3, 3]], "b.ts": [[1, 2]] });
  });
  it("touchedLines fails with a next action when a ref is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "warden-findings-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    expect(() => touchedLines(root, "nope", "HEAD")).toThrow("run git rev-parse --verify nope to find the missing ref, then run the review again");
  });
});

describe("triage", () => {
  const rerun = "warden review --base main";
  const env = raw({ n: 1, severity: "environment" });
  const flake = raw({ n: 2, flaky: true });
  const block = raw({ n: 3 });
  const block2 = raw({ n: 4, spec: true });
  const filed = raw({ n: 5, line: 40 });
  it("exitCode and next follow env, flake, block, file-task order", () => {
    const a = triage([filed, block, flake, env], touched, 1, rerun);
    expect([exitCode(a), a.verdict]).toEqual([2, "operational"]);
    expect(a.next).toBe(`fix the environment named in finding 1, then ${rerun}.`);
    const b = triage([filed, block, flake], touched, 1, rerun);
    expect([exitCode(b), b.verdict]).toEqual([2, "operational"]);
    expect(b.next).toBe(`rerun the test named in finding 2 alone; if it fails again, file a slow-test task, then ${rerun}.`);
    const c = triage([filed, block, block2], touched, 1, rerun);
    expect([exitCode(c), c.verdict]).toEqual([1, "fail"]);
    expect(c.next).toBe(`send findings 3, 4 back to the builder, then ${rerun} on the new head.`);
    const d = triage([filed, raw({ n: 6, line: 50 })], touched, 1, rerun);
    expect([exitCode(d), d.verdict]).toEqual([0, "pass"]);
    expect(d.next).toBe("file one task for each of findings 5, 6.");
    const e = triage([], touched, 1, rerun);
    expect([exitCode(e), e.next]).toEqual([0, null]);
  });
});
