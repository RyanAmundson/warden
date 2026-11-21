import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expectedOutputs } from "../compiler/compile.js";
import { LOCK_PATH, canonicalJson, readLock, sha256 } from "../compiler/lock.js";
import { RecordError, loadRecords } from "../records/load.js";
import { listDisputeRulings } from "../runner/disputes.js";
import { readEvidence } from "../runner/evidence.js";
import { listRepositoryEscapeRounds, listRepositoryRounds, reviewHistoryState, reviewRepository, reviewState } from "./history.js";
const guardrailKey = (pack, guardrail) => JSON.stringify([pack, guardrail]);
export async function retainedMutations(set, wardenRoot, recorded) {
    const { root } = set;
    const measurements = recorded.filter((event) => (event.kind === "mutation" || event.kind === "hollow") && event.root === root && event.mutations !== undefined &&
        event.pack !== undefined && event.guardrail !== undefined);
    let currentPolicy;
    let mutationPolicyIssue;
    if (measurements.length > 0 && existsSync(join(root, LOCK_PATH))) {
        try {
            const actual = canonicalJson(readLock(root));
            const expected = await expectedOutputs(set, root, wardenRoot);
            if (actual === canonicalJson(expected.lock))
                currentPolicy = sha256(actual);
        }
        catch (error) {
            if (!(error instanceof RecordError || error instanceof SyntaxError))
                throw error;
            mutationPolicyIssue = error.message;
        }
    }
    const measuredGuardrails = new Set(measurements.map(({ pack, guardrail }) => JSON.stringify([pack, guardrail])));
    const strength = new Map();
    for (const event of measurements) {
        const { at, policy, pack, guardrail, mutations } = event;
        if (policy !== undefined && policy === currentPolicy && mutations !== undefined && pack !== undefined && guardrail !== undefined) {
            strength.set(guardrailKey(pack, guardrail), { at, policy, mutations });
        }
    }
    return { strength, measuredGuardrails, mutationPolicyIssue };
}
function independentOccurrences(events) {
    const parents = events.map((_, index) => index);
    const owner = new Map();
    const find = (index) => {
        let root = index;
        while (parents[root] !== root)
            root = parents[root];
        while (index !== root) {
            const next = parents[index];
            parents[index] = root;
            index = next;
        }
        return root;
    };
    for (const [index, { head, series }] of events.entries()) {
        for (const key of [`head:${head}`, `series:${series}`]) {
            const prior = owner.get(key);
            if (prior === undefined)
                owner.set(key, index);
            else
                parents[find(index)] = find(prior);
        }
    }
    const distinct = new Set();
    return events.filter((_, index) => {
        const root = find(index);
        if (distinct.has(root))
            return false;
        distinct.add(root);
        return true;
    });
}
export function recurringReviewProposals(set, repository) {
    const minimum = set.config.learning?.repeatFindings;
    if (minimum === undefined)
        return [];
    const practices = new Map(set.packs.flatMap((pack) => pack.practices.map(({ id, statement }) => [id, statement])));
    const groups = new Map();
    const normalize = (value) => value.trim().replace(/\s+/g, " ");
    const rounds = listRepositoryRounds(repository).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
    for (const round of rounds) {
        const { head, series, target, capability, upholds, report } = round.input;
        const [upheld] = upholds;
        if (upholds.length !== 1 || upheld === undefined || practices.get(upheld.id) !== upheld.statement)
            continue;
        for (const finding of reviewState(round).active) {
            if (!finding.blocks || finding.file === undefined || finding.earlier !== undefined ||
                !finding.reproducesOn.includes("head") || finding.reproducesOn.includes("base"))
                continue;
            const title = normalize(finding.title);
            const correction = normalize(finding.correction);
            if (title === "" || correction === "")
                continue;
            const key = canonicalJson([upheld.id, title, correction]);
            const group = groups.get(key) ?? { practice: upheld.id, title, correction, occurrences: [] };
            group.occurrences.push({ head, series, target, capability, round: round.id, finding: finding.n, report: report.sha256 });
            groups.set(key, group);
        }
    }
    return [...groups.values()]
        .map((group) => ({ ...group, occurrences: independentOccurrences(group.occurrences) }))
        .filter(({ occurrences }) => occurrences.length >= minimum)
        .map(({ practice, title, correction, occurrences }) => ({
        action: "add", practice, evidence: [{ kind: "recurring-review-finding", title, correction, occurrences }],
    }));
}
export async function learningEditProposals(set, wardenRoot) {
    const { project } = set.config;
    const disputes = new Map();
    for (const ruling of listDisputeRulings(project, set.root)) {
        if (ruling.status !== "upheld")
            continue;
        const key = guardrailKey(ruling.pack, ruling.guardrail);
        const group = disputes.get(key) ?? [];
        group.push(ruling);
        disputes.set(key, group);
    }
    const { strength, mutationPolicyIssue } = await retainedMutations(set, wardenRoot, readEvidence(project));
    const edit = set.packs.flatMap((pack) => pack.practices.flatMap((practice) => practice.guardrails.flatMap((guardrail) => {
        const key = guardrailKey(pack.id, guardrail.id);
        const evidence = (disputes.get(key) ?? [])
            .map(({ dispute, role, actor, reason, evidence, file, at }) => ({ kind: "upheld-dispute", dispute, role, actor, reason, evidence, file, at }));
        const measurement = strength.get(key);
        const hollow = measurement !== undefined && measurement.mutations.missed.length > 0
            ? [{ kind: "hollow-mutation", ...measurement }]
            : [];
        const signals = [...evidence, ...hollow];
        if (signals.length === 0)
            return [];
        return [{ action: "edit", pack: pack.id, practice: practice.id, guardrail: guardrail.id, evidence: signals }];
    })));
    return { edit, mutationPolicyIssue };
}
export async function learningRemovalProposals(set, wardenRoot, addPractices) {
    const minimum = set.config.learning?.removalRuns;
    const { root } = set;
    if (minimum === undefined || !existsSync(join(root, LOCK_PATH)))
        return [];
    const actual = readLock(root);
    const expected = await expectedOutputs(set, root, wardenRoot);
    if (canonicalJson(actual) !== canonicalJson(expected.lock))
        return [];
    const policy = sha256(readFileSync(join(root, LOCK_PATH)));
    const evidence = readEvidence(set.config.project).filter((e) => e.root === root);
    const checked = evidence.filter((e) => e.kind === "coverage" && e.policy === policy && e.tier === "boundary" &&
        e.run !== undefined && e.commit !== undefined && e.tree !== undefined && Array.isArray(e.members));
    if (checked.length < minimum)
        return [];
    const fired = new Set(evidence.filter((e) => e.kind === "fired").map((e) => e.guardrail));
    return set.packs.flatMap((pack) => pack.practices.flatMap((practice) => {
        if (addPractices.has(practice.id))
            return [];
        const keep = new Map();
        return practice.guardrails.flatMap((g) => {
            if (g.scope !== "project" || !g.implementation.startsWith("fs:"))
                return [];
            const { id, packDir: _packDir, ...rule } = g;
            const key = canonicalJson(rule);
            const replacement = keep.get(key);
            if (replacement === undefined) {
                keep.set(key, id);
                return [];
            }
            if (fired.has(id) || fired.has(replacement))
                return [];
            const distinct = new Map(checked.filter((e) => e.members?.includes(id) && e.members.includes(replacement))
                .map(({ at, run, commit, tree }) => [tree, { at, run, commit, tree }]));
            if (distinct.size < minimum)
                return [];
            return [{ action: "remove", pack: pack.id, practice: practice.id, guardrail: id, replacement,
                    approval: "policy-signer", evidence: [{ kind: "equivalent-coverage", policy, runs: [...distinct.values()] }] }];
        });
    }));
}
export async function learningScorecard(root, wardenRoot) {
    const set = await loadRecords(root, wardenRoot);
    const { project } = set.config;
    const resolved = new Map();
    const stalls = new Map();
    const upheld = new Map();
    const escaped = new Map();
    const recorded = readEvidence(project);
    const { strength, measuredGuardrails, mutationPolicyIssue } = await retainedMutations(set, wardenRoot, recorded);
    for (const e of recorded) {
        if ((e.kind !== "resolved" && e.kind !== "stalled") || e.root !== root || e.guardrail === undefined || e.pack === undefined ||
            e.file === undefined || e.tier === undefined || e.sourceRun === undefined)
            continue;
        const key = guardrailKey(e.pack, e.guardrail);
        const evidence = e.kind === "resolved" ? resolved : stalls;
        const events = evidence.get(key) ?? new Set();
        events.add(JSON.stringify([e.tier, e.sourceRun, e.file]));
        evidence.set(key, events);
    }
    for (const ruling of listDisputeRulings(project, root)) {
        if (ruling.status !== "upheld")
            continue;
        const key = guardrailKey(ruling.pack, ruling.guardrail);
        upheld.set(key, (upheld.get(key) ?? 0) + 1);
    }
    for (const round of listRepositoryEscapeRounds(reviewRepository(root))) {
        for (const { practice } of reviewHistoryState(round).escapes) {
            escaped.set(practice, (escaped.get(practice) ?? 0) + 1);
        }
    }
    return set.packs.flatMap((pack) => pack.practices.flatMap((practice) => practice.guardrails.map((guardrail) => {
        const key = guardrailKey(pack.id, guardrail.id);
        const resolutions = resolved.get(key)?.size ?? 0;
        const disputes = upheld.get(key) ?? 0;
        const total = resolutions + disputes;
        const measurement = strength.get(key)?.mutations;
        const variants = measurement === undefined ? 0 : measurement.caught.length + measurement.missed.length;
        return {
            pack: pack.id,
            practice: practice.id,
            guardrail: guardrail.id,
            resolved: resolutions,
            stalls: stalls.get(key)?.size ?? 0,
            upheldDisputes: disputes,
            precision: total === 0 ? null : resolutions / total,
            confirmedPracticeEscapes: escaped.get(practice.id) ?? 0,
            mutationStrength: measurement === undefined || variants === 0 ? null : measurement.caught.length / variants,
            ...(measurement === undefined ? {} : { mutations: measurement }),
            ...(mutationPolicyIssue !== undefined && measuredGuardrails.has(key) ? { mutationPolicyIssue } : {}),
        };
    })));
}
