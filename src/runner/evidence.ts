import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tier } from "../records/types.js";

export interface Evidence {
  at: string;
  kind: "fired" | "cost" | "tampered" | "stalled" | "scaling";
  guardrail?: string;
  file?: string;
  status?: string;
  ms?: number;
  shared?: string;
  guardrails?: number;
  members?: string[];
  detail?: string;
  triggered?: boolean;
  run?: string;
  tier?: Tier;
  pack?: string;
  files?: number;
  bytes?: number;
  rules?: Record<string, number>;
  outcome?: Outcome;
  commit?: string;
  k?: number;
  verdict?: Verdict;
  points?: [number, number][];
  f?: number;
  warden?: string;
  previous?: Measurement;
}

export type Verdict = "constant" | "sublinear" | "linear" | "superlinear";

export interface Measurement {
  verdict: Verdict;
  k?: number;
  points: [number, number][];
  f: number;
}

export type Outcome = "ran" | "tampered" | "unstaged" | "empty";

export const RUN_TOTAL = "run";

export const ESLINT_PASS = "eslint-pass";

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
