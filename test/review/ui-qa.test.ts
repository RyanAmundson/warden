import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { type ReviewScope, reviewAdapters } from "../../src/review/adapter.js";
import { triage } from "../../src/review/findings.js";
import { uiQaReview } from "../../src/review/ui-qa.js";
import { reviewConformance } from "./conformance.js";

const head = "1111111111111111111111111111111111111111";
const scope: ReviewScope = {
  base: "2222222222222222222222222222222222222222",
  head,
  requirements: ["docs/runs-design.md"],
  upholds: [{ id: "review-gate-first", statement: "Run the gate before UI QA." }],
};
const rule = { adapter: "ui-qa", model: "opus" };
const report = readFileSync(new URL("../fixtures/review/ui-qa/report.txt", import.meta.url), "utf8");
const clean = report.replace("FAIL | shots/runs-narrow.png | web/app.css:44 | Give the file path more width at 390 px.", "PASS | shots/runs-narrow.png | web/app.css:44 | -");

it("normalizes a complete gate and blocks a failed checklist item outside the diff", () => {
  expect(reviewAdapters.get(rule.adapter)).toBe(uiQaReview);
  reviewConformance(uiQaReview, rule, scope, report, {
    verdict: "fail",
    reviewedHead: head,
    findings: [{
      n: 1, severity: "important", title: "Runs · Overflow and clipping", file: "web/app.css", line: 44,
      reproducesOn: ["head"], spec: true, flaky: false, correction: "Give the file path more width at 390 px.",
      evidence: ["shots/runs-narrow.png"],
    }],
  });
  expect(triage(uiQaReview.normalize(report, scope).findings, {}, 1, "rerun").verdict).toBe("fail");
  expect(uiQaReview.normalize(`${clean}\nChecked the Runs page at 390, 1280, and 1920 px.\n`, scope)).toEqual({ verdict: "pass", reviewedHead: head, findings: [] });
});

it("preserves distinct failures for the same check on different screens", () => {
  const standalone = report.split("\n").slice(3).join("\n")
    .replaceAll("| Runs |", "| Run detail |")
    .replaceAll("runs-narrow", "run-narrow")
    .replace("web/app.css:44", "web/app.css:51");
  const both = uiQaReview.normalize(report + standalone, scope);
  expect(both.findings).toMatchObject([
    { n: 1, title: "Runs · Overflow and clipping", line: 44, evidence: ["shots/runs-narrow.png"] },
    { n: 2, title: "Run detail · Overflow and clipping", line: 51, evidence: ["shots/run-narrow.png"] },
  ]);
  expect(triage(both.findings, {}, 2, "rerun").findings.map((finding) => finding.blocks)).toEqual([true, true]);
  const incomplete = uiQaReview.normalize(report + standalone.replace(/^\| Run detail \| Data shown.*\n/m, ""), scope);
  expect(incomplete.findings).toEqual([expect.objectContaining({ severity: "environment", title: expect.stringContaining("Run detail · Data shown") })]);
});

it("requires a fresh full gate in later rounds", () => {
  const previousHead = "3333333333333333333333333333333333333333";
  const previous = uiQaReview.normalize(report, scope).findings;
  const { prompt } = uiQaReview.invocation(rule, { ...scope, previousHead, previous }).input;
  expect(prompt).toContain("Use the ui-qa skill");
  expect(prompt).toContain("Check the full matrix on every round");
  expect(prompt).toContain(`Review the whole change ${scope.base}..${head}`);
  expect(prompt).not.toContain("Review only");
  expect(prompt).toContain(previous[0]?.title);
});

it("reports incomplete, malformed, stale, and unavailable checks as operational", () => {
  for (const input of [
    clean.replace(head, scope.base),
    clean.replace(/^\| Runs \| Data shown.*\n/m, ""),
    clean.replace("Backgrounds and surfaces", "Alignment and fill"),
    clean.replace("shots/runs-focus.png", "-"),
    clean.replace("web/app.css:7", "../elsewhere.css:7"),
    report.replace("Give the file path more width at 390 px.", "-"),
    `Reviewed head: ${head}\nEnvironment: Unable to start the fixture daemon.`,
  ]) {
    const parsed = uiQaReview.normalize(input, scope);
    expect(parsed.findings).toEqual([expect.objectContaining({ severity: "environment" })]);
    expect(triage(parsed.findings, {}, 1, "rerun").verdict).toBe("operational");
  }
});
