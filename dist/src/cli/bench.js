import { RANK, benchSubject, pointsText, prefixOf, subjectsOf } from "../compiler/bench.js";
import { wardenVersion } from "../compiler/compile.js";
import { RecordError, loadRecords } from "../records/load.js";
import { benchSettings } from "../records/types.js";
import { ESLINT_PASS, appendEvidence } from "../runner/evidence.js";
const worst = (ms) => ms.reduce((a, b) => (RANK.indexOf(b.verdict) > RANK.indexOf(a.verdict) || (b.verdict === a.verdict && (b.k ?? 0) > (a.k ?? 0)) ? b : a));
const select = (set, rule, pack) => {
    if (pack !== undefined && !set.packs.some((p) => p.id === pack)) {
        throw new RecordError("", "/pack", `no pack has id "${pack}". Next action: run warden packs to list pack ids, then run warden bench --pack <id>.`);
    }
    const gs = set.packs
        .filter((p) => pack === undefined || p.id === pack)
        .flatMap((p) => p.practices.flatMap((x) => x.guardrails.filter((g) => g.kind !== "instruction" && (rule === undefined || g.id === rule || x.id === rule))));
    if (rule !== undefined && gs.length === 0) {
        throw new RecordError("", "/rule", `no Practice or Guardrail has id "${rule}". Next action: run warden report to list Guardrail ids, then run warden bench --rule <id>.`);
    }
    return gs;
};
export async function runBench(root, wardenRoot, opts) {
    try {
        const set = await loadRecords(root, wardenRoot);
        const cfg = benchSettings(set.config);
        const subjects = subjectsOf(set, select(set, opts.rule, opts.pack));
        const warden = await wardenVersion(wardenRoot);
        const at = new Date().toISOString();
        const rows = [];
        const record = (key, m) => appendEvidence(set.config.project, { at, kind: "scaling", ...key, ...m, warden });
        for (const pack of set.packs) {
            const own = subjects.filter((s) => s.pack === pack);
            if (own.length === 0)
                continue;
            const measured = [];
            const inner = [];
            for (const s of own) {
                const m = await benchSubject(set, s, cfg, "warden bench");
                record({ guardrail: s.id }, m);
                measured.push(m);
                inner.push({ indent: "    ", label: s.id, m, id: s.id });
            }
            const { previous: _, ...packM } = worst(measured);
            record({ pack: pack.id }, packM);
            rows.push({ indent: "  ", label: `pack ${pack.id}`, m: packM }, ...inner);
        }
        const lint = opts.rule === undefined && opts.pack === undefined ? subjects.find((s) => prefixOf(s.g) === "eslint") : undefined;
        if (lint !== undefined) {
            const m = await benchSubject(set, { ...lint, id: ESLINT_PASS, time: (r) => r.ms - (r.ruleMs ?? 0) }, cfg, "warden bench");
            record({ guardrail: ESLINT_PASS }, m);
            rows.push({ indent: "  ", label: ESLINT_PASS, m, id: ESLINT_PASS });
        }
        const width = Math.max(0, ...rows.map((r) => r.indent.length + r.label.length)) + 2;
        const lines = [`scaling (warden bench at ${warden}, ${at.slice(0, 10)})`];
        for (const { indent, label, m } of rows) {
            const k = m.k === undefined ? "" : `k=${m.k.toFixed(2)}`;
            lines.push(`${`${indent}${label}`.padEnd(width)}${m.verdict.padEnd(13)}${k}${m.verdict === "superlinear" ? "  DEFECT" : ""}`.trimEnd());
        }
        const defects = rows.filter((r) => r.id !== undefined && r.m.verdict === "superlinear");
        for (const { id, m } of defects) {
            lines.push(`${id} points: ${pointsText(m)}`);
        }
        if (defects.length > 0)
            lines.push(`Next action: make ${defects.map((d) => d.id).join(", ")} linear in files; see the four points above.`);
        process.stdout.write(`${lines.join("\n")}\n`);
        return defects.length > 0 ? 1 : 0;
    }
    catch (cause) {
        if (!(cause instanceof RecordError))
            throw cause;
        process.stderr.write(`${cause.file} ${cause.pointer}: ${cause.message}\n`);
        return 2;
    }
}
