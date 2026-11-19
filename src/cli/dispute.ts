import { randomUUID } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { RecordError, loadRecords } from "../records/load.js";
import { appendEvidence } from "../runner/evidence.js";

interface DisputeOptions {
  reason?: string;
  attempt?: string[];
}

export async function runDispute(root: string, wardenRoot: string, guardrail: string, path: string, options: DisputeOptions): Promise<number> {
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
  const dispute = randomUUID();
  appendEvidence(set.config.project, {
    at: new Date().toISOString(),
    kind: "disputed",
    status: "open",
    trigger: "manual",
    dispute,
    guardrail,
    pack: pack.id,
    root,
    file,
    detail: reason,
    attempts,
  });
  process.stdout.write(`Recorded dispute ${dispute} for ${guardrail} in ${file || "this project"}.\n`);
  return 0;
}
