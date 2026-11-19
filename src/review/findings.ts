import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Severity = "critical" | "important" | "minor" | "environment";
export type Reproduces = "head" | "base" | "previous";
export interface RawFinding {
  n: number;
  severity: Severity;
  title: string;
  file?: string;
  line?: number;
  reproducesOn: Reproduces[];
  spec: boolean;
  earlier?: number;
  flaky: boolean;
  correction: string;
}
export type FindingKind = "env" | "flake" | "unfixed" | "spec-unmet" | "pre-existing" | "regression" | "touched" | "untouched";
export type Action = "fix-environment" | "rerun-alone" | "back-to-builder" | "file-task";
export interface ReviewFinding extends RawFinding {
  kind: FindingKind;
  action: Action;
  blocks: boolean;
}
export type Touched = Record<string, [number, number][]>;
export interface Triage {
  verdict: "pass" | "fail" | "operational";
  findings: ReviewFinding[];
  next: string | null;
}

const git = (root: string, args: string[], missing?: string): string => {
  try {
    return execFileSync("git", args, { cwd: root, env: { ...process.env, LC_ALL: "C" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
  } catch (cause) {
    const e = cause as { status?: number | null };
    if (typeof e.status !== "number") throw new Error("install git and put it on PATH, then run the review again");
    throw new Error(`run git rev-parse --verify ${missing ?? "HEAD"} to find the missing ref, then run the review again`);
  }
};

export function touchedLines(root: string, from: string, to: string): Touched {
  const out: Touched = {};
  for (const ref of [from, to]) git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], ref);
  let file: string | undefined;
  for (const l of git(root, ["diff", "-U0", "--no-color", from, to]).split("\n")) {
    if (l.startsWith("+++ ")) file = l === "+++ /dev/null" ? undefined : l.slice(6);
    const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m === null || file === undefined) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) (out[file] ??= []).push([start, start + count - 1]);
  }
  for (const f of git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter((x) => x !== "")) {
    const text = readFileSync(join(root, f), "utf8");
    const n = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    if (n > 0) out[f] = [[1, n]];
  }
  return out;
}

const located = (raw: RawFinding, touched: Touched): boolean => {
  if (raw.file === undefined) return true;
  const ranges = touched[raw.file];
  if (ranges === undefined) return false;
  const line = raw.line;
  return line === undefined || ranges.some(([a, b]) => line >= a && line <= b);
};

const kinds = (raw: RawFinding, touched: Touched, round: number): [FindingKind, Action, boolean] => {
  if (raw.severity === "environment") return ["env", "fix-environment", false];
  if (raw.flaky) return ["flake", "rerun-alone", false];
  if (raw.earlier !== undefined) return ["unfixed", "back-to-builder", true];
  if (raw.spec) return ["spec-unmet", "back-to-builder", true];
  if (raw.reproducesOn.includes("base")) return ["pre-existing", "file-task", false];
  const here = located(raw, touched);
  if (raw.file !== undefined && here && round > 1 && !raw.reproducesOn.includes("previous")) return ["regression", "back-to-builder", true];
  if (here) return ["touched", "back-to-builder", true];
  return ["untouched", "file-task", raw.severity === "critical"];
};

export function classify(raw: RawFinding, touched: Touched, round: number): ReviewFinding {
  const [kind, action, blocks] = kinds(raw, touched, round);
  return { ...raw, kind, action, blocks };
}

const numbers = (fs: ReviewFinding[]): string => fs.map((f) => f.n).join(", ");

export function triage(raws: RawFinding[], touched: Touched, round: number, rerun: string): Triage {
  const findings = raws.map((r) => classify(r, touched, round));
  const env = findings.filter((f) => f.kind === "env");
  const flake = findings.filter((f) => f.kind === "flake");
  const block = findings.filter((f) => f.blocks);
  const filed = findings.filter((f) => f.action === "file-task" && !f.blocks);
  const verdict = env.length > 0 || flake.length > 0 ? "operational" : block.length > 0 ? "fail" : "pass";
  let next: string | null = null;
  if (env.length > 0) next = `fix the environment named in finding ${env[0]!.n}, then ${rerun}.`;
  else if (flake.length > 0) next = `rerun the test named in finding ${flake[0]!.n} alone; if it fails again, file a slow-test task, then ${rerun}.`;
  else if (block.length > 0) next = `send findings ${numbers(block)} back to the builder, then ${rerun} on the new head.`;
  else if (filed.length > 0) next = `file one task for each of findings ${numbers(filed)}.`;
  return { verdict, findings, next };
}

export const exitCode = (t: Triage): 0 | 1 | 2 => (t.verdict === "operational" ? 2 : t.verdict === "fail" ? 1 : 0);
