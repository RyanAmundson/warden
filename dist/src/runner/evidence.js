import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const RUN_TOTAL = "run";
export const ESLINT_PASS = "eslint-pass";
export const wardenHome = () => process.env.WARDEN_HOME ?? join(homedir(), ".warden");
export const evidenceFile = (project) => join(wardenHome(), "evidence", `${project}.jsonl`);
export function appendEvidence(project, e) {
    mkdirSync(join(wardenHome(), "evidence"), { recursive: true });
    appendFileSync(evidenceFile(project), `${JSON.stringify(e)}\n`);
}
export function readEvidence(project) {
    let text;
    try {
        text = readFileSync(evidenceFile(project), "utf8");
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return [];
        throw cause;
    }
    return text.split("\n").flatMap((l) => {
        try {
            return l === "" ? [] : [JSON.parse(l)];
        }
        catch {
            return [];
        }
    });
}
