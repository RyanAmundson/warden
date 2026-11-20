import type { RunResult } from "../adapters/types.js";
import type { Tier } from "../records/types.js";
import { appendEvidence, RUN_TOTAL, type Evidence } from "./evidence.js";

export interface ResolutionContext {
  at: string;
  root: string;
  tier: Tier;
  run: string;
  policy: string;
}

export function recordResolutions(project: string, previous: Evidence[], results: RunResult[], context: ResolutionContext): void {
  const passing = new Map(results.filter((r) => r.status === "pass" && r.overBudget !== true).map((r) => [r.guardrail, r.judgedFiles]));
  const completed = new Set(previous.filter((e) => e.kind === "cost" && e.guardrail === RUN_TOTAL && e.root === context.root && e.tier === context.tier && e.outcome === "ran" && e.result === "fail").map((e) => e.run));
  const seen = new Set<string>();
  for (let i = previous.length - 1; i >= 0; i--) {
    const { kind, root, tier, guardrail, file, detail, run, policy, pack, status } = previous[i] as Evidence;
    if ((kind !== "fired" && kind !== "resolved") || root !== context.root || tier !== context.tier || policy !== context.policy || guardrail === undefined || file === undefined) continue;
    const digest = passing.get(guardrail)?.get(file);
    if (digest === undefined) continue;
    const key = `${guardrail}\0${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (kind !== "fired" || status !== "fail" || run === undefined || !completed.has(run) || detail === undefined || digest === detail) continue;
    appendEvidence(project, { ...context, kind: "resolved", guardrail, file, status: "pass", detail: digest, sourceRun: run, ...(pack === undefined ? {} : { pack }) });
  }
}
