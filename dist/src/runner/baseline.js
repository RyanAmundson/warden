import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PARSE_ERROR } from "../adapters/types.js";
export const BASELINE_PATH = ".warden/baseline.json";
export function readBaseline(root) {
    try {
        return JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8"));
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return {};
        throw cause;
    }
}
export const projectWideEntries = (b) => Object.keys(b).filter((g) => "" in b[g]);
export function writeBaseline(root, b) {
    const projectWide = projectWideEntries(b);
    if (projectWide.length > 0)
        throw new Error(`refusing to baseline project-wide failures of ${projectWide.join(", ")}`);
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(b, null, 2)}\n`);
}
export function carryRenames(b, renames) {
    const out = {};
    for (const [g, entries] of Object.entries(b)) {
        const carried = { ...entries };
        for (const [from, to] of renames) {
            if (carried[from] === undefined || carried[to] !== undefined)
                continue;
            carried[to] = carried[from];
            delete carried[from];
        }
        out[g] = carried;
    }
    return out;
}
export function applyBaseline(results, baseline, scanned, existing, touched = () => false) {
    const next = {};
    for (const [g, entries] of Object.entries(baseline)) {
        next[g] = Object.fromEntries(Object.entries(entries).filter(([f]) => existing(f)));
    }
    const failures = [];
    const parseErrors = results.filter((r) => r.guardrail === PARSE_ERROR).flatMap((r) => r.violations);
    const unparsed = new Set(parseErrors.map((v) => v.file));
    failures.push(...parseErrors.filter((v) => scanned.includes(v.file)));
    delete next[PARSE_ERROR];
    for (const r of results) {
        if (r.status === "killed" || r.guardrail === PARSE_ERROR)
            continue;
        const byFile = new Map(scanned.filter((f) => !unparsed.has(f)).map((f) => [f, []]));
        failures.push(...r.violations.filter((v) => v.file === ""));
        for (const v of r.violations)
            byFile.get(v.file)?.push(v);
        const entries = next[r.guardrail] ?? {};
        for (const [file, all] of byFile) {
            failures.push(...all.filter(touched));
            const vs = all.filter((v) => !touched(v));
            if (vs.length > (entries[file] ?? 0))
                failures.push(...vs);
            else if (vs.length === 0)
                delete entries[file];
            else
                entries[file] = vs.length;
        }
        next[r.guardrail] = entries;
    }
    for (const [g, entries] of Object.entries(next))
        if (Object.keys(entries).length === 0)
            delete next[g];
    return { failures, next };
}
