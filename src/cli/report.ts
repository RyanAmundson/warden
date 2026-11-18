import { loadRecords } from "../records/load.js";
import type { Tier } from "../records/types.js";
import { readBaseline } from "../runner/baseline.js";
import { type Evidence, readEvidence } from "../runner/evidence.js";

const TIERS: Tier[] = ["edit", "commit", "boundary"];

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

const round = (n: number): number => Math.round(n);

export interface GuardrailRow {
  guardrail: string;
  practice: string;
  kind: string;
  strength: "proven" | "unproven";
  baselineRemaining: number;
  fired: number;
  medianMs: number;
  slowestMs: number;
}

export interface TierRow {
  tier: Tier;
  medianTotalMs: number;
  budgetMs: number;
  withinBudget: boolean;
}

export async function buildReport(root: string, wardenRoot: string): Promise<{ guardrails: GuardrailRow[]; tiers: TierRow[] }> {
  const set = await loadRecords(root, wardenRoot);
  const evidence: Evidence[] = readEvidence(set.config.project);
  const baseline = readBaseline(root);
  const pairs = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.map((g) => ({ g, x }))));
  const guardrails = pairs.map(({ g, x }): GuardrailRow => {
    const ms = evidence.filter((e) => e.kind === "cost" && e.guardrail === g.id && e.ms !== undefined).map((e) => e.ms as number);
    return {
      guardrail: g.id,
      practice: x.id,
      kind: g.kind,
      strength: g.kind !== "legacy" && g.kind !== "instruction" && g.mustPass !== undefined ? "proven" : "unproven",
      baselineRemaining: Object.values(baseline[g.id] ?? {}).reduce((a, b) => a + b, 0),
      fired: evidence.filter((e) => e.kind === "fired" && e.guardrail === g.id).length,
      medianMs: round(median(ms)),
      slowestMs: round(Math.max(0, ...ms)),
    };
  });
  const tiers = TIERS.map((tier): TierRow => {
    const total = pairs.filter(({ g }) => g.runs.includes(tier)).reduce((n, { g }) => n + (guardrails.find((r) => r.guardrail === g.id) as GuardrailRow).medianMs, 0);
    const budgetMs = set.config.tierBudgetMs[tier];
    return { tier, medianTotalMs: total, budgetMs, withinBudget: total <= budgetMs };
  });
  return { guardrails, tiers };
}

export async function runReport(root: string, wardenRoot: string, json: boolean): Promise<number> {
  const { guardrails, tiers } = await buildReport(root, wardenRoot);
  if (json) {
    process.stdout.write(`${JSON.stringify({ guardrails, tiers }, null, 2)}\n`);
    return 0;
  }
  const lines = guardrails.map(
    (r) =>
      `${r.guardrail}  practice=${r.practice}  kind=${r.kind}  ${r.strength}  baseline=${r.baselineRemaining}  fired=${r.fired}  median=${r.medianMs}ms  slowest=${r.slowestMs}ms`,
  );
  lines.push(...tiers.map((t) => `tier ${t.tier}: ${t.medianTotalMs}ms of ${t.budgetMs}ms${t.withinBudget ? "" : "  OVER"}`));
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
