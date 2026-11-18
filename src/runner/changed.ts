import { execFileSync } from "node:child_process";
import { RecordError } from "../records/load.js";

const git = (root: string, args: string[]): { ok: boolean; out: string; err: string } => {
  try {
    return { ok: true, out: execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), err: "" };
  } catch (cause) {
    const e = cause as { status?: number | null; stdout?: string; stderr?: string };
    if (typeof e.status !== "number") throw cause;
    return { ok: false, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
};

const names = (text: string): string[] => text.split("\0").filter((l) => l !== "");

const must = (root: string, args: string[]): string => {
  const r = git(root, args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.err.trim()}`);
  return r.out;
};

export function verifyBase(root: string, base: string): void {
  if (!git(root, ["rev-parse", "--is-inside-work-tree"]).ok) {
    throw new RecordError(root, "", "not a git repository");
  }
  if (!git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).ok) {
    throw new RecordError(".warden/config.yaml", "/base", `base ref "${base}" does not exist`);
  }
}

export function changedFiles(root: string, base: string): string[] {
  verifyBase(root, base);
  const diff = ["diff", "-z", "--name-only", "--relative", "--diff-filter=ACMR"];
  const files = [
    ...names(must(root, [...diff, `${base}...HEAD`])),
    ...names(must(root, [...diff, "--cached"])),
    ...names(must(root, diff)),
    ...names(must(root, ["ls-files", "-z", "--others", "--exclude-standard"])),
  ];
  return [...new Set(files)].sort();
}

export function lastCommittedText(root: string, path: string): string | undefined {
  if (!git(root, ["rev-parse", "--is-inside-work-tree"]).ok) return undefined;
  const head = git(root, ["show", `HEAD:./${path}`]);
  if (head.ok) return head.out;
  const last = git(root, ["log", "-1", "--format=%H", "--", path]);
  if (!last.ok || last.out.trim() === "") return undefined;
  const before = git(root, ["show", `${last.out.trim()}^:./${path}`]);
  return before.ok ? before.out : undefined;
}

const mergeBase = (root: string, base: string): string => must(root, ["merge-base", base, "HEAD"]).trim();

export interface Changes {
  lines: Map<string, Set<number> | "all">;
  renames: Map<string, string>;
}

const HUNK = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/;

export function changesSinceMergeBase(root: string, base: string): Changes {
  const at = mergeBase(root, base);
  const lines: Changes["lines"] = new Map();
  let current: Set<number> | undefined;
  const patch = must(root, ["-c", "core.quotePath=false", "diff", "-U0", "-M", "--no-color", "--no-ext-diff", "--relative", "--src-prefix=a/", "--dst-prefix=b/", at]);
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      current = line.startsWith("+++ b/") ? new Set() : undefined;
      if (current !== undefined) lines.set(line.slice("+++ b/".length).replace(/\t$/, ""), current);
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk === null || current === undefined) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let n = start; n < start + count; n++) current.add(n);
  }
  for (const file of names(must(root, ["ls-files", "-z", "--others", "--exclude-standard"]))) lines.set(file, "all");
  const renames = new Map<string, string>();
  const status = names(must(root, ["diff", "-z", "-M", "--name-status", "--relative", at]));
  for (let i = 0; i < status.length; i++) {
    const kind = status[i] as string;
    if (kind.startsWith("R")) renames.set(status[i + 1] as string, status[i + 2] as string);
    i += kind.startsWith("R") || kind.startsWith("C") ? 2 : 1;
  }
  return { lines, renames };
}

export function showAtMergeBase(root: string, base: string, path: string): string | undefined {
  const spec = `${mergeBase(root, base)}:./${path}`;
  if (!git(root, ["cat-file", "-e", spec]).ok) return undefined;
  return must(root, ["show", spec]);
}
