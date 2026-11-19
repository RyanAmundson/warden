import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { closeSync, existsSync, lstatSync, openSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { RecordError } from "../records/load.js";

const noGrafts = join(tmpdir(), `warden-no-grafts-${randomUUID()}`);

const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_GRAFT_FILE: noGrafts,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.commitGraph",
  GIT_CONFIG_VALUE_0: "false",
});

const git = (root: string, args: string[]): { ok: boolean; out: string; err: string } => {
  try {
    return { ok: true, out: execFileSync("git", args, { cwd: root, env: env(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), err: "" };
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
  const out = execFileSync("git", ["cat-file", "--batch"], { cwd: root, env: env(), input: commits.map((sha) => `${sha}:./${path}\n`).join(""), maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "pipe"] });
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

export const trackedFiles = (root: string, paths: string[]): Set<string> => new Set(paths.length === 0 ? [] : names(must(root, ["--literal-pathspecs", "ls-files", "-z", "--cached", "--", ...paths])));

export const stagedFiles = (root: string): string[] => names(must(root, ["diff", "-z", "--name-only", "--relative", "--cached", "HEAD"]));

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
  expectedTree?: string;
}

export interface Worktree {
  path: string;
  head?: string;
}

const UNBORN = /^0+$/;

export function worktrees(root: string): Worktree[] {
  return must(root, ["worktree", "list", "--porcelain"])
    .split("\n\n")
    .flatMap((block) => {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      const head = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1];
      return path === undefined ? [] : [{ path, ...(head === undefined || UNBORN.test(head) ? {} : { head }) }];
    });
}

export const repoTips = (root: string): string[] =>
  [...new Set([...must(root, ["for-each-ref", "--format=%(objectname)", "refs/heads"]).split("\n").filter((l) => l !== ""), ...worktrees(root).flatMap((w) => (w.head === undefined ? [] : [w.head]))])].sort();

const mergedTree = (root: string, parents: string[]): string | undefined => {
  if (parents.length !== 2) return undefined;
  const r = git(root, ["merge-tree", "--write-tree", ...parents]);
  return r.ok || r.out !== "" ? r.out.split("\n")[0] : undefined;
};

const described = (root: string, range: string[]): Committed[] => {
  const commits = must(root, ["log", "--format=%H %T %P", ...range, "--"])
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const [commit, tree, ...parents] = l.split(" ") as [string, string, ...string[]];
      return { commit, tree, parents: parents.filter((p) => p !== "") };
    });
  const single = [...new Set(commits.flatMap((c) => (c.parents.length === 1 ? c.parents : [])))];
  const trees = new Map(
    single.length === 0
      ? []
      : must(root, ["log", "--no-walk=unsorted", "--format=%H %T", ...single, "--"])
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => l.split(" ") as [string, string]),
  );
  return commits.map((c) => {
    const expectedTree = c.parents.length === 1 ? trees.get(c.parents[0] as string) : mergedTree(root, c.parents);
    return { ...c, ...(expectedTree === undefined ? {} : { expectedTree }) };
  });
};

const FETCHED = /^(fetch|pull|clone)/;

export function fetchedTips(root: string): string[] {
  const remotes = must(root, ["remote"]).split("\n").filter((r) => r !== "");
  const refs = remotes.flatMap((r) => must(root, ["for-each-ref", "--format=%(refname)", `refs/remotes/${r}/`]).split("\n").filter((l) => l !== ""));
  return [
    ...new Set(
      refs.flatMap((ref) => {
        const r = git(root, ["reflog", "show", "--format=%H%x09%gs", ref, "--"]);
        return r.ok ? r.out.split("\n").flatMap((line) => {
          const [sha, subject] = line.split("\t");
          return sha !== undefined && sha !== "" && FETCHED.test(subject ?? "") ? [sha] : [];
        }) : [];
      }),
    ),
  ];
}

