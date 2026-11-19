import type { ReviewRule } from "../records/types.js";
import type { RawFinding } from "./findings.js";
import { ponytailReview } from "./ponytail.js";
import { superpowersReview } from "./superpowers.js";

export interface ReviewScope {
  base: string;
  head: string;
  previousHead?: string;
  previous?: Pick<RawFinding, "n" | "title" | "file" | "line">[];
  requirements: string[];
  upholds: { id: string; statement: string }[];
}
export interface Invocation {
  tool: "Agent";
  input: { description: string; subagent_type: string; model: string; prompt: string };
}
export interface Normalized {
  verdict: "pass" | "fail";
  reviewedHead: string;
  findings: RawFinding[];
}
export interface ReviewAdapter {
  id: string;
  invocation(rule: ReviewRule, scope: ReviewScope): Invocation;
  normalize(report: string, scope: ReviewScope): Normalized;
}

export const reviewAdapters = new Map<string, ReviewAdapter>([superpowersReview, ponytailReview].map((adapter) => [adapter.id, adapter]));
