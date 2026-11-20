import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { type ReviewFinding } from "../../src/review/findings.js";
import { recordEscape, recordReviewerError, recordRound } from "../../src/review/history.js";
import { type DisputeDecision, fileDispute, ruleDispute } from "../../src/runner/disputes.js";
import { appendEvidence, wardenHome } from "../../src/runner/evidence.js";

const wardenRoot = resolve(import.meta.dirname, "../..");
const project = "fixture";
const guardrail = "warden-no-comments";
const practice = "no-comments";
const pack = "core";
const file = "src/example.ts";

it("reports retained corrections, upheld disputes and confirmed escapes within their original scope", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "warden-scorecard-")));
  const root = join(dir, "project");
  const other = join(dir, "other");
  const report = (cwd: string, ...flags: string[]) => spawnSync(
    process.execPath, [join(wardenRoot, "bin/warden.js"), "report", "--learning", ...flags], { cwd, encoding: "utf8" },
  );
  const scope = (checkout: string) => ({ project, root: checkout, file, pack, guardrail });
  const ruling: DisputeDecision = {
    status: "upheld", role: "independent-reviewer", actor: "Review fixture", reason: "Use the example",
    evidence: "requirements.md",
  };
  const note = (n: number): ReviewFinding => ({
    n, severity: "minor", title: "Missing required behavior", file, line: 1, reproducesOn: ["head"], spec: true,
    flaky: false, correction: "Return the expected result", kind: "spec-unmet", action: "back-to-builder", blocks: true,
  });
  try {
    for (const checkout of [root, other]) {
      await mkdir(checkout);
      await cp(join(wardenRoot, "test/fixtures/project-valid"), checkout, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: checkout });
    }
    const at = new Date().toISOString();
    const resolution = { ...scope(root), at, kind: "resolved", tier: "edit", status: "pass", sourceRun: "prior-run" } as const;
    appendEvidence(project, resolution);
    appendEvidence(project, resolution);
    appendEvidence(project, { ...resolution, root: other });
    const decide = (checkout: string, status: DisputeDecision["status"]) => {
      const dispute = fileDispute(scope(checkout), "Clarify the required behavior", ["Use a better name"]);
      ruleDispute(project, checkout, dispute, { ...ruling, status });
      return join(wardenHome(), "disputes", `${dispute}.json`);
    };
    const localRuling = decide(root, "upheld");
    decide(root, "rejected");
    const foreignRuling = decide(other, "upheld");
    for (const checkout of [root, other]) {
      const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: checkout, encoding: "utf8" }).trimEnd();
      const { round } = recordRound({
        input: {
          repository: await realpath(common), series: "implementation", target: "Example", capability: "review",
          previous: null, base: "base", head: "head", warden: "fixture", settings: { adapter: "superpowers-review", model: "opus" },
          upholds: [], requirements: [], report: { sha256: "fixture", text: "Review report" },
        },
        result: { verdict: "fail", findings: [note(1), note(2), note(3)] },
      }, undefined);
      const { actor, role, reason, evidence } = ruling;
      const decision = { actor, role, reason, evidence };
      recordEscape(round, { ...decision, finding: 1, practice });
      recordEscape(round, { ...decision, finding: 2, practice });
      recordReviewerError(round, { ...decision, finding: 2 });
    }

    const result = report(root, "--format", "json");
    expect(result.status, result.stderr).toBe(0);
    const scorecard = JSON.parse(result.stdout) as Array<{ guardrail: string; precision: number | null }>;
    expect(scorecard.find((row) => row.guardrail === guardrail)).toMatchObject({
      pack, practice, resolved: 1, upheldDisputes: 1, precision: 0.5, confirmedPracticeEscapes: 1,
    });
    expect(scorecard).toContainEqual(expect.objectContaining({ guardrail: "warden-no-suppressions", precision: null }));
    const text = report(root);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain("resolved=1  upheld=1  precision=50%  confirmed no-comments escapes=1");

    await writeFile(foreignRuling, "{");
    const isolated = report(root, "--json");
    expect(isolated.status, isolated.stderr).toBe(0);
    expect(isolated.stdout).toBe(result.stdout);
    await writeFile(localRuling, "{");
    const damaged = report(root, "--json");
    expect(damaged.status).toBe(2);
    expect(damaged.stderr).toContain(`Invalid dispute record at ${localRuling}`);
    expect(damaged.stderr).toContain("restore the record from backup");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
