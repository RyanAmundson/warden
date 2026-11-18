import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { PARSE_ERROR } from "../adapters/types.js";
import { runGuardrails } from "./run.js";
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
const projectFiles = (root, globs) => {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
    return out
        .split("\0")
        .filter((f) => f !== "" && existsSync(join(root, f)) && statSync(join(root, f)).isFile() && globs.some((g) => matchesGlob(f, g)));
};
export async function measureBaseline(set, guardrails) {
    const files = projectFiles(set.root, set.config.packs.flatMap((p) => p.paths));
    const results = files.length === 0 || guardrails.length === 0 ? [] : await runGuardrails(set, guardrails, files, { root: set.root, generatedDir: join(set.root, ".warden/generated"), unbudgeted: true });
    const unparsed = results.filter((r) => r.guardrail === PARSE_ERROR).flatMap((r) => r.violations.map((v) => `${v.file}:${v.line}`));
    const baseline = {};
    for (const r of results) {
        if (r.guardrail === PARSE_ERROR)
            continue;
        for (const v of r.violations) {
            const entries = (baseline[r.guardrail] ??= {});
            entries[v.file] = (entries[v.file] ?? 0) + 1;
        }
    }
    return { baseline, files: files.length, unparsed };
}
