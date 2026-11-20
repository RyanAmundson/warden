import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export type Severity = "critical" | "important" | "minor" | "environment";
export type Reproduces = "head" | "base" | "previous";
export interface RawFinding {
  n: number;
  severity: Severity;
  title: string;
  file?: string;
  line?: number;
  endLine?: number;
  reproducesOn: Reproduces[];
  spec: boolean;
  earlier?: number;
  flaky: boolean;
  correction: string;
  evidence?: string[];
}
export type Kind = "env" | "flake" | "unfixed" | "spec-unmet" | "pre-existing" | "regression" | "touched" | "untouched";
export type Action = "fix-environment" | "rerun-alone" | "back-to-builder" | "file-task";
export interface ReviewFinding extends RawFinding {
  kind: Kind;
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
    const e = cause as { status?: number | null; stderr?: string };
    if (typeof e.status !== "number") throw new Error("install git and put it on PATH, then run the review again");
    if (args[0]?.startsWith("--attr-source=") && e.stderr?.includes("unknown option: --attr-source")) {
      throw new Error("Recording a review needs Git 2.41 or later. Next action: upgrade Git and rerun warden review record.");
    }
    throw new Error(`run git rev-parse --verify ${missing ?? "HEAD"} to find the missing ref, then run the review again`);
  }
};

const pathOf = (header: string): string => {
  const path = header.replace(/\t$/, "");
  if (!path.startsWith('"')) return path;
  return JSON.parse(path.replace(/\\([0-7]{3}|.)/g, (escaped, code: string) => {
    if (code === "a") return "\\u0007";
    if (code === "v") return "\\u000b";
    if (code.length === 3) return "\\u" + Number.parseInt(code, 8).toString(16).padStart(4, "0");
    return escaped;
  })) as string;
};

const untrackedText = (root: string, file: string): string => {
  const path = join(root, file);
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path, "utf8");
  } catch {
    throw new Error("Git listed " + file + " as untracked, but Warden could not read it. Next action: check that " + file + " is readable or remove it, then run the review again");
  }
};

export function touchedLines(root: string, from: string, to: string, mode: "worktree" | "no-untracked" | "commits" = "worktree"): Touched {
  const out: Touched = Object.create(null) as Touched;
  for (const ref of [from, to]) git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], ref);
  let file: string | undefined;
  let header = false;
  const attrs = mode === "commits" ? [`--attr-source=${to}`] : [];
  const patch = git(root, [...attrs, "-c", "core.quotePath=false", "diff", "-U0", "--inter-hunk-context=0", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", from, to, "--"]);
  for (const l of patch.split("\n")) {
    if (l.startsWith("diff --git ")) {
      file = undefined;
      header = true;
    }
    if (header && l.startsWith("+++ ")) {
      const path = pathOf(l.slice(4));
      file = path.startsWith("b/") ? path.slice(2) : undefined;
      header = false;
    }
    const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m === null || file === undefined) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) (out[file] ??= []).push([start, start + count - 1]);
  }
  if (mode !== "worktree") return out;
  for (const f of git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter((x) => x !== "")) {
    const text = untrackedText(root, f);
    const n = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    if (n > 0) out[f] = [[1, n]];
  }
  return out;
}

const located = (raw: RawFinding, touched: Touched): boolean => {
  if (raw.file === undefined) return true;
  const ranges = Object.hasOwn(touched, raw.file) ? touched[raw.file] : undefined;
  if (ranges === undefined) return false;
  const line = raw.line;
  return line === undefined || ranges.some(([a, b]) => (raw.endLine ?? line) >= a && line <= b);
};

const kinds = (raw: RawFinding, touched: Touched, round: number): [Kind, Action, boolean] => {
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

export function triage(raws: RawFinding[], touched: Touched, round: number, rerun: string, rerunAfterFix = rerun): Triage {
  const findings = raws.map((r) => classify(r, touched, round));
  const env = findings.filter((f) => f.kind === "env");
  const flake = findings.filter((f) => f.kind === "flake");
  const block = findings.filter((f) => f.blocks);
  const filed = findings.filter((f) => f.action === "file-task" && !f.blocks);
  const verdict = env.length > 0 || flake.length > 0 ? "operational" : block.length > 0 ? "fail" : "pass";
  let next: string | null = null;
  if (env.length > 0) next = `fix the environment named in finding ${env[0]!.n}, then ${rerun}.`;
  else if (flake.length > 0) next = `rerun the test named in finding ${flake[0]!.n} alone; if it fails again, file a slow-test task, then ${rerun}.`;
  else if (block.length > 0) next = `send findings ${numbers(block)} back to the builder, then ${rerunAfterFix} on the new head.`;
  else if (filed.length > 0) next = `file one task for each of findings ${numbers(filed)}.`;
  return { verdict, findings, next };
}

export const exitCode = (t: Triage): 0 | 1 | 2 => (t.verdict === "operational" ? 2 : t.verdict === "fail" ? 1 : 0);
