import { loadRecords } from "../records/load.js";
import { type Kind, type Tier, kindRank } from "../records/types.js";
import { readBaseline } from "../runner/baseline.js";
import { type Evidence, RUN_TOTAL, readEvidence } from "../runner/evidence.js";

const TIERS: Tier[] = ["edit", "commit", "boundary"];

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

const round = (n: number): number => Math.round(n);

const spread = (xs: number[]): { medianMs: number; slowestMs: number; runs: number } => ({ medianMs: round(median(xs)), slowestMs: round(Math.max(0, ...xs)), runs: xs.length });

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
  medianMsPerFile?: number;
}

export interface SharedRow {
  shared: string;
  guardrails: number;
  members: string[];
  medianMs: number;
  slowestMs: number;
}

export interface PackTotalRow {
  pack: string;
  medianMs: number;
  slowestMs: number;
  runs: number;
}

export interface PassTotalRow {
  shared: string;
  members: string[];
  medianMs: number;
  slowestMs: number;
  runs: number;
}

export interface TierRow {
  tier: Tier;
  medianMs: number;
  slowestMs: number;
  runs: number;
  earlyExits: number;
  budgetMs: number;
  withinBudget: boolean;
  packs: PackTotalRow[];
  passes: PassTotalRow[];
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
  const passRows = new Set(passes);
  for (const e of evidence) {
    if (passRows.has(e)) for (const m of e.members as string[]) latest.set(m, keyOf(e.members as string[]));
    else if (e.kind === "cost" && e.shared === undefined && e.guardrail !== undefined) latest.delete(e.guardrail);
  }
  const current = new Set(latest.values());
  const shared = [...current].map((key): SharedRow => {
    const rows = passes.filter((e) => keyOf(e.members as string[]) === key);
    const ms = rows.filter((e) => e.ms !== undefined).map((e) => e.ms as number);
    return { shared: rows[0]?.shared as string, guardrails: (rows[0]?.members as string[]).length, members: rows[0]?.members as string[], medianMs: round(median(ms)), slowestMs: round(Math.max(0, ...ms)) };
  });
  const sharedFor = (id: string): SharedRow | undefined => shared.find((s) => s.members.includes(id) && keyOf(s.members) === latest.get(id));
  const guardrails = pairs.map(({ g, x }): GuardrailRow => {
    const costShared = sharedFor(g.id)?.shared;
    const rows = evidence.filter((e) => e.kind === "cost" && e.guardrail === g.id && e.outcome === undefined && e.ms !== undefined);
    const ms = rows.map((e) => e.ms as number);
    const perFile = rows.filter((e) => (e.files ?? 0) > 0).map((e) => (e.ms as number) / (e.files as number));
    const own = costShared === undefined ? { medianMs: round(median(ms)), slowestMs: round(Math.max(0, ...ms)), ...(perFile.length === 0 ? {} : { medianMsPerFile: Math.round(median(perFile) * 100) / 100 }) } : { costShared };
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
  const packOf = new Map(set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.map((g) => [g.id, p.id] as const))));
  const tiers = TIERS.map((tier): TierRow => {
    const inTier = evidence.filter((e) => e.kind === "cost" && e.tier === tier && e.run !== undefined && e.ms !== undefined);
    const totals = inTier.filter((e) => e.guardrail === RUN_TOTAL && e.outcome !== undefined);
    const ran = totals.filter((e) => e.outcome === "ran").map((e) => e.ms as number);
    const byPack = new Map<string, Map<string, number>>();
    const charge = (pack: string | undefined, run: string, ms: number): void => {
      if (pack === undefined) return;
      const runs = byPack.get(pack) ?? new Map<string, number>();
      runs.set(run, (runs.get(run) ?? 0) + ms);
      byPack.set(pack, runs);
    };
    for (const e of inTier) {
      if (e.outcome !== undefined) continue;
      if (e.shared === undefined) charge(e.pack, e.run as string, e.ms as number);
      else for (const [id, ms] of Object.entries(e.rules ?? {})) charge(packOf.get(id), e.run as string, ms);
    }
    const packs = set.packs.flatMap((p): PackTotalRow[] => {
      const runs = byPack.get(p.id);
      return runs === undefined ? [] : [{ pack: p.id, ...spread([...runs.values()]) }];
    });
    const passes = [...current].flatMap((key): PassTotalRow[] => {
      const rows = inTier.filter((e) => passRows.has(e) && e.rules !== undefined && keyOf(e.members as string[]) === key);
      if (rows.length === 0) return [];
      const overhead = rows.map((e) => (e.ms as number) - Object.values(e.rules as Record<string, number>).reduce((a, b) => a + b, 0));
      return [{ shared: rows[0]?.shared as string, members: rows[0]?.members as string[], ...spread(overhead) }];
    });
    const budgetMs = set.config.tierBudgetMs[tier];
    const combined = spread(ran);
    return { tier, ...combined, earlyExits: totals.length - ran.length, budgetMs, withinBudget: combined.medianMs <= budgetMs, packs, passes };
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
      const perFile = r.medianMsPerFile === undefined ? "" : `  perFile=${r.medianMsPerFile}ms`;
      return `  ${r.guardrail}  kind=${r.kind}  ${r.strength}  baseline=${r.baselineRemaining}  fired=${r.fired}  median=${r.costShared === undefined ? `${r.medianMs}ms` : "shared"}  slowest=${r.costShared === undefined ? `${r.slowestMs}ms` : "shared"}${perFile}`;
    }),
  ]);
  lines.push(...shared.map((s) => `cost ${s.shared} (shared, ${s.guardrails} guardrails)  median=${s.medianMs}ms  slowest=${s.slowestMs}ms`));
  for (const t of tiers) {
    const exits = t.earlyExits === 0 ? "" : `, ${t.earlyExits} early exits`;
    lines.push(`tier ${t.tier}: median ${t.medianMs}ms, slowest ${t.slowestMs}ms of ${t.budgetMs}ms over ${t.runs} runs${exits}${t.withinBudget ? "" : "  OVER"}`);
    lines.push(...t.packs.map((p) => `  pack ${p.pack}  median ${p.medianMs}ms  slowest ${p.slowestMs}ms  runs ${p.runs}`));
    lines.push(...t.passes.map((p) => `  pass ${p.shared} (${p.members.length} guardrails, parse and setup)  median ${p.medianMs}ms  slowest ${p.slowestMs}ms  runs ${p.runs}`));
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
