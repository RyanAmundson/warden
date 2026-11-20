import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { appendEvidence, linkRecord, readEvidence, wardenHome } from "./evidence.js";
const DISPUTE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const directory = () => join(wardenHome(), "disputes");
const pathOf = (dispute, suffix) => join(directory(), dispute + suffix);
const nonempty = (part) => typeof part === "string" && part.trim() !== "";
const hasLocation = (entry) => typeof entry.file === "string" && [entry.project, entry.root, entry.guardrail, entry.pack].every(nonempty);
const readRecord = (path, valid) => {
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return undefined;
        throw cause;
    }
    const invalid = (cause) => new Error(`Invalid dispute record at ${path}. Next action: restore the record from backup.`, { cause });
    let record;
    try {
        record = JSON.parse(text);
    }
    catch (cause) {
        throw invalid(cause);
    }
    if (record === null || typeof record !== "object" || !valid(record))
        throw invalid();
    return record;
};
const findRuling = (dispute) => readRecord(pathOf(dispute, ".json"), (entry) => hasLocation(entry) &&
    entry.dispute === dispute &&
    (entry.status === "upheld" || entry.status === "rejected") &&
    (entry.role === "independent-reviewer" || entry.role === "repository-owner") &&
    [entry.actor, entry.reason, entry.evidence, entry.at].every(nonempty));
const readIntake = (dispute) => readRecord(pathOf(dispute, ".open.json"), (entry) => hasLocation(entry) && entry.dispute === dispute && [entry.at, entry.reason].every(nonempty) &&
    Array.isArray(entry.attempts) && entry.attempts.length > 0 && entry.attempts.every(nonempty));
export function listDisputeRulings(project, root) {
    let names;
    try {
        names = readdirSync(directory());
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return [];
        throw cause;
    }
    const rulings = [];
    for (const name of names) {
        if (!name.endsWith(".json"))
            continue;
        const id = name.slice(0, -".json".length);
        if (!DISPUTE_ID.test(id))
            continue;
        try {
            const ruling = findRuling(id);
            if (ruling?.project === project && ruling.root === root)
                rulings.push(ruling);
        }
        catch (cause) {
            const intake = readIntake(id);
            if (intake === undefined || (intake.project === project && intake.root === root))
                throw cause;
        }
    }
    return rulings;
}
export function fileDispute(location, reason, attempts) {
    const dispute = randomUUID();
    const { project, ...subject } = location;
    const at = new Date().toISOString();
    const intake = { ...location, dispute, at, reason, attempts };
    linkRecord(pathOf(dispute, ".open.json"), intake);
    try {
        appendEvidence(project, { ...subject, at, kind: "disputed", status: "open", trigger: "manual", dispute, detail: reason, attempts });
    }
    catch (cause) {
        throw new Error(`Dispute ${dispute} was filed, but Warden could not write its Evidence. Next action: use this ID to review the filed dispute.`, { cause });
    }
    return dispute;
}
function findIntake(project, root, dispute) {
    const intake = readIntake(dispute);
    if (intake !== undefined) {
        return intake.project === project && intake.root === root ? intake : undefined;
    }
    const legacy = readEvidence(project).find((e) => e.kind === "disputed" && e.status === "open" && e.root === root && e.dispute === dispute);
    if (legacy?.guardrail === undefined || legacy.pack === undefined || legacy.file === undefined)
        return undefined;
    return { project, root, guardrail: legacy.guardrail, pack: legacy.pack, file: legacy.file };
}
export function ruleDispute(project, root, dispute, decision) {
    const { status, role, actor, reason, evidence } = decision;
    const reviewed = { status, role, actor: actor.trim(), reason: reason.trim(), evidence: evidence.trim() };
    if (Object.values(reviewed).some((part) => part === "")) {
        throw new Error("A dispute ruling needs an actor, reason and evidence. Next action: supply nonempty --actor, --reason and --evidence values.");
    }
    const absent = () => new Error(`There is no dispute ${JSON.stringify(dispute)} in this checkout. Next action: run warden review dispute from the checkout where warden dispute recorded the ID.`);
    if (!DISPUTE_ID.test(dispute))
        throw absent();
    const path = pathOf(dispute, ".json");
    const replay = (recorded) => {
        const { dispute: id, project: name, root: checkout, file: _file, guardrail: _guardrail, pack: _pack, at: _at, ...prior } = recorded;
        if (id !== dispute || name !== project || checkout !== root)
            throw absent();
        if (isDeepStrictEqual(prior, reviewed))
            return recorded;
        throw new Error(`Dispute ${dispute} already has a different ruling. Next action: read the existing decision in ${path}.`);
    };
    const existing = findRuling(dispute);
    if (existing !== undefined)
        return replay(existing);
    const open = findIntake(project, root, dispute);
    if (open === undefined)
        throw absent();
    const ruling = { ...reviewed, dispute, project, root, guardrail: open.guardrail, pack: open.pack, file: open.file, at: new Date().toISOString() };
    try {
        linkRecord(path, ruling);
        return ruling;
    }
    catch (cause) {
        if (cause.code !== "EEXIST")
            throw cause;
        const recorded = findRuling(dispute);
        if (recorded === undefined)
            throw new Error(`Dispute ${dispute} changed while it was recorded. Next action: rerun warden review dispute.`);
        return replay(recorded);
    }
}
