import { existsSync, watch } from "node:fs";
import { basename, join } from "node:path";
import { wardenVersion } from "../compiler/compile.js";
import { bundledTools } from "../compiler/lock.js";
import { RecordError, loadRecords } from "../records/load.js";
import { kindRank } from "../records/types.js";
import { evidenceProjects, readEvidence } from "../runner/evidence.js";
import { MAX_RECORDED_FAILURES } from "./check.js";
import { listPacks } from "./packs.js";
import { buildReport } from "./report.js";
import { clock, columns, cut, firstFailure, msText, noRules, older, padCells, ruleParts, runRecords, target, visible } from "./runs.js";
export async function loadView(root, wardenRoot) {
    if (!existsSync(join(root, ".warden/config.yaml")))
        throw new RecordError(".warden/config.yaml", "", ".warden/config.yaml not found. Next action: run warden init");
    const set = await loadRecords(root, wardenRoot);
    const report = await buildReport(root, wardenRoot);
    const budget = new Map(set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.map((g) => [g.id, g.budgetMs]))));
    const median = (id) => {
        const row = report.guardrails.find((g) => g.guardrail === id);
        return row?.costShared !== undefined ? "shared" : `${row?.medianMs ?? 0} ms`;
    };
    const evidence = readEvidence(set.config.project);
    const lastRan = (list) => runRecords(list).filter((e) => e.outcome === "ran").at(-1);
    return {
        project: set.config.project,
        base: set.config.base,
        version: await wardenVersion(wardenRoot),
        packs: set.config.packs.map((p) => p.id),
        tools: bundledTools(),
        rules: report.guardrails.map((g) => ({ guardrail: g.guardrail, strength: g.strength, fired: g.fired, median: g.costShared === undefined ? `${g.medianMs ?? 0} ms` : "shared", budgetMs: budget.get(g.guardrail) ?? 0, baselined: g.baselineRemaining })),
        evidence,
        now: Date.now(),
        layers: set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.map((g) => ({ pack: p.id, guardrail: g.id, practice: x.id, kind: g.kind, adapter: g.implementation.slice(0, g.implementation.indexOf(":")), runs: g.runs, median: median(g.id) })))),
        practices: report.practices.map(({ practice, strongestKind, promote }) => ({ practice, strongestKind, promote })),
        packList: (await listPacks(root, wardenRoot)).map((r) => ({ id: r.id, source: r.source, on: r.on, rules: Object.values(r.kinds).reduce((a, b) => a + b, 0) })),
        projects: [...new Set([set.config.project, ...evidenceProjects()])].map((project) => ({ project, run: lastRan(project === set.config.project ? evidence : readEvidence(project)) })),
    };
}
const runCheck = (size) => (size.plain === true ? "run warden check" : "press r to run warden check");
const STEPS = [
    { step: "rules-intact", done: "rules intact", running: "checking rules" },
    { step: "tools-ready", done: "tools ready", running: "checking tools" },
    { step: "rules", done: "rules", running: "running rules" },
    { step: "verdict", done: "verdict", running: "deciding" },
];
const TRIGGER = { "agent-edit": "agent edit", "git-commit": "git commit", manual: "manual run" };
const SHORT = { "agent-edit": "edit", "git-commit": "commit", manual: "manual" };
const BAR = 16;
const clip = (raw, width) => {
    const line = visible(raw);
    return columns(line) > width ? `${cut(line, width - 1)}…` : line;
};
const spread = (left, right, width) => {
    if (right === "")
        return clip(left, width);
    const room = width - columns(right) - 1;
    if (room < 1)
        return clip(left, width);
    return `${padCells(clip(left, room), room)} ${right}`;
};
const wrap = (text, width, most) => {
    const lines = [];
    for (const word of text.split(" ")) {
        const last = lines.at(-1);
        if (last !== undefined && last.length + 1 + word.length <= width)
            lines[lines.length - 1] = `${last} ${word}`;
        else
            lines.push(lines.length === 0 ? word : ` ${word}`);
    }
    const kept = lines.slice(0, most);
    if (lines.length > most)
        kept[most - 1] = `${kept[most - 1]}…`;
    return kept.map((l) => clip(l, width));
};
const count = (n) => n.toLocaleString("en-US");
const header = (model, [full, short], back, width) => {
    const name = ` WARDEN  ${model.project}`;
    const withBack = (hint) => (back === "" ? hint : `${hint}  ${back}`);
    const rerun = withBack("q quit  r rerun");
    const bare = withBack("q quit");
    const base = `${name} · base ${model.base} · v${model.version}`;
    const version = `${name} · v${model.version}`;
    const tiers = [[base, full], [base, short], [version, full], [version, short], [name, full], [name, short], [version, rerun], [name, rerun], [" WARDEN", rerun], ["", rerun], [" WARDEN", bare], ["", bare]];
    const pick = tiers.find(([left, hint]) => columns(visible(left)) + (left === "" ? 0 : 1) + columns(hint) <= width);
    if (pick === undefined)
        return spread(" WARDEN", bare, width);
    return pick[0] === "" ? pick[1] : spread(pick[0], pick[1], width);
};
const DETAIL = 25;
const partLines = (first, parts, right, width) => {
    const room = width - DETAIL - right.length - 1;
    const lines = [];
    for (const part of parts) {
        const last = lines.at(-1);
        if (last !== undefined && last.length + 3 + part.length <= room)
            lines[lines.length - 1] = `${last} · ${part}`;
        else
            lines.push(part);
    }
    const [head = "", ...rest] = lines;
    return [spread(`${first}${head}`, right, width), ...rest.map((l) => clip(`${" ".repeat(DETAIL)}${l}`, width))];
};
const stepLines = (shown, tools, width) => {
    const all = shown?.steps ?? [];
    const record = shown?.record;
    if (record !== undefined && all.length === 0)
        return [clip(`   ${record.steps === undefined ? "steps not recorded (older Warden)" : "stopped before the first step"} · total ${msText(record.ms ?? 0)}`, width)];
    const finished = STEPS.filter(({ step }) => {
        const last = all.filter((e) => e.step === step).at(-1);
        return last !== undefined && last.state !== "start";
    }).length;
    const lines = STEPS.flatMap(({ step, done, running }, i) => {
        const events = all.filter((e) => e.step === step);
        const last = events.at(-1);
        const n = i + 1;
        if (last === undefined)
            return [`   ○ ${n} ${done}`];
        const members = [...new Set(events.flatMap((e) => e.members ?? []))].join(" · ");
        if (last.state === "start" && shown?.interrupted === true) {
            return [spread(`   ✗ ${n} ${done.padEnd(18)}${members}`, "interrupted", width)];
        }
        if (last.state === "start") {
            const bar = "█".repeat(Math.round((finished / STEPS.length) * BAR)).padEnd(BAR, "░");
            return [spread(`   ● ${n} ${running.padEnd(18)}${step === "rules" ? `${bar}  ${members}` : ""}`, "...", width)];
        }
        const failed = events.some((e) => e.state === "fail");
        const ms = events.filter((e) => e.state !== "start").reduce((sum, e) => sum + (e.ms ?? 0), 0);
        const cached = events.some((e) => e.status === "cached") && step === "tools-ready";
        const first = `   ${failed ? "✗" : "✓"} ${n} ${done.padEnd(18)}`;
        const right = cached ? "cached" : msText(ms);
        if (step === "rules" && record !== undefined) {
            const listed = Object.values(record.rules ?? {}).reduce((a, b) => a + b, 0) + Object.values(record.passes ?? {}).reduce((a, b) => a + b, 0);
            const setup = ms - listed;
            const parts = [...(ruleParts(record) ?? [noRules(record)]), ...(record.rules !== undefined && setup >= 0.05 ? [`loading and cache ${msText(setup)}`] : [])];
            return partLines(first, parts.length === 0 ? [last.status === "empty" ? "no changed files" : "every result cached"] : parts, right, width);
        }
        const detail = (() => {
            if (step === "rules-intact")
                return failed ? "records or generated config changed outside warden compile" : "lock matches, 0 tampered files";
            if (step === "tools-ready")
                return failed ? "a bundled tool or a cmd Guardrail's command is missing" : Object.entries(tools).filter(([name]) => name !== "typescript-eslint").map(([name, v]) => `${name} ${v}`).join(" · ");
            if (step === "rules")
                return members === "" ? (last.status === "empty" ? "no changed files" : "every result cached") : members;
            const blocked = record === undefined ? "" : firstFailure(record);
            return failed ? `BLOCK  ${blocked}`.trimEnd() : "pass";
        })();
        return [spread(`${first}${detail}`, right, width)];
    });
    if (record === undefined)
        return lines;
    const stepped = all.filter((e) => e.state !== "start").reduce((sum, e) => sum + (e.ms ?? 0), 0);
    return [...lines, spread("     setup and records", msText((record.ms ?? 0) - stepped), width)];
};
const verdictCell = (e) => {
    if (e.outcome === "ran" && e.result === "pass")
        return "✓ pass";
    if (e.outcome === "ran" && e.result === "fail") {
        const f = e.failures?.[0];
        return `✗ BLOCK ${f === undefined ? "" : `${f.practice} ${f.file === "" ? "project" : `L${f.line}`}`}`.trimEnd();
    }
    if (e.outcome === "tampered")
        return "✗ TAMPERED";
    if (e.outcome === "unstaged")
        return "✗ unstaged";
    if (e.outcome === "error")
        return "✗ error";
    if (e.outcome === "empty")
        return "· no changes";
    return e.outcome === "ran" ? "? no result recorded" : `· ${e.outcome ?? ""}`;
};
const footer = (shown, live, size) => {
    if (shown?.interrupted === true)
        return ` Next action: ${runCheck(size)}`;
    if (live)
        return " Running warden check…";
    const record = shown?.record;
    if (record === undefined)
        return ` Next action: ${runCheck(size)}`;
    if (record.next !== undefined)
        return ` Next action: ${record.next}`;
    if (record.result === "pass")
        return " The last run passed; nothing to do.";
    if (record.outcome === "empty")
        return " The last run found no changed files; nothing to do.";
    return " This run was recorded without a result.";
};
export const liveDeadline = (model) => {
    const lastStep = model.evidence.filter((e) => e.kind === "step").at(-1);
    if (lastStep === undefined || runRecords(model.evidence).some((r) => r.run === lastStep.run))
        return undefined;
    const budget = new Map(model.rules.map((r) => [r.guardrail, r.budgetMs]));
    const open = model.evidence.filter((e) => e.kind === "step" && e.run === lastStep.run && e.step === "rules" && e.state === "start").at(-1);
    const members = lastStep.step === "rules" && open !== undefined ? (open.members ?? []) : [...budget.keys()];
    const at = Date.parse(lastStep.at) + members.reduce((n, id) => n + (budget.get(id) ?? 0), 0);
    return at >= model.now ? at : undefined;
};
export function render(model, size, selected) {
    const width = Math.max(20, size.cols);
    const rule = "─".repeat(width);
    const runs = runRecords(model.evidence).reverse();
    const stepsOf = (run) => model.evidence.filter((e) => e.kind === "step" && e.run === run);
    const lastStep = model.evidence.filter((e) => e.kind === "step").at(-1);
    const liveRun = lastStep !== undefined && !runs.some((r) => r.run === lastStep.run) ? lastStep.run : undefined;
    const liveSteps = stepsOf(liveRun);
    const interrupted = liveRun !== undefined && liveDeadline(model) === undefined;
    const pick = Math.min(Math.max(0, selected), Math.max(0, runs.length - 1));
    const live = liveRun !== undefined && selected === 0;
    const record = live ? undefined : runs[pick];
    const shown = live ? { steps: liveSteps, interrupted } : record === undefined ? undefined : { record, steps: stepsOf(record.run) };
    const head = (() => {
        if (shown === undefined)
            return " NOW  idle · no check has run in this project yet";
        const first = shown.steps[0];
        const tier = shown.record?.tier ?? first?.tier ?? "";
        const trigger = shown.record?.trigger ?? first?.trigger;
        const where = shown.record === undefined ? shown.steps.find((e) => e.files !== undefined) : shown.record;
        return [` NOW  ${tier === "" ? "" : `${tier} `}check`, ...(where === undefined ? [] : [target(where)]), ...(trigger === undefined ? [] : [`triggered by ${TRIGGER[trigger] ?? trigger}`]), ...(shown.interrupted === true ? ["interrupted"] : []), ...(shown.record?.ms === undefined ? [] : [msText(shown.record.ms)])].join(" · ");
    })();
    const top = [header(model, ["q quit  r rerun  l layers  v violations  d determinism", "q quit  r rerun  l layers  v viol  d det"], "", width), rule, clip(head, width), ...stepLines(shown, model.tools, width), ""];
    const bottom = [rule, ...wrap(footer(shown, live, size), width, 3)];
    const room = Math.max(0, size.rows - top.length - bottom.length - 3);
    const ruleRows = Math.min(model.rules.length, Math.ceil(room / 2));
    const runRows = Math.max(0, room - ruleRows);
    const packs = ` RULES (${model.packs.join(", ")} pack${model.packs.length === 1 ? "" : "s"})`;
    const rules = [
        spread(packs, `${"strength".padStart(8)} ${"fired".padStart(7)} ${"median".padStart(8)} ${"budget".padStart(9)}`, width),
        ...model.rules.slice(0, ruleRows).map((r) => spread(`   ${r.guardrail}`, `${r.strength.padStart(8)} ${String(r.fired).padStart(7)} ${r.median.padStart(8)} ${`${r.budgetMs} ms`.padStart(9)}`, width)),
    ];
    const start = Math.max(0, Math.min(pick - runRows + 1, runs.length - runRows));
    const rows = runs.slice(start, start + runRows).map((e, i) => {
        const mark = !live && start + i === pick ? ">" : " ";
        const trigger = SHORT[e.trigger ?? ""] ?? e.trigger ?? "-";
        const ms = msText(e.ms ?? 0);
        const lead = ` ${mark} ${clock(e.at)}  ${trigger.padEnd(6)}  ${basename(target(e)).padEnd(14)} `;
        if (e.rules === undefined) {
            const what = older(e) ? (e.outcome === "ran" && e.result === undefined ? "? result and rules not recorded" : `${verdictCell(e)} · rules not recorded`) : `${verdictCell(e)} · ${noRules(e)}`;
            return clip(`${lead}${what} · ${ms}`, width);
        }
        const left = `${lead}${verdictCell(e).padEnd(22)} ${ms.padStart(7)}  `;
        const n = e.guardrails ?? Object.keys(e.rules).length;
        const ratchet = e.ratchet === undefined ? "" : `${count(e.ratchet[0])} → ${count(e.ratchet[1])}${e.ratchetFrom === "uncommitted" ? " uncommitted" : ""}`;
        const counted = `${n} rule${n === 1 ? "" : "s"}`;
        const named = `${counted}: ${Object.keys(e.rules ?? {}).join(" · ")}`;
        const rules = left.length + named.length <= width ? named : counted;
        const line = visible(`${left}${rules}`);
        return ratchet !== "" && line.length + ratchet.length + 2 <= width ? `${line.padEnd(width - ratchet.length)}${ratchet}` : clip(line, width);
    });
    const recent = [spread(" RECENT RUNS", width >= 100 ? "ratchet left" : "", width), ...rows];
    const middle = size.rows - top.length - bottom.length >= 3 ? [...rules, "", ...recent] : [];
    return [...top, ...middle, ...bottom].slice(0, Math.max(size.rows, 2)).map((l) => visible(l).trimEnd());
}
export const BANDS = [
    { name: "DETERMINISTIC", kinds: ["type", "lint", "runtime"] },
    { name: "JUDGMENT", kinds: ["model", "review"] },
    { name: "PROSE", kinds: ["instruction", "legacy"] },
];
const LAYER_TEXT = {
    type: "compiler proves it",
    lint: "static analysis on every edit",
    runtime: "a command or test must pass",
    model: "a model decides",
    review: "a reviewer decides",
    instruction: "told, not checked",
    legacy: "wrapped old check",
};
const DETERMINISTIC = new Set(BANDS[0]?.kinds);
export function renderLayers(model, size) {
    const width = Math.max(20, size.cols);
    const rule = "─".repeat(width);
    const inner = width - 5;
    const boxed = (left, right = "") => ` │ ${spread(left, right, inner).padEnd(inner)} │`;
    const promoted = new Set(model.practices.filter((p) => p.promote).map((p) => p.practice));
    const body = BANDS.flatMap(({ name, kinds }) => [
        ` ┌ ${name} ${"─".repeat(Math.max(0, width - 5 - name.length))}┐`,
        ...kinds.flatMap((kind) => {
            const rules = model.layers.filter((r) => r.kind === kind);
            const proven = kind === "instruction" ? "prose" : rules.length === 0 ? "" : `${rules.length}/${rules.length}`;
            const label = `${kindRank(kind)} ${kind.padEnd(12)}${LAYER_TEXT[kind].padEnd(30)}${rules.length === 0 ? "(none yet)" : ""}`;
            return [
                boxed(label, `${String(rules.length).padStart(5)} ${proven.padStart(6)}`),
                ...rules.map((r) => boxed(`${" ".repeat(4)}${r.pack.padEnd(6)} ${r.guardrail.padEnd(23)} ${r.adapter.padEnd(7)} ${r.runs.join(",").padEnd(12)} ${r.median.padEnd(7)}${promoted.has(r.practice) ? "  ▲ promote" : ""}`)),
            ];
        }),
        ` └${"─".repeat(width - 3)}┘`,
    ]);
    const packs = [
        ...model.packList.filter((p) => p.on).map((p) => `● ${p.id} (${p.source}, ${p.rules} rule${p.rules === 1 ? "" : "s"})`),
        ...model.packList.filter((p) => !p.on).map((p) => `○ ${p.id} (${p.source}, off)`),
        "+ local",
    ].join("   ");
    const weakest = [...model.practices].sort((a, b) => kindRank(b.strongestKind) - kindRank(a.strongestKind))[0];
    const verdict = weakest === undefined || DETERMINISTIC.has(weakest.strongestKind)
        ? " Weakest practice: none. Every practice is held by a deterministic rule."
        : ` Weakest practice: ${weakest.practice}, held only by ${weakest.strongestKind}. Next action: add a type, lint, or runtime Guardrail to ${weakest.practice}`;
    const top = [header(model, ["q quit  r rerun  l runs  v violations  d determinism", "q quit  r rerun  l runs  v viol  d det"], "l runs", width), rule, spread(" LAYERS  strongest first · a rule can only move up", "rules  proven", width - 1)];
    const bottom = [clip(` PACKS   ${packs}`, width), rule, ...wrap(verdict, width, 3)];
    const room = Math.max(0, size.rows - top.length - bottom.length);
    return [...top, ...body.slice(0, room), ...bottom].map((l) => visible(l).trimEnd());
}
const MIN_BAR = 8;
const LEGEND = [" █ baselined, allowed until touched", " ▓ new in the last run, blocking"];
export const packViolations = (model) => {
    const runs = runRecords(model.evidence);
    const baselined = new Map(model.rules.map((r) => [r.guardrail, r.baselined]));
    return model.packs.map((pack) => {
        const ids = model.layers.filter((r) => r.pack === pack).map((r) => r.guardrail);
        const run = runs.filter((e) => ids.some((id) => e.rules?.[id] !== undefined || (e.cachedRules ?? []).includes(id))).at(-1);
        const fresh = (id) => (run === undefined ? undefined : (run.failures ?? []).filter((f) => f.guardrail === id).length);
        const rows = ids.map((id) => ({ label: `  ${id}`, old: baselined.get(id) ?? 0, fresh: fresh(id) }));
        const sum = (xs) => (run === undefined ? undefined : xs.reduce((a, b) => a + (b ?? 0), 0));
        return { label: pack, old: rows.reduce((a, r) => a + r.old, 0), fresh: sum(rows.map((r) => r.fresh)), last: run === undefined ? "" : `${clock(run.at).slice(0, 5)} ${SHORT[run.trigger ?? ""] ?? run.trigger ?? "-"}`, run, rows };
    });
};
export function renderViolations(model, size) {
    const width = Math.max(20, size.cols);
    const rule = "─".repeat(width);
    const runs = runRecords(model.evidence);
    const packs = packViolations(model);
    const newText = (n) => (n === undefined ? "–" : count(n));
    const layout = (guardrails, lastRun) => {
        const rows = packs.flatMap((p) => [p, ...(guardrails ? p.rows.map((r) => ({ ...r, last: "" })) : [])]);
        const oldW = Math.max(9, ...rows.map((r) => count(r.old).length));
        const newW = Math.max(3, ...rows.map((r) => newText(r.fresh).length));
        const lastW = lastRun ? Math.max(8, ...rows.map((r) => r.last.length)) : 0;
        const right = (old, fresh, last) => `  ${old.padStart(oldW)}   ${fresh.padStart(newW)}${lastRun ? `   ${last.padEnd(lastW)}` : ""}`;
        const labelW = Math.max(0, ...rows.map((r) => r.label.length));
        const bar = width - 1 - labelW - 1 - right("", "", "").length;
        return { rows, right, labelW, bar };
    };
    const latest = packs.filter((p) => (p.fresh ?? 0) > 0 && p.run !== undefined).map((p) => p.run).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
    const capped = packs.some((p) => (p.run?.failures ?? []).length >= MAX_RECORDED_FAILURES);
    const next = runs.length === 0 ? ` Next action: ${runCheck(size)}` : latest?.next === undefined ? "" : ` Next action: ${latest.next}`;
    const legend = (width >= LEGEND.join("  ").length ? [LEGEND.join("  ")] : LEGEND).map((l) => clip(l, width));
    const partial = capped ? wrap(` New counts are the first ${MAX_RECORDED_FAILURES} failures a run records.`, width, 2) : [];
    const action = next === "" ? [] : wrap(next, width, 3);
    const bottom = [[rule, ...legend, ...partial, ...action], [rule, ...legend, ...action], [rule, ...action], action].find((b) => 4 + b.length <= size.rows) ?? action;
    const room = Math.max(0, size.rows - 3 - bottom.length);
    const fallback = layout(false, false);
    const chosen = [layout(true, true), layout(false, true), fallback].find((l) => l.bar >= MIN_BAR && l.rows.length <= Math.max(room, packs.length)) ?? { ...fallback, labelW: Math.max(1, fallback.labelW - MIN_BAR + fallback.bar), bar: MIN_BAR };
    const barW = Math.max(1, Math.min(chosen.bar, width - 2 - chosen.labelW - chosen.right("", "", "").length));
    const most = Math.max(0, ...chosen.rows.map((r) => r.old + (r.fresh ?? 0)));
    const scale = most === 0 ? 0 : barW / most;
    const body = chosen.rows.map((r) => {
        const fresh = r.fresh ?? 0;
        const n = fresh === 0 ? 0 : Math.max(1, Math.round(fresh * scale));
        const b = Math.min(r.old === 0 ? 0 : Math.max(1, Math.round(r.old * scale)), barW - n);
        const bar = b + n === 0 ? "▏" : `${"█".repeat(b)}${"▓".repeat(n)}`;
        return clip(`${` ${clip(r.label, chosen.labelW).padEnd(chosen.labelW)} ${bar}`.padEnd(width - chosen.right("", "", "").length)}${chosen.right(count(r.old), newText(r.fresh), r.last)}`, width);
    });
    const top = [header(model, ["q quit  r rerun  v back  d determinism", "q quit  r rerun  v back  d det"], "v back", width), rule, clip(`${" VIOLATIONS BY PACK".padEnd(width - chosen.right("", "", "").length)}${chosen.right("baselined", "new", "last run")}`, width)];
    const kept = body.length > room ? Math.max(0, room - 1) : body.length;
    const hidden = body.length - kept;
    const note = ` ${hidden} pack${hidden === 1 ? "" : "s"} hidden.${action.length === 0 ? " Next action: run warden --violations | cat" : ""}`;
    const shown = hidden > 0 && room > 0 ? [...body.slice(0, kept), clip(note, width)] : hidden > 0 ? [] : body;
    const lines = [...top, ...shown, ...bottom];
    const fitted = lines.length <= size.rows ? lines : [...top.slice(0, Math.max(0, size.rows - action.length)), ...action].slice(0, size.rows);
    return fitted.map((l) => visible(l).trimEnd());
}
const BAND_MARKS = ["█", "▒", "░"];
const UNKNOWN = { name: "unknown", mark: "·" };
const MIN_LABEL = 8;
export const bandCounts = (run) => {
    const kinds = run.kinds ?? { unknown: (run.failures ?? []).length };
    return [...BANDS.map((b) => b.kinds.reduce((n, k) => n + (kinds[k] ?? 0), 0)), kinds.unknown ?? 0];
};
const segments = (counts, scale, barW) => {
    const n = counts.map((c) => (c === 0 ? 0 : Math.max(1, Math.round(c * scale))));
    while (n.reduce((a, b) => a + b, 0) > barW) {
        const smallest = counts.reduce((best, c, i) => ((n[i] ?? 0) > 0 && (best < 0 || c < counts[best]) ? i : best), -1);
        const i = Math.max(...n) > 1 ? n.indexOf(Math.max(...n)) : smallest;
        n[i] = n[i] - 1;
    }
    return n;
};
export function renderDeterminism(model, size) {
    const width = Math.max(20, size.cols);
    const rule = "─".repeat(width);
    const projects = [...model.projects].sort((a, b) => Number(b.project === model.project) - Number(a.project === model.project) || a.project.localeCompare(b.project));
    const rows = projects.map((p) => ({ label: visible(`${p.project === model.project ? "▸" : " "} ${p.project}`), counts: p.run === undefined ? undefined : bandCounts(p.run) }));
    const unknown = rows.some((r) => (r.counts?.[BANDS.length] ?? 0) > 0);
    const names = [...BANDS.map((b) => b.name.toLowerCase()), ...(unknown ? [UNKNOWN.name] : [])];
    const marks = [...BAND_MARKS, UNKNOWN.mark];
    const det = (c) => c[0] ?? 0;
    const known = (c) => c.slice(0, BANDS.length).reduce((a, b) => a + b, 0);
    const shareText = (c) => (c === undefined || known(c) === 0 ? "–" : `${Math.min(Math.round((det(c) / known(c)) * 100), det(c) === known(c) ? 100 : 99)}%`);
    const SHARE = "det. share";
    const labelW = Math.max(0, ...rows.map((r) => r.label.length));
    const layout = (short, share, compact = false, tiny = false) => {
        const heads = tiny ? names.map((n) => n.slice(0, 3)) : short ? names.map((n) => n.slice(0, 5)) : names;
        const shown = (n) => (!compact || n < 10000 ? count(n) : n < 1000000 ? `${Math.floor(n / 1000)}k` : `${(Math.floor(n / 100000) / 10).toFixed(1)}M`);
        const colW = heads.map((name, i) => Math.max(name.length, ...rows.map((r) => (r.counts === undefined ? 0 : shown(r.counts[i] ?? 0).length))));
        const right = (cells, shareCell) => `${cells.map((c, i) => `  ${c.padStart(colW[i])}`).join("")}${share ? `  ${(shareCell ?? "").padStart(SHARE.length)}` : ""}`;
        return { heads, shown, right, rightW: right(heads.map(() => ""), "").length };
    };
    const minLabel = Math.min(labelW, MIN_LABEL);
    const [full, bare, short, compact, tiny] = [layout(false, true), layout(false, false), layout(true, false), layout(true, false, true), layout(true, false, true, true)];
    const candidates = [[full, labelW], [bare, labelW], [bare, minLabel], [short, labelW], [short, minLabel], [compact, minLabel]];
    const { heads, shown: cell, right, rightW } = (candidates.find(([o, l]) => width - 2 - l - o.rightW >= MIN_BAR) ?? [width - compact.rightW >= " DETERMINISM".length ? compact : tiny])[0];
    const shownLabelW = Math.max(Math.min(labelW, MIN_LABEL), Math.min(labelW, width - 2 - rightW - MIN_BAR));
    const barW = Math.max(1, width - 2 - shownLabelW - rightW);
    const most = Math.max(0, ...rows.map((r) => (r.counts === undefined ? 0 : r.counts.reduce((a, b) => a + b, 0))));
    const scale = most === 0 ? 0 : barW / most;
    const body = rows.map((r) => {
        const lead = ` ${clip(r.label, shownLabelW).padEnd(shownLabelW)} `;
        if (r.counts === undefined)
            return clip(`${lead}no completed run yet`, width);
        const n = segments(r.counts.slice(0, names.length), scale, barW);
        const bar = n.every((x) => x === 0) ? "▏" : n.map((x, i) => marks[i].repeat(x)).join("");
        return clip(`${`${lead}${bar}`.padEnd(width - rightW)}${right(names.map((_, i) => cell(r.counts?.[i] ?? 0)), shareText(r.counts))}`, width);
    });
    const nonDet = rows.flatMap((r) => (r.counts === undefined ? [] : [{ label: r.label.slice(2), n: known(r.counts) - det(r.counts), total: r.counts.reduce((a, b) => a + b, 0) }])).sort((a, b) => b.n - a.n)[0];
    const ran = rows.some((r) => r.counts !== undefined);
    const verdict = !ran
        ? ` No project has a completed run. Next action: ${runCheck(size)}`
        : nonDet === undefined || nonDet.n === 0
            ? " No project has a judgment or prose failure in its last completed run."
            : ` Most non-deterministic failures: ${nonDet.label}, ${count(nonDet.n)} of ${count(nonDet.total)} in its last completed run.`;
    const legend = names.map((name, i) => `${marks[i]} ${name}`).reduce((lines, item) => {
        const last = lines.at(-1);
        return last !== undefined && last.length + 3 + item.length <= width ? [...lines.slice(0, -1), `${last}   ${item}`] : [...lines, ` ${item}`];
    }, []);
    const fixed = 4 + legend.length;
    const hiddenText = (n) => ` ${n} project${n === 1 ? "" : "s"} hidden. Next action: run warden --determinism | cat`;
    const fits = fixed + wrap(verdict, width, 3).length + body.length <= size.rows;
    const hiddenLines = fits ? 0 : wrap(hiddenText(body.length), width, 3).length;
    const verdictLines = wrap(verdict, width, fits ? 3 : Math.min(3, Math.max(1, size.rows - fixed - 1 - hiddenLines)));
    const bottom = [rule, ...legend.map((l) => clip(l, width)), ...verdictLines];
    const top = [header(model, ["q quit  r rerun  d back", "q quit  r rerun  d back"], "d back", width), rule, clip(`${(width - rightW > " DETERMINISM BY PROJECT".length ? " DETERMINISM BY PROJECT" : " DETERMINISM").padEnd(width - rightW)}${right(heads, SHARE)}`, width)];
    const kept = fits ? body.length : Math.max(1, size.rows - top.length - bottom.length - hiddenLines);
    const hidden = body.length - kept;
    const shown = hidden > 0 ? [...body.slice(0, kept), ...wrap(hiddenText(hidden), width, 3)] : body;
    return [...top, ...shown, ...bottom].map((l) => visible(l).trimEnd());
}
const plain = (lines) => `${lines.join("\n")}\n`;
export const plainDeterminism = (model, cols = 80) => plain(renderDeterminism(model, { plain: true, cols, rows: 200 }));
export const plainViolations = (model, cols = 80) => plain(renderViolations(model, { plain: true, cols, rows: 200 }));
export const plainLayers = (model, cols = 80) => plain(renderLayers(model, { plain: true, cols, rows: 60 }));
export const plainView = (model, cols = 80) => plain(render(model, { plain: true, cols, rows: 40 }, 0));
export const ENTER = "\x1b[?1049h\x1b[?25l";
export const LEAVE = "\x1b[?25h\x1b[?1049l";
const HOME = "\x1b[H\x1b[2J";
const SCREEN_KEYS = new Map([
    ["l", "layers"],
    ["v", "violations"],
    ["d", "determinism"],
]);
export function liveView(io) {
    return new Promise((resolve, reject) => {
        let model;
        let selected = 0;
        let screen = io.screen ?? "runs";
        let closed = false;
        let watcher;
        let timer;
        const restore = () => {
            if (closed)
                return;
            closed = true;
            watcher?.close();
            clearTimeout(timer);
            io.output.off("resize", draw);
            io.input.off("data", key);
            process.off("exit", restore);
            process.off("SIGTERM", quit);
            process.off("SIGHUP", quit);
            io.input.setRawMode?.(false);
            io.input.pause();
            io.output.write(LEAVE);
        };
        const fail = (cause) => {
            restore();
            reject(cause instanceof Error ? cause : new Error(String(cause)));
        };
        const quit = () => {
            restore();
            resolve(0);
        };
        function draw() {
            if (closed || model === undefined)
                return;
            try {
                const size = { cols: io.output.columns || 80, rows: io.output.rows || 24 };
                const lines = screen === "layers" ? renderLayers(model, size) : screen === "violations" ? renderViolations(model, size) : screen === "determinism" ? renderDeterminism(model, size) : render(model, size, selected);
                io.output.write(`${HOME}${lines.join("\n")}`);
            }
            catch (cause) {
                fail(cause);
            }
        }
        let loading = false;
        let again = false;
        const refresh = () => {
            if (loading) {
                again = true;
                return;
            }
            loading = true;
            io.load().then((next) => {
                loading = false;
                if (again) {
                    again = false;
                    refresh();
                    return;
                }
                model = next;
                draw();
                schedule();
            }, fail);
        };
        const schedule = () => {
            clearTimeout(timer);
            const at = model === undefined ? undefined : liveDeadline(model);
            if (at !== undefined)
                timer = setTimeout(refresh, Math.max(0, at - Date.now()) + 1);
        };
        function key(chunk) {
            const k = chunk.toString("utf8");
            if (k === "q" || k === "\x03")
                return quit();
            if (k === "r")
                return io.rerun();
            const to = SCREEN_KEYS.get(k);
            if (to !== undefined) {
                screen = screen === to ? "runs" : to;
                return draw();
            }
            const runs = model === undefined ? 0 : runRecords(model.evidence).length;
            if (k === "\x1b[A")
                selected = Math.max(0, selected - 1);
            else if (k === "\x1b[B")
                selected = Math.min(Math.max(0, runs - 1), selected + 1);
            else
                return;
            draw();
        }
        process.once("exit", restore);
        process.once("SIGTERM", quit);
        process.once("SIGHUP", quit);
        io.output.write(ENTER);
        io.input.setRawMode?.(true);
        io.input.resume();
        io.input.on("data", key);
        io.output.on("resize", draw);
        try {
            watcher = watch(io.watchDir, (_event, filename) => {
                if (filename === null || filename === io.file || (screen === "determinism" && filename.endsWith(".jsonl")))
                    refresh();
            });
        }
        catch (cause) {
            fail(cause);
            return;
        }
        refresh();
    });
}
