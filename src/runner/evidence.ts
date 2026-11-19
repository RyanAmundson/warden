import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tier } from "../records/types.js";

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

export const previousEvidenceFile = (project: string): string => join(wardenHome(), "evidence", `${project}.1.jsonl`);

export const ROTATE_BYTES = 16 * 1024 * 1024;

export const LOOP_TAIL_BYTES = 1024 * 1024;

const sizeOf = (file: string): number => {
  try {
    return statSync(file).size;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw cause;
  }
};

const rotate = (project: string): void => {
  try {
    renameSync(evidenceFile(project), previousEvidenceFile(project));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
};

export function appendEvidence(project: string, e: Evidence): void {
  mkdirSync(join(wardenHome(), "evidence"), { recursive: true });
  if (sizeOf(evidenceFile(project)) >= ROTATE_BYTES) rotate(project);
  appendFileSync(evidenceFile(project), `${JSON.stringify(e)}\n`);
}

const tailOf = (file: string, bytes: number): Buffer => {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw cause;
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer;
  } finally {
    closeSync(fd);
  }
};

const parse = (text: string): Evidence[] =>
  text.split("\n").flatMap((l) => {
    try {
      return l === "" ? [] : [JSON.parse(l) as Evidence];
    } catch {
      return [];
    }
  });

export function readEvidenceTail(project: string, bytes: number): Evidence[] {
  const current = tailOf(evidenceFile(project), bytes + 1);
  const tail = Buffer.concat([tailOf(previousEvidenceFile(project), bytes + 1 - current.length), current]);
  return parse((tail.length <= bytes ? tail : tail.subarray(tail.indexOf("\n") + 1)).toString("utf8"));
}

export function readEvidence(project: string): Evidence[] {
  return readEvidenceTail(project, Number.POSITIVE_INFINITY);
}
