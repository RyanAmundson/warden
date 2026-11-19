import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Kind, Tier } from "../records/types.js";

export interface Evidence {
  at: string;
  kind: "fired" | "cost" | "tampered" | "stalled" | "scaling" | "step";
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
  trigger?: Trigger;
  cached?: number;
  exit?: number;
  result?: "pass" | "fail";
  next?: string;
  failures?: RunFailure[];
  kinds?: Partial<Record<Kind | "unknown", number>>;
  ratchet?: [number, number];
  step?: Step;
  state?: "start" | "done" | "fail";
  passes?: Record<string, number>;
  cachedRules?: string[];
  steps?: Partial<Record<Step, number>>;
}

export type Trigger = "agent-edit" | "git-commit" | "manual";

export type Step = "rules-intact" | "tools-ready" | "rules" | "verdict";

export interface RunFailure {
  file: string;
  line: number;
  guardrail: string;
  practice: string;
  doThis?: string;
}

export type Verdict = "constant" | "sublinear" | "linear" | "superlinear";

export interface Measurement {
  verdict: Verdict;
  k?: number;
  points: [number, number][];
  f: number;
}

export type Outcome = "ran" | "tampered" | "unstaged" | "empty" | "error";

export const RUN_TOTAL = "run";

export const ESLINT_PASS = "eslint-pass";

export const wardenHome = (): string => process.env.WARDEN_HOME ?? join(homedir(), ".warden");

export const evidenceFile = (project: string): string => join(wardenHome(), "evidence", `${project}.jsonl`);

export function appendEvidence(project: string, e: Evidence): void {
  mkdirSync(join(wardenHome(), "evidence"), { recursive: true });
  appendFileSync(evidenceFile(project), `${JSON.stringify(e)}\n`);
}

export function evidenceProjects(): string[] {
  try {
    return readdirSync(join(wardenHome(), "evidence")).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
}

export function readEvidence(project: string): Evidence[] {
  let text: string;
  try {
    text = readFileSync(evidenceFile(project), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  return text.split("\n").flatMap((l) => {
    try {
      return l === "" ? [] : [JSON.parse(l) as Evidence];
    } catch {
      return [];
    }
  });
}
