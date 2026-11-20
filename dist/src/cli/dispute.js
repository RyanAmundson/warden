import { isAbsolute, relative, sep } from "node:path";
import { RecordError, loadRecords } from "../records/load.js";
import { fileDispute, ruleDispute } from "../runner/disputes.js";
export async function runDispute(root, wardenRoot, guardrail, path, options) {
    const reason = options.reason?.trim();
    const attempts = options.attempt?.map((entry) => entry.trim()) ?? [];
    if (!reason || attempts.length === 0 || attempts.some((entry) => entry === "")) {
        throw new RecordError("", "", 'A dispute needs a reason and at least one attempted compliant approach. Next action: run warden dispute <guardrail> <path> --reason "why the rule does not fit" --attempt "what you tried".');
    }
    const file = relative(root, path);
    if (file === ".." || file.startsWith(".." + sep) || isAbsolute(file)) {
        throw new RecordError(path, "", "The dispute path is outside this checkout. Next action: run warden dispute with a path in this checkout.");
    }
    const set = await loadRecords(root, wardenRoot);
    const pack = set.packs.find((entry) => entry.practices.some((practice) => practice.guardrails.some((rule) => rule.id === guardrail)));
    if (pack === undefined) {
        throw new RecordError("", "", `No enabled Guardrail has id "${guardrail}". Next action: run warden report to find the Guardrail id, then run warden dispute again.`);
    }
    const dispute = fileDispute({ project: set.config.project, root, guardrail, pack: pack.id, file }, reason, attempts);
    process.stdout.write(`Recorded dispute ${dispute} for ${guardrail} in ${file || "this project"}.\n`);
    return 0;
}
export async function runDisputeRuling(root, wardenRoot, dispute, decision) {
    const set = await loadRecords(root, wardenRoot);
    const ruling = ruleDispute(set.config.project, root, dispute, decision);
    process.stdout.write(`${JSON.stringify(ruling)}\n`);
    return 0;
}
