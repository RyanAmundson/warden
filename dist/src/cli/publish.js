import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readESLintReport } from "../adapters/eslint-report.js";
import { sha256 } from "../compiler/lock.js";
import { enrollmentTampering, readEnrollments } from "../runner/enrollment.js";
import { RUN_TOTAL, appendEvidence, readEvidence } from "../runner/evidence.js";
import { TRUST_SIGNERS } from "../runner/trust.js";
const git = (cwd, ...args) => execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
export function publishESLint(project, report, snapshot, wardenRoot) {
    const enrolled = readEnrollments().get(project);
    if (enrolled === undefined)
        throw new Error(`Warden has no published ref enrolled for ${project}.`);
    const invalid = enrollmentTampering(enrolled.dir, join(wardenRoot, TRUST_SIGNERS))[0];
    if (invalid !== undefined)
        throw new Error(`Warden cannot verify the enrollment for ${project}: ${invalid.detail} (${invalid.file}).`);
    const root = realpathSync(git(snapshot, "rev-parse", "--show-toplevel").trim());
    const commit = git(root, "rev-parse", "--verify", "HEAD^{commit}").trim();
    if (git(root, "status", "--porcelain", "--untracked-files=normal") !== "") {
        throw new Error("Publish from the clean Git checkout that produced the report.");
    }
    const tracked = new Set(git(root, "ls-tree", "-rz", "--name-only", commit).split("\0").slice(0, -1));
    const result = readESLintReport(JSON.parse(readFileSync(report, "utf8")), root, tracked);
    if (commit !== git(enrolled.root, "rev-parse", "--verify", "--end-of-options", `${enrolled.ref}^{commit}`).trim()) {
        throw new Error(`The report's checkout does not match ${project}'s current ${enrolled.ref}.`);
    }
    const run = sha256(JSON.stringify([enrolled.root, enrolled.ref, commit, "eslint", result]));
    const existing = readEvidence(project, (line) => line.includes(run)).find((event) => event.run === run);
    if (existing !== undefined)
        return existing;
    const receipt = {
        at: new Date().toISOString(), kind: "cost", guardrail: RUN_TOTAL, run, trigger: "main audit",
        outcome: "ran", mode: "audit", result: result.findings.length === 0 ? "pass" : "fail", exit: 0, scope: "partial",
        root: enrolled.root, ref: enrolled.ref, commit, files: result.files.length, kinds: { lint: result.findings.length },
        report: { adapter: "eslint", warnings: result.warnings },
        failures: result.findings.map(({ file, line, rule, message }) => ({ file, line, guardrail: rule, practice: "eslint", doThis: message })),
    };
    appendEvidence(project, receipt);
    return receipt;
}
