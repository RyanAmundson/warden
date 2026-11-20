import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { appendEvidence, linkRecord, readEvidence, wardenHome } from "./evidence.js";

interface DisputeLocation {
  project: string;
  root: string;
  guardrail: string;
  pack: string;
  file: string;
}

interface DisputeIntake extends DisputeLocation {
  dispute: string;
  at: string;
  reason: string;
  attempts: string[];
}

export interface DisputeDecision {
  status: "upheld" | "rejected";
  role: "independent-reviewer" | "repository-owner";
  actor: string;
  reason: string;
  evidence: string;
}

export interface DisputeRuling extends DisputeDecision, DisputeLocation {
  dispute: string;
  at: string;
}

const DISPUTE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const pathOf = (dispute: string, suffix: string): string => join(wardenHome(), "disputes", dispute + suffix);

const nonempty = (part: unknown): part is string => typeof part === "string" && part.trim() !== "";

const hasLocation = (entry: DisputeLocation): boolean =>
  typeof entry.file === "string" && [entry.project, entry.root, entry.guardrail, entry.pack].every(nonempty);

const readRecord = <T>(path: string, valid: (record: T) => boolean): T | undefined => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  const invalid = (cause?: unknown) => new Error(`Invalid dispute record at ${path}. Next action: restore the record from backup.`, { cause });
  let record: T;
  try {
    record = JSON.parse(text) as T;
  } catch (cause) {
    throw invalid(cause);
  }
  if (record === null || typeof record !== "object" || !valid(record)) throw invalid();
  return record;
};

const findRuling = (path: string): DisputeRuling | undefined => readRecord<DisputeRuling>(path, (entry) =>
  hasLocation(entry) &&
  (entry.status === "upheld" || entry.status === "rejected") &&
  (entry.role === "independent-reviewer" || entry.role === "repository-owner") &&
  [entry.dispute, entry.actor, entry.reason, entry.evidence, entry.at].every(nonempty));

export function fileDispute(location: DisputeLocation, reason: string, attempts: string[]): string {
  const dispute = randomUUID();
  const { project, ...subject } = location;
  const at = new Date().toISOString();
  const intake: DisputeIntake = { ...location, dispute, at, reason, attempts };
  linkRecord(pathOf(dispute, ".open.json"), intake);
  try {
    appendEvidence(project, { ...subject, at, kind: "disputed", status: "open", trigger: "manual", dispute, detail: reason, attempts });
  } catch (cause) {
    throw new Error(`Dispute ${dispute} was filed, but Warden could not write its Evidence. Next action: use this ID to review the filed dispute.`, { cause });
  }
  return dispute;
}

function findIntake(project: string, root: string, dispute: string): DisputeLocation | undefined {
  const intake = readRecord<DisputeIntake>(pathOf(dispute, ".open.json"), (entry) =>
    hasLocation(entry) && [entry.dispute, entry.at, entry.reason].every(nonempty) &&
    Array.isArray(entry.attempts) && entry.attempts.length > 0 && entry.attempts.every(nonempty));
  if (intake !== undefined) {
    return intake.dispute === dispute && intake.project === project && intake.root === root ? intake : undefined;
  }
  const legacy = readEvidence(project).find((e) => e.kind === "disputed" && e.status === "open" && e.root === root && e.dispute === dispute);
  if (legacy?.guardrail === undefined || legacy.pack === undefined || legacy.file === undefined) return undefined;
  return { project, root, guardrail: legacy.guardrail, pack: legacy.pack, file: legacy.file };
}

export function ruleDispute(project: string, root: string, dispute: string, decision: DisputeDecision): DisputeRuling {
  const { status, role, actor, reason, evidence } = decision;
  const reviewed = { status, role, actor: actor.trim(), reason: reason.trim(), evidence: evidence.trim() };
  if (Object.values(reviewed).some((part) => part === "")) {
    throw new Error("A dispute ruling needs an actor, reason and evidence. Next action: supply nonempty --actor, --reason and --evidence values.");
  }
  const absent = () => new Error(`There is no dispute ${JSON.stringify(dispute)} in this checkout. Next action: run warden review dispute from the checkout where warden dispute recorded the ID.`);
  if (!DISPUTE_ID.test(dispute)) throw absent();
  const path = pathOf(dispute, ".json");
  const replay = (recorded: DisputeRuling): DisputeRuling => {
    const { dispute: id, project: name, root: checkout, file: _file, guardrail: _guardrail, pack: _pack, at: _at, ...prior } = recorded;
    if (id !== dispute || name !== project || checkout !== root) throw absent();
    if (isDeepStrictEqual(prior, reviewed)) return recorded;
    throw new Error(`Dispute ${dispute} already has a different ruling. Next action: read the existing decision in ${path}.`);
  };
  const existing = findRuling(path);
  if (existing !== undefined) return replay(existing);

  const open = findIntake(project, root, dispute);
  if (open === undefined) throw absent();
  const ruling: DisputeRuling = { ...reviewed, dispute, project, root, guardrail: open.guardrail, pack: open.pack, file: open.file, at: new Date().toISOString() };
  try {
    linkRecord(path, ruling);
    return ruling;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const recorded = findRuling(path);
    if (recorded === undefined) throw new Error(`Dispute ${dispute} changed while it was recorded. Next action: rerun warden review dispute.`);
    return replay(recorded);
  }
}
