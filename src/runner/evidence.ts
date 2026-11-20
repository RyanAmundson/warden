import { appendFileSync, closeSync, fstatSync, linkSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Kind, Tier } from "../records/types.js";

export interface Evidence {
  at: string;
  kind: "disputed" | "fired" | "resolved" | "cost" | "tampered" | "stalled" | "scaling" | "step" | "registered" | "plugin" | "commit" | "change" | "gate-off";
  guardrail?: string;
  file?: string;
  status?: string;
  ms?: number;
  shared?: string;
  guardrails?: number;
  members?: string[];
  detail?: string;
  dispute?: string;
  attempts?: string[];
  triggered?: boolean;
  run?: string;
  sourceRun?: string;
  session?: string;
  policy?: string;
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
  ratchetFrom?: "head" | "uncommitted";
  base?: string;
  mergeBase?: string;
  step?: Step;
  state?: "start" | "done" | "fail";
  passes?: Record<string, number>;
  cachedRules?: string[];
  steps?: Partial<Record<Step, number>>;
  root?: string;
  tree?: string;
  scope?: "full" | "partial";
  sparseCoverage?: Record<string, Kind[]>;
  sparseProjectFiles?: number;
  alert?: string;
}

export type Trigger = "agent-edit" | "git-commit" | "manual" | "daemon";

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

export type Outcome = "ran" | "tampered" | "unstaged" | "empty" | "error" | "refused";

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

export function linkRecord(path: string, value: object): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(directory, ".pending-"));
  try {
    const candidate = join(temp, "record.json");
    writeFileSync(candidate, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flush: true });
    linkSync(candidate, path);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function appendEvidence(project: string, e: Evidence): void {
  mkdirSync(join(wardenHome(), "evidence"), { recursive: true });
  if (sizeOf(evidenceFile(project)) >= ROTATE_BYTES) rotate(project);
  appendFileSync(evidenceFile(project), `${JSON.stringify(e)}\n`);
}

export function evidenceProjects(): string[] {
  try {
    return readdirSync(join(wardenHome(), "evidence"))
      .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".1.jsonl"))
      .map((f) => f.slice(0, -".jsonl".length));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
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

const parse = (text: string, include?: (line: string) => boolean): Evidence[] =>
  text.split("\n").flatMap((l) => {
    try {
      return l === "" || include?.(l) === false ? [] : [JSON.parse(l) as Evidence];
    } catch {
      return [];
    }
  });

export function readEvidenceTail(project: string, bytes: number, include?: (line: string) => boolean): Evidence[] {
  const current = tailOf(evidenceFile(project), bytes + 1);
  const tail = Buffer.concat([tailOf(previousEvidenceFile(project), bytes + 1 - current.length), current]);
  return parse((tail.length <= bytes ? tail : tail.subarray(tail.indexOf("\n") + 1)).toString("utf8"), include);
}

export function readEvidence(project: string, include?: (line: string) => boolean): Evidence[] {
  return readEvidenceTail(project, Number.POSITIVE_INFINITY, include);
}

export function readEvidenceFrom(project: string, offset: number): { events: Evidence[]; offset: number } {
  const size = sizeOf(evidenceFile(project));
  if (offset === 0 || size < offset) return { events: readEvidence(project), offset: size };
  const fd = openSync(evidenceFile(project), "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    const end = buffer.lastIndexOf("\n") + 1;
    return { events: parse(buffer.subarray(0, end).toString("utf8")), offset: offset + end };
  } finally {
    closeSync(fd);
  }
}
