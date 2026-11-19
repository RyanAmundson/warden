import type { ReviewRule } from "../records/types.js";
import { componentQualityReview } from "./component-quality.js";
import type { RawFinding } from "./findings.js";
import { ponytailReview } from "./ponytail.js";
import { superpowersReview } from "./superpowers.js";
import { uiQaReview } from "./ui-qa.js";

export interface ReviewScope {
  base: string;
  head: string;
  previousHead?: string;
  previous?: Pick<RawFinding, "n" | "title" | "file" | "line">[];
  requirements: string[];
  upholds: { id: string; statement: string }[];
  component?: { name: string; root: string };
  resolveCommit?: (abbreviation: string) => string;
}
export type Invocation =
  | { tool: "Agent"; input: { description: string; subagent_type: string; model: string; prompt: string } }
  | { tool: "Workflow"; input: { scriptPath: string; args: { component: string; repoPath: string } }; scope: Pick<ReviewScope, "base" | "head" | "requirements" | "upholds">; instructions: string[] };
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

export const reviewAdapters = new Map<string, ReviewAdapter>([superpowersReview, ponytailReview, uiQaReview, componentQualityReview].map((adapter) => [adapter.id, adapter]));
