import { expect } from "vitest";
import type { Normalized, ReviewAdapter, ReviewScope } from "../../src/review/adapter.js";
import type { ReviewRule } from "../../src/records/types.js";

export function reviewConformance(adapter: ReviewAdapter, rule: ReviewRule, scope: ReviewScope, report: string, expected: Normalized): void {
  const call = adapter.invocation(rule, scope);
  if (call.tool === "Agent") {
    expect(call.input.model).toBe(rule.model);
    for (const part of [scope.head, scope.base, ...scope.requirements, ...scope.upholds.map((u) => u.statement)]) expect(call.input.prompt).toContain(part);
  } else {
    expect(call.scope).toEqual({ head: scope.head, base: scope.base, requirements: scope.requirements, upholds: scope.upholds });
    expect(call.input.args).toEqual({ component: scope.component?.name, repoPath: scope.component?.root });
  }
  expect(adapter.normalize(report, scope)).toEqual(expected);
}
