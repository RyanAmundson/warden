import type { ReviewRule } from "../records/types.js";
import { codeReview } from "./code-review.js";
import { componentQualityReview } from "./component-quality.js";
import type { RawFinding, Touched } from "./findings.js";
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
  pullRequest?: string;
  committedChanges?: (base: string, head: string) => Touched;
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

export const reviewAdapters = new Map<string, ReviewAdapter>([superpowersReview, ponytailReview, uiQaReview, componentQualityReview, codeReview].map((adapter) => [adapter.id, adapter]));
