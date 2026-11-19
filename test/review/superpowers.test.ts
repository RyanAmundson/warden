import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Normalized, ReviewScope } from "../../src/review/adapter.js";
import type { RawFinding, ReviewFinding } from "../../src/review/findings.js";
import { REPORT_SHAPE, superpowersReview } from "../../src/review/superpowers.js";
import { reviewConformance } from "./conformance.js";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/review/superpowers/${name}`, import.meta.url), "utf8");
const HEAD = "1111111111111111111111111111111111111111";
const BASE = "2222222222222222222222222222222222222222";
const PREV = "3333333333333333333333333333333333333333";
const rule = { adapter: "superpowers-review", model: "opus" };
const scope: ReviewScope = {
  base: BASE,
  head: HEAD,
  requirements: ["docs/plan.md", "docs/brief.md"],
  upholds: [{ id: "errors-explicit", statement: "Raise errors explicitly." }],
};

const finding = (over: Partial<RawFinding>): RawFinding => ({
  n: 1,
  severity: "important",
  title: "t",
  reproducesOn: ["head"],
  spec: false,
  flaky: false,
  correction: "c",
  ...over,
});

const LABELS = REPORT_SHAPE.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2, l.indexOf(": ")));

const fill = (f: RawFinding): string => {
  expect(LABELS).toHaveLength(6);
  const values = [
    f.file === undefined ? undefined : `${f.file}:${f.line}`,
    f.reproducesOn.join(", "),
    f.spec ? "yes" : "no",
    f.earlier === undefined ? undefined : String(f.earlier),
    f.flaky ? "yes" : "no",
    f.correction,
  ];
  return [
    `### ${f.severity[0]!.toUpperCase()}${f.severity.slice(1)} ${f.n}. ${f.title}`,
    ...LABELS.flatMap((label, i) => (values[i] === undefined ? [] : [`- ${label}: ${values[i]}`])),
  ].join("\n");
};

const fromShape = (verdict: string, head: string, findings: RawFinding[]): string => {
  const [top, , ...rest] = REPORT_SHAPE.split("\n");
  const shape = [top!.replace("PASS | FAIL", verdict), `Reviewed head: ${head}`];
  expect(rest[0]).toBe("");
  expect(rest[1]!.startsWith("### <Critical|Important|Minor|Environment> <n>. <title>")).toBe(true);
  return [...shape, "", ...findings.map(fill)].join("\n\n");
};

