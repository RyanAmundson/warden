import { loadRecords } from "../records/load.js";
import { kindRank } from "../records/types.js";
import { learningScorecard } from "../review/learning.js";
import { readBaseline } from "../runner/baseline.js";
import { ESLINT_PASS, RUN_TOTAL, readEvidence } from "../runner/evidence.js";
const TIERS = ["edit", "commit", "boundary"];
const median = (xs) => {
    if (xs.length === 0)
        return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const round = (n) => Math.round(n);
const spread = (xs) => ({ medianMs: round(median(xs)), slowestMs: round(Math.max(0, ...xs)), runs: xs.length });
export async function buildReport(root, wardenRoot) {
    const set = await loadRecords(root, wardenRoot);
    const evidence = readEvidence(set.config.project);
    const baseline = readBaseline(root);
    const pairs = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.map((g) => ({ g, x }))));
    const known = new Set(pairs.map(({ g }) => g.id));
    const keyOf = (members) => [...members].sort().join("\0");
    const passes = evidence.filter((e) => e.kind === "cost" && e.shared !== undefined && e.members !== undefined && e.members.length > 1 && e.members.every((m) => known.has(m)));
    const latest = new Map();
    const passRows = new Set(passes);
    for (const e of evidence) {
        if (passRows.has(e))
            for (const m of e.members)
                latest.set(m, keyOf(e.members));
        else if (e.kind === "cost" && e.shared === undefined && e.guardrail !== undefined)
            latest.delete(e.guardrail);
    }
    const current = new Set(latest.values());
    const shared = [...current].map((key) => {
        const rows = passes.filter((e) => keyOf(e.members) === key);
        const ms = rows.filter((e) => e.ms !== undefined).map((e) => e.ms);
        return { shared: rows[0]?.shared, guardrails: (rows[0]?.members).length, members: rows[0]?.members, medianMs: round(median(ms)), slowestMs: round(Math.max(0, ...ms)) };
    });
    const sharedFor = (id) => shared.find((s) => s.members.includes(id) && keyOf(s.members) === latest.get(id));
    const guardrails = pairs.map(({ g, x }) => {
        const costShared = sharedFor(g.id)?.shared;
        const rows = evidence.filter((e) => e.kind === "cost" && e.guardrail === g.id && e.outcome === undefined && e.ms !== undefined);
        const ms = rows.map((e) => e.ms);
        const perFile = rows.filter((e) => (e.files ?? 0) > 0).map((e) => e.ms / e.files);
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
    const packOf = new Map(set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.map((g) => [g.id, p.id]))));
    const tiers = TIERS.map((tier) => {
        const inTier = evidence.filter((e) => e.kind === "cost" && e.tier === tier && e.run !== undefined && e.ms !== undefined);
        const totals = inTier.filter((e) => e.guardrail === RUN_TOTAL && e.outcome !== undefined);
        const ran = totals.filter((e) => e.outcome === "ran").map((e) => e.ms);
        const byPack = new Map();
        const charge = (pack, run, ms) => {
            if (pack === undefined)
                return;
            const runs = byPack.get(pack) ?? new Map();
            runs.set(run, (runs.get(run) ?? 0) + ms);
            byPack.set(pack, runs);
        };
        for (const e of inTier) {
            if (e.outcome !== undefined)
                continue;
            if (e.shared === undefined)
                charge(e.pack, e.run, e.ms);
            else
                for (const [id, ms] of Object.entries(e.rules ?? {}))
                    charge(packOf.get(id), e.run, ms);
        }
        const packs = set.packs.flatMap((p) => {
            const runs = byPack.get(p.id);
            return runs === undefined ? [] : [{ pack: p.id, ...spread([...runs.values()]) }];
        });
        const passes = [...current].flatMap((key) => {
            const rows = inTier.filter((e) => passRows.has(e) && e.rules !== undefined && keyOf(e.members) === key);
            if (rows.length === 0)
                return [];
            const overhead = rows.map((e) => e.ms - Object.values(e.rules).reduce((a, b) => a + b, 0));
            return [{ shared: rows[0]?.shared, members: rows[0]?.members, ...spread(overhead) }];
        });
        const budgetMs = set.config.tierBudgetMs[tier];
        const combined = spread(ran);
        return { tier, ...combined, earlyExits: totals.length - ran.length, budgetMs, withinBudget: combined.medianMs <= budgetMs, packs, passes };
    });
    const practices = set.packs
        .flatMap((p) => p.practices)
        .filter((x) => x.guardrails.length > 0)
        .map((x) => {
        const strongestKind = x.guardrails.map((g) => g.kind).sort((a, b) => kindRank(a) - kindRank(b))[0];
        return { practice: x.id, strongestKind, promote: strongestKind === "review" || strongestKind === "instruction", guardrails: x.guardrails.map((g) => g.id) };
    })
        .sort((a, b) => kindRank(a.strongestKind) - kindRank(b.strongestKind));
    const newest = new Map();
    for (const e of evidence) {
        if (e.kind !== "scaling" || e.verdict === undefined || e.warden === undefined)
            continue;
        const key = e.pack === undefined ? { guardrail: e.guardrail } : { pack: e.pack };
        const flipped = e.previous !== undefined && e.previous.verdict !== e.verdict ? { flippedFrom: e.previous.verdict } : {};
        newest.set(JSON.stringify(key), { ...key, verdict: e.verdict, ...(e.k === undefined ? {} : { k: e.k }), warden: e.warden, at: e.at, ...flipped });
    }
    const scalingOf = (key) => {
        const row = newest.get(JSON.stringify(key));
        return row === undefined ? [] : [row];
    };
    const scaling = [
        ...set.packs.flatMap((p) => [...scalingOf({ pack: p.id }), ...p.practices.flatMap((x) => x.guardrails.flatMap((g) => scalingOf({ guardrail: g.id })))]),
        ...scalingOf({ guardrail: ESLINT_PASS }),
    ];
    return { practices, guardrails, shared, tiers, scaling };
}
export async function runReport(root, wardenRoot, json) {
    const report = await buildReport(root, wardenRoot);
    const { practices, guardrails, shared, tiers, scaling } = report;
    if (json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return 0;
    }
    const lines = practices.flatMap((p) => [
        `practice ${p.practice}  strongest=${p.strongestKind}${p.promote ? "  promote" : ""}`,
        ...p.guardrails.map((id) => {
            const r = guardrails.find((x) => x.guardrail === id);
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
    if (scaling.length > 0)
        lines.push("scaling (warden bench)");
    for (const r of scaling) {
        const label = r.pack === undefined ? `${r.guardrail === ESLINT_PASS ? "  " : "    "}${r.guardrail}` : `  pack ${r.pack}`;
        const k = r.k === undefined ? "" : `  k=${r.k.toFixed(2)}`;
        const defect = r.verdict === "superlinear" ? "  DEFECT" : "";
        const flip = r.flippedFrom === undefined ? "" : `  flipped from ${r.flippedFrom}`;
        lines.push(`${label}  ${r.verdict}${k}${defect}${flip}  (warden ${r.warden}, ${r.at.slice(0, 10)})`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
}
export async function runLearningReport(root, wardenRoot, json) {
    const scorecard = await learningScorecard(root, wardenRoot);
    if (json) {
        process.stdout.write(`${JSON.stringify(scorecard, null, 2)}\n`);
        return 0;
    }
    process.stdout.write("Learning scorecard from retained checkout Evidence, dispute rulings, and repository review confirmations\n");
    for (const row of scorecard) {
        const precision = row.precision === null ? "unmeasured" : `${Math.round(row.precision * 100)}%`;
        process.stdout.write(`${row.pack}/${row.guardrail}  resolved=${row.resolved}  upheld=${row.upheldDisputes}  precision=${precision}  confirmed ${row.practice} escapes=${row.confirmedPracticeEscapes}  stalls=${row.stalls}\n`);
    }
    return 0;
}
