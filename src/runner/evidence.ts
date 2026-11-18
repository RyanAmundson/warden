import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Evidence {
  at: string;
  kind: "fired" | "cost" | "tampered" | "stalled";
  guardrail?: string;
  file?: string;
  status?: string;
  ms?: number;
  shared?: string;
  guardrails?: number;
  members?: string[];
  detail?: string;
  triggered?: boolean;
}

export const wardenHome = (): string => process.env.WARDEN_HOME ?? join(homedir(), ".warden");

const evidenceFile = (project: string): string => join(wardenHome(), "evidence", `${project}.jsonl`);

export function appendEvidence(project: string, e: Evidence): void {
  mkdirSync(join(wardenHome(), "evidence"), { recursive: true });
  appendFileSync(evidenceFile(project), `${JSON.stringify(e)}\n`);
}

export function readEvidence(project: string): Evidence[] {
  let text: string;
  try {
    text = readFileSync(evidenceFile(project), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Evidence);
}