describe("superpowers-review adapter", () => {
  it("superpowers-review passes the conformance harness", () => {
    reviewConformance(superpowersReview, rule, scope, fixture("report-fail.md"), JSON.parse(fixture("expected-fail.json")) as Normalized);
  });

  it("compiles the rule to the full Agent invocation", () => {
    const call = superpowersReview.invocation(rule, scope);
    expect(superpowersReview.id).toBe("superpowers-review");
    expect(call).toEqual({
      tool: "Agent",
      input: {
        description: "Independent review of 111111111111",
        subagent_type: "general-purpose",
        model: "opus",
        prompt: [
          "You are an independent reviewer. Do not edit any file, commit, or push; report findings only.",
          `Head: ${HEAD}\nBase: ${BASE}`,
          `This is round 1. Review the whole change ${BASE}..${HEAD}.`,
          "Requirements:\n- docs/plan.md\n- docs/brief.md",
          "Upheld Practices:\n- errors-explicit: Raise errors explicitly.",
          `Report in exactly this shape:\n\n${REPORT_SHAPE}`,
        ].join("\n\n"),
      },
    });
  });

  it("a report filled from REPORT_SHAPE normalizes to what was filled", () => {
    const filled = [
      finding({ n: 1, severity: "critical", title: "Data loss on retry", file: "src/a.ts", line: 9, reproducesOn: ["head", "previous"], spec: true, flaky: true, correction: "no write is lost" }),
      finding({ n: 2, severity: "minor", title: "Unclear name", file: "src/b.ts", line: 1, earlier: 4, correction: "rename it" }),
    ];
    expect(superpowersReview.normalize(fromShape("PASS", HEAD, filled), scope)).toEqual({ verdict: "pass", reviewedHead: HEAD, findings: filled });
  });

  it("CRLF and surrounding prose parse the same", () => {
    const report = fixture("report-fail.md");
    const crlf = `Preamble line.\r\n${report.replaceAll("\n", "\r\n")}\r\nTrailing words.\r\n`;
    expect(superpowersReview.normalize(crlf, scope)).toEqual(superpowersReview.normalize(report, scope));
  });

  it("a report for another head is one environment finding", () => {
    const other = "9999999999999999999999999999999999999999";
    const report = fixture("report-fail.md").replace(`Reviewed head: ${HEAD}`, `Reviewed head: ${other}`);
    expect(superpowersReview.normalize(report, scope)).toEqual({
      verdict: "fail",
      reviewedHead: other,
      findings: [
        {
          n: 1,
          severity: "environment",
          title: `The report reviewed ${other}, not ${HEAD}`,
          reproducesOn: [],
          spec: false,
          flaky: false,
          correction: `the reviewer reviews ${HEAD} and reports Reviewed head: ${HEAD}.`,
        },
      ],
    });
    expect(superpowersReview.normalize(fixture("report-fail.md"), scope).findings.map((f) => f.title)).not.toContain(`The report reviewed ${other}, not ${HEAD}`);
  });

  it("a report with no verdict is one environment finding", () => {
    const report = fixture("report-fail.md").replace("Verdict: FAIL\n", "");
    expect(superpowersReview.normalize(report, scope)).toEqual({
      verdict: "fail",
      reviewedHead: HEAD,
      findings: [
        {
          n: 1,
          severity: "environment",
          title: "The report has no Verdict line",
          reproducesOn: [],
          spec: false,
          flaky: false,
          correction: "the report starts with Verdict: PASS or Verdict: FAIL, as REPORT_SHAPE gives it.",
        },
      ],
    });
    expect(superpowersReview.normalize(`Verdict: FAIL\n${report}`, scope)).toEqual(JSON.parse(fixture("expected-fail.json")));
    expect(superpowersReview.normalize("", scope).reviewedHead).toBe("");
  });

  it("a FAIL report whose findings do not parse is one environment finding", () => {
    const report = `Verdict: FAIL\nReviewed head: ${HEAD}\n### Important 1 - bad heading\n- Where: a.ts:1`;
    expect(superpowersReview.normalize(report, scope)).toEqual({
      verdict: "fail",
      reviewedHead: HEAD,
      findings: [
        {
          n: 1,
          severity: "environment",
          title: "The report says FAIL but no finding could be read",
          reproducesOn: [],
          spec: false,
          flaky: false,
          correction: "each finding starts with a line of the form ### <Critical|Important|Minor|Environment> <n>. <title>, as REPORT_SHAPE gives it.",
        },
      ],
    });
    const fixed = report.replace("### Important 1 - bad heading", "### Important 1. bad heading");
    expect(superpowersReview.normalize(`${fixed}\n- Correction condition: c`, scope).findings).toEqual([finding({ title: "bad heading", file: "a.ts", line: 1, reproducesOn: [], correction: "c" })]);
  });

  it("a report with no Reviewed head line is one environment finding", () => {
    expect(superpowersReview.normalize("Verdict: PASS\n", scope)).toEqual({
      verdict: "fail",
      reviewedHead: "",
      findings: [
        {
          n: 1,
          severity: "environment",
          title: "The report has no Reviewed head line",
          reproducesOn: [],
          spec: false,
          flaky: false,
          correction: `the report gives Reviewed head: ${HEAD} after its Verdict line.`,
        },
      ],
    });
    expect(superpowersReview.normalize(`Verdict: PASS\nReviewed head: ${HEAD}\n`, scope)).toEqual({ verdict: "pass", reviewedHead: HEAD, findings: [] });
  });

  it.each([
    ["Earlier", "one"],
    ["Spec", "maybe"],
    ["Flaky", "sometimes"],
    ["Reproduces on", "head, staging"],
  ])("a finding whose %s is %s is one environment finding", (label, value) => {
    const good = fromShape("FAIL", HEAD, [finding({ earlier: 2 })]);
    const bad = good.replace(new RegExp(`- ${label}: .*`), `- ${label}: ${value}`);
    expect(superpowersReview.normalize(bad, scope)).toEqual({
      verdict: "fail",
      reviewedHead: HEAD,
      findings: [
        {
          n: 1,
          severity: "environment",
          title: `Finding 1 has an unreadable ${label}: ${value}`,
          reproducesOn: [],
          spec: false,
          flaky: false,
          correction: `finding 1 gives ${label} in the form REPORT_SHAPE gives it.`,
        },
      ],
    });
    expect(superpowersReview.normalize(good, scope).findings).toEqual([finding({ earlier: 2 })]);
  });

  it("a finding with no Correction condition is one environment finding", () => {
    const good = fromShape("FAIL", HEAD, [finding({})]);
    const bad = good.replace(/\n- Correction condition: .*/, "");
    expect(superpowersReview.normalize(bad, scope).findings).toEqual([
      {
        n: 1,
        severity: "environment",
        title: "Finding 1 has no Correction condition",
        reproducesOn: [],
        spec: false,
        flaky: false,
        correction: "finding 1 gives Correction condition in the form REPORT_SHAPE gives it.",
      },
    ]);
    expect(superpowersReview.normalize(good, scope).findings).toEqual([finding({})]);
  });

  it("round 2 prompts list each previous finding and the fix diff range", () => {
    const previous: ReviewFinding[] = [
      { ...finding({ n: 1, title: "Retry swallows the error", file: "src/run.ts", line: 42 }), kind: "touched", action: "back-to-builder", blocks: true },
      { ...finding({ n: 2, title: "No location" }), kind: "touched", action: "back-to-builder", blocks: true },
    ];
    const prompt = superpowersReview.invocation(rule, { ...scope, previousHead: PREV, previous }).input.prompt;
    expect(prompt).toContain(`This is a later round. Review only each previous finding below and the fix diff ${PREV}..${HEAD}.`);
    expect(prompt).toContain("Previous findings:\n1. Retry swallows the error (src/run.ts:42)\n2. No location");
    expect(prompt).not.toContain("This is round 1.");
    expect(prompt.indexOf("Upheld Practices:")).toBeLessThan(prompt.indexOf("Previous findings:"));
    expect(prompt.indexOf("Previous findings:")).toBeLessThan(prompt.indexOf(REPORT_SHAPE));
  });
});