export function newCommits(root: string, tips: string[], seen: string[]): Committed[] {
  if (tips.length === 0) return [];
  return described(root, [...tips, ...[...seen, ...fetchedTips(root)].filter((t) => hasCommit(root, t)).map((t) => `^${t}`)]);
}

export const allTips = (root: string): string[] => [...new Set([...must(root, ["for-each-ref", "--format=%(objectname)"]).split("\n").filter((l) => l !== ""), ...repoTips(root)])];

export const covers = (root: string, run: { tree?: string; mergeBase?: string }, c: Committed): boolean => {
  const parent = c.parents[0];
  return run.tree === c.tree && (parent === undefined || (run.mergeBase !== undefined && (run.mergeBase === parent || isAncestor(root, run.mergeBase, parent))));
};

export interface StagedBlob {
  path: string;
  sha: string;
}

export interface StagedMismatch {
  paths: string[];
  hidden: string[];
  absent: StagedBlob[];
}

export function writeBlob(root: string, sha: string, file: string): void {
  const fd = openSync(file, "w");
  try {
    execFileSync("git", ["cat-file", "blob", sha], { cwd: root, env: env(), stdio: ["ignore", fd, "pipe"] });
  } finally {
    closeSync(fd);
  }
}

export function stagedMismatch(root: string, base: string): StagedMismatch {
  const literal = (args: string[]): string[] => names(must(root, ["--literal-pathspecs", ...args]));
  const staged = literal(["diff", "-z", "--cached", "--name-only", "--relative", "--no-renames", "--diff-filter=AM", mergeBase(root, base)]);
  if (staged.length === 0) return { paths: [], hidden: [], absent: [] };
  const index = new Map(
    literal(["ls-files", "-s", "-z", "--", ...staged]).map((line) => {
      const [meta = "", path = ""] = line.split("\t");
      const [mode, sha] = meta.split(" ");
      return [path, { mode, sha }] as const;
    }),
  );
  const tags = new Map(literal(["ls-files", "-v", "-z", "--", ...staged]).map((line) => [line.slice(2), line[0] as string] as const));
  const regular = staged.filter((p) => index.get(p)?.mode === "100644" || index.get(p)?.mode === "100755");
  const present = regular.filter((p) => existsSync(join(root, p)) && lstatSync(join(root, p)).isFile());
  const hashes = present.length === 0 ? [] : must(root, ["--literal-pathspecs", "hash-object", "--", ...present]).trim().split("\n");
  const work = new Map(present.map((p, i) => [p, hashes[i]]));
  const absent = new Set(regular.filter((p) => tags.get(p)?.toUpperCase() === "S" && !existsSync(join(root, p))));
  const paths = regular.filter((p) => !absent.has(p) && work.get(p) !== index.get(p)?.sha);
  return { paths, hidden: paths.filter((p) => tags.get(p) === "S" || /^[a-z]$/.test(tags.get(p) ?? "")), absent: [...absent].map((path) => ({ path, sha: index.get(path)?.sha as string })) };
}

export function commitsOf(root: string, shas: string[]): Committed[] {
  const known = shas.filter((sha) => hasCommit(root, sha));
  return known.length === 0 ? [] : described(root, ["--no-walk=unsorted", ...known]);
}

export const isAncestor = (root: string, ancestor: string, of: string): boolean => git(root, ["merge-base", "--is-ancestor", ancestor, of]).ok;

export const reachable = (root: string, sha: string, tips: string[]): boolean => hasCommit(root, sha) && tips.some((tip) => isAncestor(root, sha, tip));

export function restoreAction(root: string, path: string): string {
  if (git(root, ["cat-file", "-e", `HEAD:${path}`]).ok) return `run git checkout HEAD -- .warden in ${root}`;
  const removedBy = git(root, ["rev-list", "-1", "HEAD", "--", path]).out.trim();
  if (removedBy === "") return `run warden init in ${root}`;
  return `run git checkout ${removedBy}^ -- .warden in ${root}`;
}

