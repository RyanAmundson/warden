import { expect } from "vitest";
import type { Normalized, ReviewAdapter, ReviewScope } from "../../src/review/adapter.js";
import type { ReviewRule } from "../../src/records/types.js";

export function reviewConformance(adapter: ReviewAdapter, rule: ReviewRule, scope: ReviewScope, report: string, expected: Normalized): void {
  const call = adapter.invocation(rule, scope);
  expect(call.tool).toBe("Agent");
  expect(call.input.model).toBe(rule.model);
  for (const part of [scope.head, scope.base, ...scope.requirements, ...scope.upholds.map((u) => u.statement)]) expect(call.input.prompt).toContain(part);
  expect(adapter.normalize(report, scope)).toEqual(expected);
}
