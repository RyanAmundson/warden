import { loadRecords } from "../records/load.js";
import { listDisputeRulings } from "../runner/disputes.js";
import { readEvidence } from "../runner/evidence.js";
import { listRepositoryEscapeRounds, reviewHistoryState, reviewRepository } from "./history.js";
export async function learningScorecard(root, wardenRoot) {
    const set = await loadRecords(root, wardenRoot);
    const { project } = set.config;
    const resolved = new Map();
    const upheld = new Map();
    const escaped = new Map();
    for (const e of readEvidence(project)) {
        if (e.kind !== "resolved" || e.root !== root || e.guardrail === undefined || e.pack === undefined ||
            e.file === undefined || e.tier === undefined || e.sourceRun === undefined)
            continue;
        const key = JSON.stringify([e.pack, e.guardrail]);
        const events = resolved.get(key) ?? new Set();
        events.add(JSON.stringify([e.tier, e.sourceRun, e.file]));
        resolved.set(key, events);
    }
    for (const ruling of listDisputeRulings(project, root)) {
        if (ruling.status !== "upheld")
            continue;
        const key = JSON.stringify([ruling.pack, ruling.guardrail]);
        upheld.set(key, (upheld.get(key) ?? 0) + 1);
    }
    for (const round of listRepositoryEscapeRounds(reviewRepository(root))) {
        for (const { practice } of reviewHistoryState(round).escapes) {
            escaped.set(practice, (escaped.get(practice) ?? 0) + 1);
        }
    }
    return set.packs.flatMap((pack) => pack.practices.flatMap((practice) => practice.guardrails.map((guardrail) => {
        const key = JSON.stringify([pack.id, guardrail.id]);
        const resolutions = resolved.get(key)?.size ?? 0;
        const disputes = upheld.get(key) ?? 0;
        const total = resolutions + disputes;
        return {
            pack: pack.id,
            practice: practice.id,
            guardrail: guardrail.id,
            resolved: resolutions,
            upheldDisputes: disputes,
            precision: total === 0 ? null : resolutions / total,
            confirmedPracticeEscapes: escaped.get(practice.id) ?? 0,
        };
    })));
}