export interface Restore {
  base: string;
  paths: string[];
  known: string[];
  stray: string[];
  unstage: string[];
  aliased: boolean;
}

export interface Signatures {
  files: Map<string, string>;
  restore: Restore;
}

export function changeSignatures(root: string, base: string, dir: string, allowedSignersFile: string, staged: boolean, alongside: string[]): Signatures {
  const at = mergeBase(root, base);
  const icase = git(root, ["config", "--bool", "core.ignorecase"]).out.trim() === "true";
  const spec = `:(literal${icase ? ",icase" : ""})${dir}`;
  const diff = (...trees: string[]): string[] => names(must(root, ["diff", "-z", "--name-only", "--no-renames", "--ignore-submodules=none", "--relative", ...trees, "--", spec]));
  const committed = diff(at, "HEAD");
  const judged = staged ? diff("--cached", at) : committed;
  const scope = [...new Set([...committed, ...judged])];
  const files = new Map<string, string>();
  if (scope.length === 0) return { files, restore: { base: at, paths: [], known: [], stray: [], unstage: [], aliased: false } };
  const verify = ["-c", "gpg.ssh.program=ssh-keygen", "-c", "gpg.program=false", "-c", "gpg.x509.program=false", "-c", `gpg.ssh.allowedSignersFile=${allowedSignersFile}`, "--literal-pathspecs"];
  const mark = `\x01${randomUUID()}`;
  const log = must(root, [...verify, "log", "-z", "--topo-order", "--diff-merges=dense-combined", "--no-renames", "--ignore-submodules=none", "--relative", "--name-only", `--format=${mark}%G?`, `${at}..HEAD`, "--", ...scope]);
  const seen = new Set<string>();
  const bad = new Map<string, string>();
  for (const entry of log.split(mark).slice(1)) {
    const end = entry.search(/[\n\0]/);
    const status = entry[0] as string;
    for (const path of names(entry.slice(end + 1).replace(/^\n/, ""))) {
      seen.add(path);
      if (status !== "G" && !bad.has(path)) bad.set(path, status);
    }
  }
  for (const path of committed) if (!seen.has(path)) bad.set(path, "N");
  for (const path of judged) if (bad.has(path)) files.set(path, bad.get(path) as string);
  const paths = [...new Set([...bad.keys(), ...scope.filter((p) => alongside.includes(p))])].sort();
  const listed = (args: string[]): string[] => (paths.length === 0 ? [] : names(must(root, ["--literal-pathspecs", ...args, "--", ...paths])));
  const known = [...new Set([...listed(["ls-tree", "-r", "-z", "--name-only", "--full-tree", at]), ...listed(["ls-files", "-z", "--cached"])])].sort();
  const onDisk = (p: string): string | undefined => {
    let path = dir;
    for (const part of p.slice(dir.length + 1).split("/")) {
      const entries = readdirSync(join(root, path));
      const name = entries.includes(part) ? part : icase ? entries.find((e) => e.toLowerCase() === part.toLowerCase()) : undefined;
      if (name === undefined) return undefined;
      path = `${path}/${name}`;
      const entry = lstatSync(join(root, path));
      if (entry.isSymbolicLink() || !entry.isDirectory()) return path;
    }
    return path;
  };
  const stray = [...new Set(paths.filter((p) => !known.includes(p)).map(onDisk).filter((p) => p !== undefined))].sort();
  const indexed = names(must(root, ["ls-files", "-z", "--cached", "--", spec]));
  const same = (a: string, b: string): boolean => a === b || (icase && a.toLowerCase() === b.toLowerCase());
  const unstage = stray.filter((p) => lstatSync(join(root, p)).isSymbolicLink()).flatMap((p) => indexed.filter((e) => same(e, p)));
  const aliased = new Set(paths.map((p) => p.toLowerCase())).size < paths.length || (icase && paths.some((p) => indexed.some((e) => e !== p && same(e, p))));
  return { files, restore: { base: at, paths, known, stray, unstage, aliased } };
}
