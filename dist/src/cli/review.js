import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { wardenVersion } from "../compiler/compile.js";
import { sha256 } from "../compiler/lock.js";
import { loadRecords } from "../records/load.js";
import { reviewAdapters } from "../review/adapter.js";
import { codeReview, codeReviewBase, isPullRequestUrl } from "../review/code-review.js";
import { exitCode, touchedLines, triage } from "../review/findings.js";
import { getRound, listRounds, recordReviewerError, recordRound, reviewSignals, reviewState } from "../review/history.js";
import { isAncestor } from "../runner/changed.js";
const FLAGS = [["capability", "--capability <id>"], ["base", "--base <ref>"], ["head", "--head <ref>"]];
export function reviewOptions(sub, raw) {
    const missing = FLAGS.filter(([k]) => raw[k] === undefined).map(([, f]) => f);
    if (sub !== "triage" && (raw.requirements ?? []).length === 0)
        missing.push("--requirements <paths...>");
    if (sub !== "brief" && raw.report === undefined)
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
        return execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
    ...(o.pullRequest === undefined ? [] : [`--pull-request ${quote(o.pullRequest)}`]),
    ...(o.component === undefined ? [] : [`--component ${quote(o.component)}`]),
    ...(r.previousHead === undefined ? [] : [`--previous-head ${r.previousHead}`]),
    ...(r.previousReport === undefined ? [] : [`--previous-report ${quote(r.previousReport)}`]),
    `--requirements ${o.requirements.map(quote).join(" ")}`,
].join(" ");
async function prepare(root, wardenRoot, o, diffMode = "no-untracked") {
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
    if (adapter.id === "component-quality" && !/^[\w$.-]+$/.test(o.component ?? "")) {
        throw new Error("The component-quality adapter needs a component name. Next action: run the command again with --component <name>");
    }
    if (adapter === codeReview && !isPullRequestUrl(o.pullRequest)) {
        throw new Error("The code-review adapter needs a GitHub pull request URL. Next action: run the command again with --pull-request https://github.com/<owner>/<repo>/pull/<number>");
    }
    const committedDiffs = new Map();
    const committedChanges = (from, to) => {
        const key = `${from}..${to}`;
        const previous = committedDiffs.get(key);
        if (previous !== undefined)
            return previous;
        const changed = touchedLines(root, from, to, diffMode);
        committedDiffs.set(key, changed);
        return changed;
    };
    const scope = {
        base,
        head,
        requirements: o.requirements,
        upholds: capability.upholds.map((id) => ({ id, statement: practices.find((p) => p.id === id)?.statement ?? id })),
        ...(previousHead === undefined ? {} : { previousHead }),
        ...(adapter !== codeReview || o.pullRequest === undefined ? {} : {
            pullRequest: o.pullRequest,
            committedChanges,
        }),
        ...(adapter.id !== "component-quality" || o.component === undefined ? {} : {
            component: { name: o.component, root },
            resolveCommit: (abbreviation) => resolveRef(root, abbreviation),
        }),
    };
    return { capability, adapter, scope, previousHead };
}
const sameShape = (f) => typeof f === "object" && f !== null && typeof f.n === "number" && typeof f.title === "string";
const previousFindings = (root, adapter, scope, head, report) => {
    const text = readFile(report);
    const reportedBase = adapter === codeReview ? codeReviewBase(text) : undefined;
    const base = reportedBase === undefined ? scope.base : resolveRef(root, reportedBase);
    if (adapter === codeReview && !isAncestor(root, base, head)) {
        throw new Error(`${report} names a base outside the previous head's history. Next action: confirm the report's pull request merge base, then run the brief again.`);
    }
    const normalized = adapter.normalize(text, { ...scope, base, head });
    if (normalized.reviewedHead !== head || normalized.findings.some(({ severity, flaky }) => severity === "environment" || flaky)) {
        throw new Error(`${report} does not contain a completed review of ${head}. Next action: pass --previous-report with a completed review of ${head}.`);
    }
    return normalized.findings;
};
export async function runBrief(root, wardenRoot, o) {
    const { capability, adapter, scope, previousHead } = await prepare(root, wardenRoot, o);
    if (scope.component !== undefined &&
        (resolveRef(root, "HEAD") !== scope.head || execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "")) {
        throw new Error(`Component Quality needs a clean checkout at ${scope.head}. Next action: run the brief from a clean worktree at that commit`);
    }
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
        scope.previous = previousFindings(root, adapter, scope, previousHead, o.previousReport);
    }
    const invocation = adapter.invocation(capability.review, scope);
    if (invocation.tool === "Workflow" && !existsSync(invocation.input.scriptPath)) {
        throw new Error(`No Component Quality workflow at ${invocation.input.scriptPath}. Next action: install the component-quality skill and rerun the brief`);
    }
    process.stdout.write(`${JSON.stringify(invocation, null, 2)}\n`);
    return 0;
}
const label = (f) => (f.blocks ? "BLOCK" : f.kind === "env" ? "ENV" : f.kind === "flake" ? "RERUN" : "TASK");
export async function runTriage(root, wardenRoot, o) {
    const { adapter, scope, previousHead } = await prepare(root, wardenRoot, o);
    if (previousHead !== undefined && o.previousReport !== undefined) {
        scope.previous = previousFindings(root, adapter, scope, previousHead, o.previousReport);
    }
    const normalized = adapter.normalize(readFile(o.report), scope);
    const from = previousHead ?? scope.base;
    const touched = scope.committedChanges?.(from, scope.head) ?? touchedLines(root, from, scope.head);
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
function seriesKey(root, o) {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trimEnd();
    if (o.series.trim() === "" || o.target.trim() === "") {
        throw new Error("Series and target names must be nonempty. Next action: supply the controller's change ID and review target.");
    }
    return { repository: realpathSync(common), series: o.series, target: o.target, capability: o.capability };
}
const roundSummary = (round) => ({
    id: round.id,
    number: round.number,
    previous: round.input.previous,
    base: round.input.base,
    head: round.input.head,
    ...round.result,
});
const printRecord = (value) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};
export function runReviewHistory(root, o) {
    const key = seriesKey(root, o);
    if (o.round === undefined) {
        const rounds = listRounds(key).map(reviewState);
        printRecord(rounds.map((state, index) => ({ ...roundSummary(state.round), signals: reviewSignals(state, rounds[index - 1]) })));
    }
    else {
        printRecord(getRound(key, o.round));
    }
    return 0;
}
export function runReviewRule(root, o) {
    const round = getRound(seriesKey(root, o), o.round);
    const finding = /^[1-9]\d*$/.test(o.finding) ? Number(o.finding) : NaN;
    const actor = o.actor.trim();
    const reason = o.reason.trim();
    const evidence = o.evidence.trim();
    if (actor === "" || reason === "" || evidence === "") {
        throw new Error("A review ruling needs an actor, reason and evidence. Next action: supply nonempty --actor, --reason and --evidence values.");
    }
    if (!round.result.findings.some(({ n }) => n === finding)) {
        throw new Error(`Round ${round.id} has no finding ${o.finding}. Next action: run warden review history for this series and select an existing finding number.`);
    }
    printRecord(recordReviewerError(round, { finding, role: o.role, actor, reason, evidence }));
    return 0;
}
export async function runReviewRecord(root, wardenRoot, o, options) {
    const { adapter, capability, scope } = await prepare(root, wardenRoot, o, "commits");
    const key = seriesKey(root, { ...options, capability: capability.id });
    const previous = options.previousRound === undefined ? undefined : getRound(key, options.previousRound);
    if (previous !== undefined) {
        scope.previousHead = previous.input.head;
        scope.previous = previous.result.findings;
    }
    const reportPath = o.report;
    let bytes;
    try {
        bytes = readFileSync(reportPath);
    }
    catch {
        throw new Error(`${reportPath} cannot be read. Next action: save the reviewer's report to ${reportPath} and rerun warden review record.`);
    }
    let report;
    try {
        report = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    catch {
        throw new Error(`${reportPath} is not UTF-8. Next action: save the native report as UTF-8 and rerun warden review record.`);
    }
    const normalized = adapter.normalize(report, scope);
    const from = scope.previousHead ?? scope.base;
    const touched = scope.committedChanges?.(from, scope.head) ?? touchedLines(root, from, scope.head, "commits");
    const rerun = "rerun warden review record with the completed report";
    const number = (previous?.number ?? 0) + 1;
    const result = triage(normalized.findings, touched, number, rerun);
    if (result.verdict === "operational") {
        printRecord(result);
        return 2;
    }
    if (normalized.reviewedHead !== scope.head) {
        throw new Error(`The report must cover ${scope.head}. Next action: save the report on that commit and rerun warden review record.`);
    }
    const findingNumbers = normalized.findings.map((finding) => finding.n);
    if (new Set(findingNumbers).size !== findingNumbers.length ||
        findingNumbers.some((n) => !Number.isSafeInteger(n) || n < 1) ||
        normalized.findings.some((finding) => finding.earlier !== undefined && !previous?.result.findings.some(({ n }) => n === finding.earlier))) {
        throw new Error("The report has invalid finding numbers or a missing earlier finding. Next action: correct the finding references and rerun warden review record.");
    }
    const priorState = previous === undefined ? undefined : reviewState(previous);
    const state = recordRound({
        input: {
            ...key,
            previous: previous?.id ?? null,
            base: scope.base,
            head: scope.head,
            warden: await wardenVersion(wardenRoot),
            settings: capability.review,
            upholds: scope.upholds,
            requirements: o.requirements.map((path) => ({
                path: relative(root, resolve(path)),
                sha256: sha256(readFileSync(path)),
            })),
            report: { sha256: sha256(bytes), text: report },
            ...(o.pullRequest === undefined ? {} : { pullRequest: o.pullRequest }),
            ...(o.component === undefined ? {} : { component: o.component }),
        },
        result: { verdict: result.verdict, findings: result.findings },
    }, previous);
    printRecord({ ...roundSummary(state.round), signals: reviewSignals(state, priorState) });
    return exitCode(result);
}
