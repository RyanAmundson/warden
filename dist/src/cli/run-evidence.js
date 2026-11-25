import { runRecords } from "./runs.js";
const findingKey = ({ guardrail, file }) => JSON.stringify([guardrail, file]);
const sourceRoot = (run) => run.root ?? run.attemptedRoot;
const sourceOf = (run) => ({ run: run.run, at: run.at, root: sourceRoot(run), tier: run.tier, trigger: run.trigger, ref: run.ref });
const audit = (run) => ["main audit", "audit", "continuous audit"].some((trigger) => trigger === run.trigger);
function firedByRun(evidence) {
    const fired = new Map();
    for (const event of evidence) {
        if (event.kind !== "fired" || event.status !== "fail" || event.run === undefined)
            continue;
        const events = fired.get(event.run) ?? [];
        events.push(event);
        fired.set(event.run, events);
    }
    return fired;
}
function findingsOf(run, fired) {
    const recorded = run.failures ?? [];
    const keys = new Set(recorded.map(findingKey));
    const additional = [];
    for (const { guardrail, file } of fired) {
        if (guardrail === undefined || file === undefined)
            continue;
        const key = findingKey({ guardrail, file });
        if (keys.has(key))
            continue;
        keys.add(key);
        additional.push({ guardrail, file });
    }
    return [...recorded, ...additional];
}
export function runEvidence(evidence, id, limit) {
    const runs = runRecords(evidence);
    const index = runs.findIndex((run) => run.run === id);
    const run = runs[index];
    if (run === undefined)
        return undefined;
    const events = evidence.filter((event) => event.run === id);
    return {
        runs: runs.slice(Math.max(0, index - limit + 1), index + 1).reverse(),
        findings: findingsOf(run, firedByRun(events).get(id) ?? []),
        steps: events.filter((event) => event.kind === "step").map(({ at, step, state, ms }) => ({ at, step, state, ms })),
    };
}
export function projectFailures(evidence, roots) {
    const fired = firedByRun(evidence);
    const runs = runRecords(evidence).filter((run) => {
        const root = sourceRoot(run);
        return root === undefined || roots.includes(root);
    });
    const included = new Set(runs);
    const open = new Map();
    const audits = new Map();
    const attempts = new Map();
    const keyOf = (root, tier, finding) => JSON.stringify([root, tier, findingKey(finding)]);
    for (const event of evidence) {
        if (event.kind === "resolved" && event.file !== undefined && event.guardrail !== undefined && event.sourceRun !== undefined) {
            const key = keyOf(event.root, event.tier, { file: event.file, guardrail: event.guardrail });
            const current = open.get(key)?.[0];
            if (current?.source.run === event.sourceRun && current.policy === event.policy)
                open.delete(key);
        }
        if (event.kind === "coverage") {
            const covered = new Set(event.members);
            for (const [key, [finding]] of open) {
                if (finding?.unverified && finding.source.root === event.root && finding.source.tier === event.tier && covered.has(finding.guardrail))
                    open.delete(key);
            }
        }
        if (!included.has(event) || event.outcome === "empty")
            continue;
        const source = sourceOf(event);
        const events = event.run === undefined ? [] : fired.get(event.run) ?? [];
        const findings = findingsOf(event, events);
        const scope = JSON.stringify([source.root, source.trigger, source.tier, source.ref]);
        attempts.set(scope, { run: event, findingCount: findings.length });
        if (event.outcome !== "ran")
            continue;
        if (audit(event)) {
            audits.set(scope, findings.map((finding) => ({ ...finding, source })));
            continue;
        }
        const policies = new Map(events.flatMap(({ file, guardrail, policy }) => file === undefined || guardrail === undefined ? [] : [[findingKey({ file, guardrail }), policy]]));
        const groups = new Map();
        for (const finding of findings) {
            const key = keyOf(source.root, source.tier, finding);
            const group = groups.get(key) ?? [];
            const policy = policies.get(findingKey(finding));
            group.push({ ...finding, source, policy, ...(policy === undefined ? { unverified: true } : {}) });
            groups.set(key, group);
        }
        for (const [key, group] of groups)
            open.set(key, group);
    }
    const findings = [...open.values(), ...audits.values()].flat()
        .sort((a, b) => b.source.at.localeCompare(a.source.at))
        .map(({ policy: _policy, ...finding }) => finding);
    const problems = [...attempts.values()]
        .filter(({ run, findingCount }) => run.outcome !== "ran" || run.alert !== undefined || (run.result !== "pass" && findingCount === 0))
        .map(({ run }) => run)
        .sort((a, b) => b.at.localeCompare(a.at));
    return { checked: runs.length > 0, findings, problems };
}
