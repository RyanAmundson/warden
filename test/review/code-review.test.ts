import { expect, it } from "vitest";
import type { ReviewScope } from "../../src/review/adapter.js";
import { codeReview, isPullRequestUrl } from "../../src/review/code-review.js";
import { reviewConformance } from "./conformance.js";

const head = "1".repeat(40);
const base = "2".repeat(40);
const pullRequest = "https://github.com/example/project/pull/12";
const scope: ReviewScope = {
  base, head, pullRequest,
  committedChanges: () => ({ "src/counter.ts": [[4, 6]] }),
  requirements: ["docs/plan.md"], upholds: [{ id: "small", statement: "Keep the change small." }],
};
const issue = {
  title: "The counter drops the final item", file: "src/counter.ts", line: 4, endLine: 6,
  source: "The loop stops before the final item.", correction: "Include the final index in the loop bound.",
};
const summary = "1. The loop stops before the final item. See src/counter.ts.";
const envelope = { pullRequest, reviewedBase: base, reviewedHead: head, nativeSummary: summary, findings: [issue] };
const clean = "No issues found. Checked for bugs and CLAUDE.md compliance.";

it("invokes the native read-only PR skill and preserves the validated native finding", () => {
  const rule = { adapter: "code-review", model: "opus" };
  const prompt = codeReview.invocation(rule, scope).input.prompt;
  expect(prompt).toContain(`Run the code-review:code-review skill on ${pullRequest} without --comment.`);
  expect(prompt).toContain("Read the pull request metadata again");
  reviewConformance(codeReview, rule, scope, JSON.stringify(envelope), {
    verdict: "fail", reviewedHead: head, findings: [{
      n: 1, severity: "important", title: issue.title, file: issue.file, line: 4, endLine: 6,
      correction: issue.correction, evidence: [issue.source], reproducesOn: ["head"], spec: false, flaky: false,
    }],
  });
});

it("requires a verified scope and an explicit native clean result or fully located findings", () => {
  const run = (value: object) => codeReview.normalize(JSON.stringify(value), scope);
  expect(run({ ...envelope, nativeSummary: clean, findings: [] })).toEqual({ verdict: "pass", reviewedHead: head, findings: [] });
  for (const bad of [
    { ...envelope, reviewedHead: base },
    { ...envelope, reviewedBase: head },
    { ...envelope, pullRequest: pullRequest + "3" },
    { ...envelope, nativeSummary: "Skipped draft.", findings: [] },
    { ...envelope, nativeSummary: clean },
    { ...envelope, findings: [{ ...issue, file: "../counter.ts" }] },
    { ...envelope, findings: [{ ...issue, endLine: 3 }] },
    { ...envelope, findings: [{ ...issue, endLine: 7 }] },
    { ...envelope, findings: [{ ...issue, file: "src/missing.ts" }] },
    { ...envelope, findings: [{ ...issue, source: "Not in the native report." }] },
    { ...envelope, findings: [{ ...issue, earlier: 1 }] },
  ]) expect(run(bad).findings).toEqual([expect.objectContaining({ severity: "environment" })]);
  expect(run({ error: "Skipped draft." }).findings[0]?.title).toContain("Skipped draft.");
});

it("carries forward an identified finding in a later round", () => {
  const report = JSON.stringify({ ...envelope, findings: [{ ...issue, earlier: 1 }] });
  const previousHead = "3".repeat(40);
  expect(codeReview.normalize(report, { ...scope, previousHead, previous: [{ n: 1, title: issue.title }] }).findings[0])
    .toMatchObject({ reproducesOn: ["head", "previous"], earlier: 1 });
  expect(codeReview.normalize(report, { ...scope, previousHead, previous: [] }).findings[0]?.severity).toBe("environment");
});

it("accepts only canonical GitHub pull request paths", () => {
  expect(isPullRequestUrl(pullRequest)).toBe(true);
  for (const url of [undefined, "https://github.com/example/../pull/12", pullRequest + "?x=y", pullRequest + " --comment", pullRequest.replace("github.com", "example.org"), pullRequest.replace("pull", "issues")]) {
    expect(isPullRequestUrl(url)).toBe(false);
  }
});
