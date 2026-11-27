import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readESLintReport } from "../adapters/eslint-report.js";
import { readExternalReport } from "../adapters/external-report.js";
import { sha256 } from "../compiler/lock.js";
import { enrollmentTampering, readEnrollments } from "../runner/enrollment.js";
import { type Evidence, RUN_TOTAL, appendEvidence, readEvidence } from "../runner/evidence.js";
import { TRUST_SIGNERS } from "../runner/trust.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

export function publishESLint(project: string, report: string, snapshot: string, wardenRoot: string): Evidence {
  return publishReport("eslint", "eslint", project, report, snapshot, wardenRoot);
}

export function publishReport(format: "eslint" | "json", adapter: string, project: string, report: string, snapshot: string, wardenRoot: string): Evidence {
  const enrolled = readEnrollments().get(project);
  if (enrolled === undefined) throw new Error(`Warden has no published ref enrolled for ${project}.`);
  const invalid = enrollmentTampering(enrolled.dir, join(wardenRoot, TRUST_SIGNERS))[0];
  if (invalid !== undefined) throw new Error(`Warden cannot verify the enrollment for ${project}: ${invalid.detail} (${invalid.file}).`);
  if (format === "eslint" ? adapter !== "eslint" : !enrolled.reportAdapters?.includes(adapter)) {
    throw new Error(`Report adapter ${adapter} is not registered for ${project} in format ${format}.`);
  }

  const root = realpathSync(git(snapshot, "rev-parse", "--show-toplevel").trim());
  const commit = git(root, "rev-parse", "--verify", "HEAD^{commit}").trim();
  if (git(root, "status", "--porcelain", "--untracked-files=normal") !== "") {
    throw new Error("Publish from the clean Git checkout that produced the report.");
  }
  const tracked = new Set(git(root, "ls-tree", "-rz", "--name-only", commit).split("\0").slice(0, -1));
  const raw: unknown = JSON.parse(readFileSync(report, "utf8"));
  const result = format === "eslint" ? readESLintReport(raw, root, tracked) : readExternalReport(raw, commit, tracked);
  if (commit !== git(enrolled.root, "rev-parse", "--verify", "--end-of-options", `${enrolled.ref}^{commit}`).trim()) {
    throw new Error(`The report's checkout does not match ${project}'s current ${enrolled.ref}.`);
  }

  const run = sha256(JSON.stringify([enrolled.root, enrolled.ref, commit, adapter, result]));
  const existing = readEvidence(project, (line) => line.includes(run)).find((event) => event.run === run);
  if (existing !== undefined) return existing;

  const receipt: Evidence = {
    at: new Date().toISOString(), kind: "cost", guardrail: RUN_TOTAL, run, trigger: "main audit",
    outcome: "ran", mode: "audit", result: result.findings.length === 0 ? "pass" : "fail", exit: 0, scope: "partial",
    root: enrolled.root, ref: enrolled.ref, commit, files: result.files.length, kinds: { lint: result.findings.length },
    report: { adapter, warnings: result.warnings },
    failures: result.findings.map(({ file, line, rule, message }) => ({ file, line, guardrail: rule, practice: adapter, doThis: message })),
  };
  appendEvidence(project, receipt);
  return receipt;
}
