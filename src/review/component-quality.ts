import { homedir } from "node:os";
import { join, posix } from "node:path";
import type { Normalized, ReviewAdapter, ReviewScope } from "./adapter.js";
import { reviewError } from "./brief.js";
import type { RawFinding } from "./findings.js";

const SEVERITIES = new Map<string, RawFinding["severity"]>([
  ["Critical", "critical"], ["High", "important"], ["Medium", "important"], ["Low", "minor"],
]);

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const pathOf = (value: unknown): string | undefined => {
  if (typeof value !== "string" || /[\r\n\0]/.test(value)) return undefined;
  const path = posix.normalize(value);
  return path === "." || path === ".." || path.startsWith("../") || posix.isAbsolute(path) ? undefined : path;
};

const reviewedCommit = (reported: unknown, scope: ReviewScope): string => {
  if (typeof reported !== "string" || !/^[0-9a-f]{4,64}$/.test(reported)) return "";
  if (reported === scope.head) return reported;
  try {
    return scope.resolveCommit?.(reported) ?? "";
  } catch {
    return "";
  }
};

const score = (value: unknown): value is number => typeof value === "number" && value >= 0 && value <= 100;

const GROUPS = [..."ABCDEFGHIJKLMN"];
const FACET_COUNTS = new Map<string, readonly number[]>([
  ["atom", [5, 2, 7, 6, 3, 9, 5, 5, 7, 8, 6, 5, 4, 4]],
  ["molecule", [5, 2, 7, 6, 3, 9, 5, 5, 7, 8, 6, 5, 4, 4]],
  ["organism", [5, 3, 10, 6, 6, 9, 5, 5, 7, 8, 6, 5, 5, 4]],
  ["container", [5, 4, 10, 6, 7, 9, 5, 5, 7, 8, 6, 5, 5, 4]],
  ["page-shell", [5, 4, 10, 6, 7, 9, 5, 5, 7, 8, 6, 5, 5, 4]],
]);

function hasAuditEvidence(report: Record<string, unknown>): boolean {
  const confidence = object(report.confidence);
  const expected = typeof report.class === "string" ? FACET_COUNTS.get(report.class) : undefined;
  if (expected === undefined || !Array.isArray(report.groups) || report.groups.length !== GROUPS.length || !Array.isArray(report.facets)) return false;
  const byGroup = new Map<string, { group: Record<string, unknown>; scored: number; notApplicable: number; unknown: number }>();
  for (const value of report.groups) {
    const group = object(value);
    if (typeof group?.id !== "string" || !GROUPS.includes(group.id) || byGroup.has(group.id)) return false;
    byGroup.set(group.id, { group, scored: 0, notApplicable: 0, unknown: 0 });
  }
  const ids = new Set<string>();
  let applicable = 0;
  let unknown = 0;
  for (const value of report.facets) {
    const facet = object(value);
    const counts = typeof facet?.group === "string" ? byGroup.get(facet.group) : undefined;
    if (counts === undefined || typeof facet?.id !== "string" || !/^[A-N][1-9]\d*$/.test(facet.id) || facet.id[0] !== facet.group || ids.has(facet.id)) return false;
    ids.add(facet.id);
    switch (facet.status) {
      case "applicable":
        if (!score(facet.score)) return false;
        counts.scored++;
        applicable++;
        break;
      case "not-applicable":
        counts.notApplicable++;
        break;
      case "unknown":
        counts.unknown++;
        unknown++;
        break;
      default:
        return false;
    }
  }
  return applicable > 0 && confidence?.applicable === applicable && confidence.unknown === unknown &&
    [...byGroup.values()].every(({ group, scored, notApplicable, unknown }) =>
      group.scored === scored && group.notApplicable === notApplicable && group.unknown === unknown &&
      scored + notApplicable + unknown === expected[GROUPS.indexOf(String(group.id))]);
}

