import { loadRecords } from "../records/load.js";
import { type Kind, type Tier, kindRank } from "../records/types.js";
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
  strength: "proven" | "prose";
  baselineRemaining: number;
  fired: number;
  medianMs?: number;
  slowestMs?: number;
  costShared?: string;
}

export interface SharedRow {
  shared: string;
  guardrails: number;
  members: string[];
  medianMs: number;
  slowestMs: number;
}

export interface TierRow {
  tier: Tier;
  medianTotalMs: number;
  budgetMs: number;
  withinBudget: boolean;
}

export interface PracticeRow {
  practice: string;
  strongestKind: Kind;
  promote: boolean;
  guardrails: string[];
}

export async function buildReport(root: string, wardenRoot: string): Promise<{ practices: PracticeRow[]; guardrails: GuardrailRow[]; shared: SharedRow[]; tiers: TierRow[] }> {
  const set = await loadRecords(root, wardenRoot);
  const evidence: Evidence[] = readEvidence(set.config.project);
  const baseline = readBaseline(root);
  const pairs = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.map((g) => ({ g, x }))));
  const known = new Set(pairs.map(({ g }) => g.id));
  const keyOf = (members: string[]): string => [...members].sort().join("\0");
  const passes = evidence.filter((e) => e.kind === "cost" && e.shared !== undefined && e.members !== undefined && e.members.length > 1 && e.members.every((m) => known.has(m)));
  const latest = new Map<string, string>();
  for (const e of passes) for (const m of e.members as string[]) latest.set(m, keyOf(e.members as string[]));
  const current = new Set(latest.values());
  const shared = [...current].map((key): SharedRow => {
    const rows = passes.filter((e) => keyOf(e.members as string[]) === key);
    const ms = rows.filter((e) => e.ms !== undefined).map((e) => e.ms as number);
    return { shared: rows[0]?.shared as string, guardrails: (rows[0]?.members as string[]).length, members: rows[0]?.members as string[], medianMs: round(median(ms)), slowestMs: round(Math.max(0, ...ms)) };
  });
  const sharedFor = (id: string): SharedRow | undefined => shared.find((s) => s.members.includes(id) && keyOf(s.members) === latest.get(id));
  const guardrails = pairs.map(({ g, x }): GuardrailRow => {
    const costShared = sharedFor(g.id)?.shared;
    const ms = evidence.filter((e) => e.kind === "cost" && e.guardrail === g.id && e.ms !== undefined).map((e) => e.ms as number);
    const own = costShared === undefined ? { medianMs: round(median(ms)), slowestMs: round(Math.max(0, ...ms)) } : { costShared };
    return {
      guardrail: g.id,
      practice: x.id,
      kind: g.kind,
      strength: g.kind === "instruction" ? "prose" : "proven",
      baselineRemaining: Object.values(baseline[g.id] ?? {}).reduce((a, b) => a + b, 0),
      fired: evidence.filter((e) => e.kind === "fired" && e.guardrail === g.id).length,
      ...own,
    };
  });
  const tiers = TIERS.map((tier): TierRow => {
    const inTier = pairs.filter(({ g }) => g.runs.includes(tier));
    const own = inTier.reduce((n, { g }) => n + ((guardrails.find((r) => r.guardrail === g.id) as GuardrailRow).medianMs ?? 0), 0);
    const total = shared.filter((s) => inTier.some(({ g }) => s.members.includes(g.id))).reduce((n, s) => n + s.medianMs, own);
    const budgetMs = set.config.tierBudgetMs[tier];
    return { tier, medianTotalMs: total, budgetMs, withinBudget: total <= budgetMs };
  });
  const practices = set.packs
    .flatMap((p) => p.practices)
    .filter((x) => x.guardrails.length > 0)
    .map((x): PracticeRow => {
      const strongestKind = x.guardrails.map((g) => g.kind).sort((a, b) => kindRank(a) - kindRank(b))[0] as Kind;
      return { practice: x.id, strongestKind, promote: strongestKind === "review" || strongestKind === "instruction", guardrails: x.guardrails.map((g) => g.id) };
    })
    .sort((a, b) => kindRank(a.strongestKind) - kindRank(b.strongestKind));
  return { practices, guardrails, shared, tiers };
}

export async function runReport(root: string, wardenRoot: string, json: boolean): Promise<number> {
  const { practices, guardrails, shared, tiers } = await buildReport(root, wardenRoot);
  if (json) {
    process.stdout.write(`${JSON.stringify({ practices, guardrails, shared, tiers }, null, 2)}\n`);
    return 0;
  }
  const lines = practices.flatMap((p) => [
    `practice ${p.practice}  strongest=${p.strongestKind}${p.promote ? "  promote" : ""}`,
    ...p.guardrails.map((id) => {
      const r = guardrails.find((x) => x.guardrail === id) as GuardrailRow;
      return `  ${r.guardrail}  kind=${r.kind}  ${r.strength}  baseline=${r.baselineRemaining}  fired=${r.fired}  median=${r.costShared === undefined ? `${r.medianMs}ms` : "shared"}  slowest=${r.costShared === undefined ? `${r.slowestMs}ms` : "shared"}`;
    }),
  ]);
  lines.push(...shared.map((s) => `cost ${s.shared} (shared, ${s.guardrails} guardrails)  median=${s.medianMs}ms  slowest=${s.slowestMs}ms`));
  lines.push(...tiers.map((t) => `tier ${t.tier}: ${t.medianTotalMs}ms of ${t.budgetMs}ms${t.withinBudget ? "" : "  OVER"}`));
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
