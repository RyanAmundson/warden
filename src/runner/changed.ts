import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
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

export const hasCommit = (root: string, ref: string): boolean => git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok;

const must = (root: string, args: string[]): string => {
  const r = git(root, args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.err.trim()}`);
  return r.out;
};

export const isRepository = (root: string): boolean => git(root, ["rev-parse", "--is-inside-work-tree"]).ok;

export interface MissingBase {
  base: string;
  tracking?: string;
  remote?: string;
}

export const checkBaseAction = ({ base, tracking, remote }: MissingBase): string => {
  if (tracking !== undefined) return `run git branch ${base} ${tracking}, then run the same warden command again`;
  if (remote !== undefined) return `run git fetch ${remote} ${base}:${base}, then run the same warden command again`;
  return "run warden check --base <an existing branch>";
};

export function verifyBase(root: string, base: string, action: (missing: MissingBase) => string): void {
  if (!isRepository(root)) {
    throw new RecordError(root, "", "not a git repository");
  }
  if (hasCommit(root, base)) return;
  const lines = (args: string[]): string[] => must(root, args).split("\n").filter((l) => l !== "");
  const tracking = lines(["for-each-ref", "--format=%(refname:lstrip=2)", `refs/remotes/*/${base}`])[0];
  const remote = tracking === undefined ? lines(["remote"]).find((r) => git(root, ["ls-remote", "--exit-code", "--heads", r, base]).ok) : undefined;
  throw new RecordError("", "/base", `base ref "${base}" does not exist. Next action: ${action({ base, ...(tracking === undefined ? {} : { tracking }), ...(remote === undefined ? {} : { remote }) })}`);
}

export function changedFiles(root: string, base: string): string[] {
  verifyBase(root, base, checkBaseAction);
  const diff = ["diff", "-z", "--name-only", "--relative", "--diff-filter=ACMR"];
  const files = [
    ...names(must(root, [...diff, `${base}...HEAD`])),
    ...names(must(root, [...diff, "--cached"])),
    ...names(must(root, diff)),
    ...names(must(root, ["ls-files", "-z", "--others", "--exclude-standard"])),
  ];
  return [...new Set(files)].sort();
}

export const headCommit = (root: string): string | undefined => {
  const r = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return r.ok ? r.out.trim() : undefined;
};

export const matchesHead = (root: string, path: string): boolean => must(root, ["status", "--porcelain", "-z", "--ignored", "--", path]) === "";

export const containsHead = (root: string, ref: string): boolean => git(root, ["merge-base", "--is-ancestor", "HEAD", ref]).ok;

export function historyOf(root: string, path: string): string[] {
  const commits = names(must(root, ["log", "-z", "--full-history", "--format=%H", "HEAD", "--", path]));
  if (commits.length === 0) return [];
  const out = execFileSync("git", ["cat-file", "--batch"], { cwd: root, input: commits.map((sha) => `${sha}:./${path}\n`).join(""), maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "pipe"] });
  const texts: string[] = [];
  for (let at = 0; at < out.length; ) {
    const end = out.indexOf(10, at);
    const header = out.subarray(at, end).toString("utf8");
    at = end + 1;
    if (header.endsWith(" missing")) continue;
    const size = Number(header.slice(header.lastIndexOf(" ") + 1));
    texts.push(out.subarray(at, at + size).toString("utf8"));
    at += size + 1;
  }
  return texts;
}

export const stageFile = (root: string, path: string): void => {
  must(root, ["add", "--", path]);
};

export const unstagedFiles = (root: string): string[] => names(must(root, ["diff", "-z", "--name-only", "--relative"]));

export function lastCommittedText(root: string, path: string): string | undefined {
  if (!isRepository(root)) return undefined;
  const head = git(root, ["show", `HEAD:./${path}`]);
  if (head.ok) return head.out;
  const last = git(root, ["log", "-1", "--format=%H", "--", path]);
  if (!last.ok || last.out.trim() === "") return undefined;
  const before = git(root, ["show", `${last.out.trim()}^:./${path}`]);
  return before.ok ? before.out : undefined;
}

export const mergeBase = (root: string, base: string): string => {
  const r = git(root, ["merge-base", base, "HEAD"]);
  if (r.ok) return r.out.trim();
  if (git(root, ["rev-parse", "--is-shallow-repository"]).out.trim() === "true") {
    throw new RecordError("", "/base", `${base} and HEAD have no merge base in this shallow clone. Next action: run git fetch --unshallow, then run warden check --base ${base} again.`);
  }
  throw new RecordError("", "/base", `${base} and HEAD share no history. Next action: run warden check --base <the branch this work merges into>.`);
};

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

export const indexTree = (root: string): string | undefined => {
  const r = git(root, ["write-tree"]);
  return r.ok ? r.out.trim() : undefined;
};

export const commonDir = (root: string): string => resolve(root, must(root, ["rev-parse", "--git-common-dir"]).trim());

export interface Committed {
  commit: string;
  tree: string;
  parents: string[];
  parentTree?: string;
}

export interface Worktree {
  path: string;
  head?: string;
}

export function worktrees(root: string): Worktree[] {
  return must(root, ["worktree", "list", "--porcelain"])
    .split("\n\n")
    .flatMap((block) => {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      const head = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1];
      return path === undefined ? [] : [{ path, ...(head === undefined ? {} : { head }) }];
    });
}

export const repoTips = (root: string): string[] =>
  [...new Set([...must(root, ["for-each-ref", "--format=%(objectname)", "refs/heads"]).split("\n").filter((l) => l !== ""), ...worktrees(root).flatMap((w) => (w.head === undefined ? [] : [w.head]))])].sort();

export function newCommits(root: string, tips: string[], seen: string[]): Committed[] {
  if (tips.length === 0) return [];
  const range = [...tips, ...seen.filter((t) => hasCommit(root, t)).map((t) => `^${t}`)];
  const commits = must(root, ["log", "--no-merges", "--format=%H %T %P", ...range, "--"])
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const [commit, tree, ...parents] = l.split(" ") as [string, string, ...string[]];
      return { commit, tree, parents: parents.filter((p) => p !== "") };
    });
  const parents = [...new Set(commits.flatMap((c) => c.parents))];
  const trees = new Map(
    parents.length === 0
      ? []
      : must(root, ["log", "--no-walk=unsorted", "--format=%H %T", ...parents, "--"])
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => l.split(" ") as [string, string]),
  );
  return commits.map((c) => ({ ...c, ...(c.parents[0] === undefined ? {} : { parentTree: trees.get(c.parents[0]) }) }));
}

export const isAncestor = (root: string, ancestor: string, of: string): boolean => git(root, ["merge-base", "--is-ancestor", ancestor, of]).ok;

export function restoreAction(root: string, path: string): string {
  if (git(root, ["cat-file", "-e", `HEAD:${path}`]).ok) return `run git checkout HEAD -- .warden in ${root}`;
  const removedBy = git(root, ["rev-list", "-1", "HEAD", "--", path]).out.trim();
  if (removedBy === "") return `run warden init in ${root}`;
  return `run git checkout ${removedBy}^ -- .warden in ${root}`;
}
