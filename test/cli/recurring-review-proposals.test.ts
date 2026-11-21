import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { sha256 } from "../../src/compiler/lock.js";
import { recordReviewerError, recordRound, reviewRepository } from "../../src/review/history.js";
import { fileDispute, ruleDispute } from "../../src/runner/disputes.js";

const cli = resolve(import.meta.dirname, "../../bin/warden.js");

it("proposes recurring normalized review findings with distinct heads and series and exact provenance", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "warden-recurring-review-")));
  const root = join(temp, "repo");
  const home = join(temp, "warden-home");
  const config = join(root, ".warden/config.yaml");
  const practice = { id: "explicit-units", statement: "Every report declares its unit." };
  const proposals = () => spawnSync(process.execPath, [cli, "review", "proposals"], { cwd: root, encoding: "utf8" });
  const setting = (minimum: number): Promise<void> => writeFile(config, `project: report-review-fixture
base: main
packs: [{ id: local, paths: [] }]
tierBudgetMs: { edit: 1000, commit: 2000, boundary: 3000 }
loopBreakerRepeats: 3
learning: { repeatFindings: ${minimum}, removalRuns: 2 }
`);
  vi.stubEnv("WARDEN_HOME", home);
  try {
    await mkdir(join(root, ".warden/packs/local"), { recursive: true });
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    await setting(2);
    await writeFile(join(root, ".warden/packs/local/pack.yaml"), `id: local
layer: 100
terms: []
practices:
  - id: ${practice.id}
    statement: ${practice.statement}
    terms: []
    paths: []
    conflictsWith: []
    guardrails:
      - id: units-check
        kind: lint
        runs: [boundary]
        budgetMs: 1000
        version: 1
        implementation: "eslint:warden/no-comments"
        mustPass: "export const unit = 1;"
        mustFail: "// unit"
`);
    const repository = reviewRepository(root);
    const saved = (series: string, revision: string, owner = repository, target = "report") => {
      const head = revision.repeat(40);
      const text = `Report for ${head}`;
      return recordRound({
        input: {
          repository: owner, series, target, capability: "review-report", previous: null, base: "a".repeat(40), head, warden: "0.1.14",
          settings: { adapter: "superpowers-review", model: "opus" }, upholds: [practice], requirements: [],
          report: { sha256: sha256(text), text },
        },
        result: {
          verdict: "fail", findings: [{
            n: 1, severity: "important", title: "Missing  unit", file: "report.ts", line: 2, reproducesOn: ["head"], spec: true,
            flaky: false, correction: "State the unit.", kind: "spec-unmet", action: "back-to-builder", blocks: true,
          }],
        },
      }, undefined).round;
    };
    const first = saved("one", "b");
    expect(saved("one", "b").id).toBe(first.id);
    const branch = saved("one", "d", repository, "other report");
    const copy = saved("copied-head", "b");
    saved("other-repository", "c", join(temp, "other.git"));
    const dismissed = saved("dismissed", "e");
    recordReviewerError(dismissed, { finding: 1, role: "repository-owner", actor: "Owner", reason: "Unit appears in the header.", evidence: "report.ts:1" });
    const before = proposals();
    expect(before.status, before.stderr).toBe(0);
    expect(JSON.parse(before.stdout)).toEqual([]);

    const second = saved("two", "f");
    const after = proposals();
    expect(after.status, after.stderr).toBe(0);
    const output = JSON.parse(after.stdout);
    expect(output).toMatchObject([{
      action: "add", practice: practice.id, evidence: [{
        kind: "recurring-review-finding", title: "Missing unit", correction: "State the unit.",
      }],
    }]);
    const cite = (round: typeof first) => ({
      series: round.input.series, head: round.input.head, round: round.id, finding: 1, report: round.input.report.sha256,
    });
    const occurrences = output[0].evidence[0].occurrences;
    expect(occurrences).toHaveLength(2);
    expect(occurrences).toContainEqual(expect.objectContaining(cite(second)));
    expect([first, branch, copy].map((round) => round.id)).toContain(occurrences.find((event: { round: string }) => event.round !== second.id).round);
    expect(proposals().stdout).toBe(after.stdout);

    const project = "report-review-fixture";
    const dispute = fileDispute({ project, root, pack: "local", guardrail: "units-check", file: "report.ts" },
      "The report header names the unit.", ["Check the header"]);
    ruleDispute(project, root, dispute, {
      status: "upheld", role: "independent-reviewer", actor: "Fixture reviewer",
      reason: "The report header already declares the unit.", evidence: "report.ts:1",
    });
    const expected = JSON.parse(proposals().stdout);
    expect(expected).toHaveLength(2);
    expect(expected[1]).toMatchObject({ action: "edit", guardrail: "units-check", evidence: [{ kind: "upheld-dispute", dispute }] });
    await writeFile(join(root, ".warden/lock.json"), "{\n");
    const invalidLock = proposals();
    expect(invalidLock.status, invalidLock.stderr).toBe(0);
    expect(invalidLock.stderr).toContain("Remove proposals are unavailable.");
    expect(JSON.parse(invalidLock.stdout)).toEqual(expected);

    await setting(3);
    expect(JSON.parse(proposals().stdout)).toEqual([expected[1]]);
  } finally {
    vi.unstubAllEnvs();
    await rm(temp, { recursive: true, force: true });
  }
});