const normalize = (text: string, scope: ReviewScope): Normalized => {
  const invalid = (title: string, head = ""): Normalized =>
    reviewError(head, title, "run the Component Quality workflow on the requested component and commit, then pass its JSON sidecar to warden review triage.");
  let report: Record<string, unknown> | undefined;
  try {
    report = object(JSON.parse(text));
  } catch {
    return invalid("The Component Quality sidecar is not JSON");
  }
  if (report?.schemaVersion !== 1) return invalid("The Component Quality sidecar has an unknown schema");
  const head = reviewedCommit(report.commit, scope);
  if (head !== scope.head) return invalid("The Component Quality sidecar does not name the requested commit", head);
  const component = pathOf(report.componentPath);
  const reportPath = pathOf(report.reportPath);
  if (scope.component === undefined || report.component !== scope.component.name || component === undefined || reportPath === undefined) {
    return invalid("The Component Quality sidecar does not identify the requested component and its report", head);
  }

  const finding = (title: string, severity: RawFinding["severity"], file: string, correction: string, n: number): RawFinding => {
    const prior = scope.previous?.find((item) => item.title === title && item.file === file);
    return {
      n, title, severity, file, correction, spec: false, flaky: false, evidence: [reportPath],
      reproducesOn: prior === undefined ? ["head"] : ["head", "previous"],
      ...(prior === undefined ? {} : { earlier: prior.n }),
    };
  };
  if (report.verdict === "NOT-IN-APP" && report.appCallSites === 0 && typeof report.recommendation === "string" && report.recommendation.trim() !== "") {
    return { verdict: "fail", reviewedHead: head, findings: [finding("The component has no app call sites", "important", component, report.recommendation, 1)] };
  }
  const counts = object(report.findingCounts);
  if (!score(report.score) || !hasAuditEvidence(report) ||
    !Array.isArray(report.findings) || report.unverifiedFindings !== 0 || counts === undefined) {
    return invalid("The Component Quality sidecar does not contain a completed and verified audit", head);
  }

  const findings: RawFinding[] = [];
  const counted = new Map<string, number>();
  for (const value of report.findings) {
    const item = object(value);
    const level = typeof item?.severity === "string" ? item.severity : "";
    const severity = SEVERITIES.get(level);
    const file = item?.file === undefined ? component : pathOf(item.file);
    if (severity === undefined || file === undefined || item?.unverified !== false || typeof item.title !== "string" || item.title.trim() === "") {
      return invalid("The Component Quality sidecar contains an incomplete finding", head);
    }
    const location = item.line;
    if (location !== undefined && (typeof location !== "string" || location.trim() === "" || /[\r\n\0]/.test(location))) {
      return invalid("The Component Quality sidecar contains an invalid finding location", head);
    }
    const ranges = typeof location === "string" ? location.split(",").map((part) => /^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(part.trim())) : [];
    for (const range of ranges) {
      if (range === null) continue;
      const start = Number(range[1]);
      const end = Number(range[2] ?? range[1]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
        return invalid("The Component Quality sidecar contains an invalid finding location", head);
      }
    }
    const single = ranges.length === 1 ? ranges[0] : null;
    const line = Number(single?.[1]);
    const endLine = Number(single?.[2] ?? single?.[1]);
    const correction = single == null && location !== undefined
      ? `Apply the recommendation for this finding in ${reportPath} (reported location: ${location}).`
      : `Apply the recommendation for this finding in ${reportPath}.`;
    findings.push({
      ...finding(item.title, severity, file, correction, findings.length + 1),
      ...(single == null ? {} : { line, ...(endLine === line ? {} : { endLine }) }),
    });
    counted.set(level, (counted.get(level) ?? 0) + 1);
  }
  if ([...SEVERITIES.keys()].some((severity) => counts[severity] !== (counted.get(severity) ?? 0))) {
    return invalid("The Component Quality sidecar findings do not match its severity totals", head);
  }
  if (object(report.confidence)?.unknown !== 0) {
    const [coverage] = invalid("The Component Quality audit has unmeasured facets and cannot establish a clean result", head).findings;
    if (coverage !== undefined) findings.push({ ...coverage, n: findings.length + 1 });
  }
  return { verdict: findings.length === 0 ? "pass" : "fail", reviewedHead: head, findings };
};

export const componentQualityReview: ReviewAdapter = {
  id: "component-quality",
  invocation: (_rule, scope) => {
    if (scope.component === undefined) throw new Error("Component Quality requires a component and checkout");
    const scriptPath = join(homedir(), ".agents", "skills", "component-quality", "component-quality.js");
    const { base, head, requirements, upholds, component } = scope;
    return {
      tool: "Workflow",
      input: { scriptPath, args: { component: component.name, repoPath: component.root } },
      scope: { base, head, requirements, upholds },
      instructions: [
        `Reserve the worktree at ${component.root} for this audit. Keep it at ${head} and keep other writers out until the Workflow exits.`,
        "Verify the Workflow startup logs confirm the expected repository and component. Cancel the audit if the arguments did not reach the Workflow.",
        `After the Workflow exits, verify HEAD is still ${head} and that tracked files have no changes. Pass the JSON sidecar produced by this run to warden review triage.`,
      ],
    };
  },
  normalize,
};
