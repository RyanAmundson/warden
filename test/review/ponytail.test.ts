import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { ReviewScope } from "../../src/review/adapter.js";
import { classify, type RawFinding } from "../../src/review/findings.js";
import { ponytailReview } from "../../src/review/ponytail.js";
import { reviewConformance } from "./conformance.js";

const head = "1111111111111111111111111111111111111111";
const scope: ReviewScope = {
  base: "2222222222222222222222222222222222222222",
  head,
  requirements: ["docs/plan.md"],
  upholds: [{ id: "reuse-existing", statement: "Use existing functions." }],
};
const report = readFileSync(new URL("../fixtures/review/ponytail/report-fail.txt", import.meta.url), "utf8");

it("uses Ponytail scope and normalizes its native finding lines with a reviewed-head header", () => {
  const rule = { adapter: "ponytail-review", model: "opus" };
  expect(ponytailReview.invocation(rule, scope).input.prompt).toContain("Use the ponytail:ponytail-review skill");
  const first: RawFinding = {
    n: 1, severity: "minor", title: "stdlib: Manual loop builds an array", file: "src/list.ts",
    line: 12, endLine: 16, reproducesOn: ["head"], spec: false, flaky: false,
    correction: "Use Array.from with its mapping function.",
  };
  reviewConformance(ponytailReview, rule, scope, report, {
    verdict: "fail",
    reviewedHead: head,
    findings: [
      first,
      {
        n: 2, severity: "minor", title: "delete: Unused helper", file: "src/list.ts", line: 25,
        reproducesOn: ["head"], spec: false, flaky: false, correction: "Remove the helper and its export.",
      },
    ],
  });
  const parsed = ponytailReview.normalize(report, scope).findings[0]!;
  expect(classify(parsed, { "src/list.ts": [[15, 15]] }, 1)).toMatchObject({ kind: "touched", blocks: true });
});

it("accepts an explicit clean result and reports failed normalization as operational", () => {
  expect(ponytailReview.normalize(`Reviewed head: ${head}\nLean already. Ship.\n`, scope)).toEqual({ verdict: "pass", reviewedHead: head, findings: [] });
  for (const malformed of [
    report.replace(head, scope.base),
    report.replace("net: -8 lines possible.", ""),
    report.replace("L12-16", "L16-12"),
    report.replace("src/list.ts:L12", "../src/list.ts:L12"),
  ]) {
    expect(ponytailReview.normalize(malformed, scope).findings).toEqual([expect.objectContaining({ severity: "environment" })]);
  }
});

it("preserves earlier finding identity for a follow-up round", () => {
  const first = ponytailReview.normalize(report, scope).findings[0]!;
  const followup = { ...scope, previousHead: "3333333333333333333333333333333333333333", previous: [classify(first, { "src/list.ts": [[12, 16]] }, 1)] };
  const unchanged = report.replace("mapping function.", "mapping function. [earlier 1]");
  expect(ponytailReview.normalize(unchanged, followup).findings[0]).toMatchObject({ earlier: 1, reproducesOn: ["head", "previous"] });
  for (const invalid of ["[earlier 6]", "[earlier 0]", "[earlier -1]", "[earlier x]", "[earlier 1", "[earlier 9007199254740993]"]) {
    expect(ponytailReview.normalize(unchanged.replace("[earlier 1]", invalid), followup).findings[0]?.severity).toBe("environment");
  }
});
