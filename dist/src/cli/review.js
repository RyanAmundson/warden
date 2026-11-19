import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadRecords } from "../records/load.js";
import { reviewAdapters } from "../review/adapter.js";
import { exitCode, touchedLines, triage } from "../review/findings.js";
const FLAGS = [["capability", "--capability <id>"], ["base", "--base <ref>"], ["head", "--head <ref>"]];
export function reviewOptions(sub, raw) {
    const missing = FLAGS.filter(([k]) => raw[k] === undefined).map(([, f]) => f);
    if (sub === "brief" && (raw.requirements ?? []).length === 0)
        missing.push("--requirements <paths...>");
    if (sub === "triage" && raw.report === undefined)
        missing.push("--report <file>");
    if (missing.length > 0)
        throw new Error(`warden review ${sub} needs ${missing.join(", ")}. Next action: run warden review ${sub} again with ${missing.join(", ")}`);
    if (raw.previous !== undefined && raw.previousReport !== undefined)
        throw new Error("--previous and --previous-report both give the previous findings. Next action: run the command again with only one of them");
    if (sub === "triage" && raw.previousHead !== undefined && raw.previousReport === undefined)
        throw new Error("--previous-head needs --previous-report. Next action: run the command again with --previous-report <file>, the previous round's report");
    if ((raw.previous !== undefined || raw.previousReport !== undefined) && raw.previousHead === undefined)
        throw new Error("--previous and --previous-report need --previous-head. Next action: run the command again with --previous-head <ref>, the head the previous review covered");
    return { requirements: [], format: "text", ...raw };
}
const resolveRef = (root, ref) => {
    try {
        return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    }
    catch (cause) {
        if (typeof cause.status !== "number")
            throw new Error("git is not available. Next action: install git and put it on PATH, then run the command again");
        throw new Error(`${ref} is not a commit. Next action: run git fetch origin ${ref}, then run the command again`);
    }
};
const readFile = (path) => {
    try {
        return readFileSync(path, "utf8");
    }
    catch {
        throw new Error(`${path} cannot be read. Next action: save the reviewer's report to ${path}, then run the command again`);
    }
};
const quote = (v) => (/^[\w./@%+=:,-]+$/.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`);
const briefLine = (o, base, r) => [
    `warden review brief --capability ${o.capability} --base ${base} --head ${r.head}`,
    ...(r.previousHead === undefined ? [] : [`--previous-head ${r.previousHead}`]),
    ...(r.previousReport === undefined ? [] : [`--previous-report ${quote(r.previousReport)}`]),
    `--requirements ${o.requirements.map(quote).join(" ")}`,
].join(" ");
async function prepare(root, wardenRoot, o) {
    const set = await loadRecords(root, wardenRoot);
    const capabilities = set.packs.flatMap((p) => p.capabilities);
    const capability = capabilities.find((c) => c.id === o.capability && c.review !== undefined);
    const base = resolveRef(root, o.base);
    const head = resolveRef(root, o.head);
    if (capability === undefined) {
        const ids = capabilities.filter((c) => c.review !== undefined).map((c) => c.id);
        const why = capabilities.some((c) => c.id === o.capability) ? `Capability ${o.capability} has no review block` : `no Capability has id ${o.capability}`;
        if (ids.length === 0)
            throw new Error(`${why}. Next action: add a review block to a Capability in a pack, then run warden compile`);
        if (o.requirements.length === 0)
            throw new Error(`${why}. Next action: run the command again with --capability ${ids[0]} and --requirements <paths...>`);
        throw new Error(`${why}. Next action: run ${briefLine({ ...o, capability: ids[0] }, base, { head, previousHead: o.previousHead, previousReport: o.previousReport })}`);
    }
    const adapter = reviewAdapters.get(capability.review.adapter);
    if (adapter === undefined)
        throw new Error(`no review adapter has id ${capability.review.adapter}. Next action: set the review adapter of Capability ${capability.id} to one of ${[...reviewAdapters.keys()].join(", ")}, then run warden compile`);
    const practices = set.packs.flatMap((p) => p.practices);
    const previousHead = o.previousHead === undefined ? undefined : resolveRef(root, o.previousHead);
    const scope = {
        base,
        head,
        requirements: o.requirements,
        upholds: capability.upholds.map((id) => ({ id, statement: practices.find((p) => p.id === id)?.statement ?? id })),
        ...(previousHead === undefined ? {} : { previousHead }),
    };
    return { capability, adapter, scope, previousHead };
}
const sameShape = (f) => typeof f === "object" && f !== null && typeof f.n === "number" && typeof f.title === "string";
export async function runBrief(root, wardenRoot, o) {
    const { capability, adapter, scope, previousHead } = await prepare(root, wardenRoot, o);
    if (o.previous !== undefined) {
        const text = readFile(o.previous);
        try {
            const findings = JSON.parse(text).findings;
            if (!Array.isArray(findings) || !findings.every(sameShape))
                throw new Error("shape");
            scope.previous = findings;
        }
        catch {
            throw new Error(`${o.previous} is not a triage result. Next action: save the reviewer's triage --format json output to ${o.previous}, then run the command again`);
        }
    }
    if (o.previousReport !== undefined) {
        const earlier = { ...scope, head: previousHead };
        scope.previous = triage(adapter.normalize(readFile(o.previousReport), earlier).findings, touchedLines(root, scope.base, earlier.head), 1, "").findings;
    }
    process.stdout.write(`${JSON.stringify(adapter.invocation(capability.review, scope), null, 2)}\n`);
    return 0;
}
const label = (f) => (f.blocks ? "BLOCK" : f.kind === "env" ? "ENV" : f.kind === "flake" ? "RERUN" : "TASK");
export async function runTriage(root, wardenRoot, o) {
    const { adapter, scope, previousHead } = await prepare(root, wardenRoot, o);
    const normalized = adapter.normalize(readFile(o.report), scope);
    const touched = touchedLines(root, previousHead ?? scope.base, scope.head);
    const round = previousHead === undefined ? 1 : 2;
    const retry = briefLine(o, scope.base, { head: scope.head, previousHead, previousReport: o.previousReport });
    const afterFix = briefLine(o, scope.base, { head: "HEAD", previousHead: scope.head, previousReport: o.report });
    const result = triage(normalized.findings, touched, round, retry, afterFix);
    if (result.verdict !== "pass" && o.requirements.length === 0)
        throw new Error("the rerun command needs the requirements. Next action: run warden review triage again with --requirements <paths...>");
    if (o.format === "json")
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
        for (const f of result.findings)
            process.stdout.write(`${label(f)} ${f.n} ${f.kind} ${f.file === undefined ? "-" : `${f.file}${f.line === undefined ? "" : `:${f.line}`}`}  ${f.title}\n`);
        if (result.next !== null)
            process.stdout.write(`Next action: ${result.next}\n`);
    }
    return exitCode(result);
}
