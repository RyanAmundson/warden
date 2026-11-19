import { describe, expect, it } from "vitest";
import type { ReviewScope } from "../../src/review/adapter.js";
import { componentQualityReview } from "../../src/review/component-quality.js";
import { auditFacets, auditGroups } from "../fixtures/review/component-quality/audit.js";
import { reviewConformance } from "./conformance.js";

const head = "1".repeat(40);
const scope: ReviewScope = {
  base: "2".repeat(40),
  head,
  requirements: ["docs/ui.md"],
  upholds: [{ id: "visible-focus", statement: "Keyboard focus is visible." }],
  component: { name: "AuditTable", root: "/checkout/ui" },
  resolveCommit: (short) => short === head.slice(0, 9) ? head : "3".repeat(40),
};
const rule = { adapter: "component-quality", model: "opus" };
const reportPath = ".reports/component-quality-AuditTable-latest.md";
const report = {
  schemaVersion: 1,
  component: "AuditTable",
  componentPath: "src/AuditTable.tsx",
  commit: head.slice(0, 9),
  score: 50,
  class: "atom",
  confidence: { applicable: auditFacets.length, unknown: 0 },
  groups: auditGroups,
  facets: auditFacets,
  reportPath,
  findingCounts: { Critical: 0, High: 1, Medium: 0, Low: 1 },
  unverifiedFindings: 0,
  findings: [
    { severity: "High", title: "The selected row has no visible focus ring", file: "src/AuditTable.css", line: "12-14", unverified: false },
    { severity: "Low", title: "The empty state wraps an action label", unverified: false },
  ],
};

describe("Component Quality review adapter", () => {
  it("calls the native Workflow and preserves reported findings and source ranges", () => {
    const common = { spec: false, flaky: false, reproducesOn: ["head" as const], evidence: [reportPath], correction: `Apply the recommendation for this finding in ${reportPath}.` };
    reviewConformance(componentQualityReview, rule, scope, JSON.stringify(report), {
      verdict: "fail", reviewedHead: head, findings: [
        { ...common, n: 1, severity: "important", title: report.findings[0]!.title, file: "src/AuditTable.css", line: 12, endLine: 14 },
        { ...common, n: 2, severity: "minor", title: report.findings[1]!.title, file: "src/AuditTable.tsx" },
      ],
    });
    const invocation = componentQualityReview.invocation(rule, scope);
    expect(invocation).toMatchObject({
      tool: "Workflow",
      input: { scriptPath: expect.stringMatching(/\/component-quality\/component-quality\.js$/) },
    });
  });

  it.each([
    { commit: "777777777" },
    { component: "DifferentTable" },
    { score: null },
    { groups: undefined, facets: undefined },
    { groups: [auditGroups[0]], facets: auditFacets.slice(0, 5), confidence: { applicable: 5, unknown: 0 } },
    { facets: report.facets.map((facet) => ({ ...facet, status: "unknown", score: null })) },
    { facets: [{ id: "A1", group: "Other", status: "applicable", score: 50 }] },
    { findings: [] },
    { unverifiedFindings: 1 },
    { findings: [{ ...report.findings[0], line: "14-12" }, report.findings[1]] },
  ])("rejects stale, incomplete, or invalid evidence %j", (changes) => {
    const result = componentQualityReview.normalize(JSON.stringify({ ...report, ...changes }), scope);
    expect(result.findings).toEqual([expect.objectContaining({ severity: "environment" })]);
  });

  it.each(["35-42, 122", "acceptanceCriteria[1] / behaviors b-status-bar-counts"])(
    "keeps the native location %s while triaging at file scope", (line) => {
      const result = componentQualityReview.normalize(JSON.stringify({
        ...report, findings: [{ ...report.findings[0], line }, report.findings[1]],
      }), scope);
      expect(result.findings[0]).toMatchObject({ file: "src/AuditTable.css", correction: expect.stringContaining(line) });
      expect(result.findings[0]?.line).toBeUndefined();
    },
  );

  it("accepts a completed audit without findings", () => {
    const clean = { ...report, findingCounts: { Critical: 0, High: 0, Medium: 0, Low: 0 }, findings: [] };
    expect(componentQualityReview.normalize(JSON.stringify(clean), scope)).toEqual({ verdict: "pass", reviewedHead: head, findings: [] });
  });

  it("preserves findings with unmeasured facets, and refuses a clean verdict for the same coverage", () => {
    const partial = {
      ...report,
      confidence: { applicable: report.facets.length - 1, unknown: 1 },
      groups: [{ id: "A", scored: 4, notApplicable: 0, unknown: 1 }, ...report.groups.slice(1)],
      facets: [{ id: "A1", group: "A", status: "unknown", score: null }, ...report.facets.slice(1)],
    };
    const normalized = componentQualityReview.normalize(JSON.stringify(partial), scope);
    expect(normalized.findings.map(({ severity }) => severity)).toEqual(["important", "minor", "environment"]);
    const clean = { ...partial, findings: [], findingCounts: { Critical: 0, High: 0, Medium: 0, Low: 0 } };
    expect(componentQualityReview.normalize(JSON.stringify(clean), scope).findings[0]?.severity).toBe("environment");
  });

  it("routes a repeated finding back to the builder after line changes", () => {
    const result = componentQualityReview.normalize(JSON.stringify(report), {
      ...scope,
      previousHead: "4".repeat(40),
      previous: [{ n: 8, title: report.findings[0]!.title, file: "src/AuditTable.css", line: 11 }],
    });
    expect(result.findings[0]).toMatchObject({ earlier: 8, reproducesOn: ["head", "previous"] });
  });

  it("reports a component with zero app call sites as a finding", () => {
    const result = componentQualityReview.normalize(JSON.stringify({
      ...report, verdict: "NOT-IN-APP", appCallSites: 0, score: null,
      recommendation: "Move the story to the showcase project.",
    }), scope);
    expect(result.findings).toEqual([expect.objectContaining({ file: "src/AuditTable.tsx", correction: "Move the story to the showcase project." })]);
  });
});
