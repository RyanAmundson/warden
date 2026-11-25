import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { existsSync, lstatSync, readdirSync } from "node:fs";
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

const git = (root: string, args: string[], input?: string): { ok: boolean; out: string; err: string } => {
  try {
    return { ok: true, out: execFileSync("git", args, { cwd: root, env: env(), encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }), err: "" };
  } catch (cause) {
    const e = cause as { status?: number | null; stdout?: string; stderr?: string };
    if (typeof e.status !== "number") throw cause;
    return { ok: false, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
};

const names = (text: string): string[] => text.split("\0").filter((l) => l !== "");

export const commitOf = (root: string, ref: string): string | undefined => {
  const result = git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  return result.ok ? result.out.trim() : undefined;
};

export const hasCommit = (root: string, ref: string): boolean => commitOf(root, ref) !== undefined;

interface BaseCommit {
  name: string;
  commit: string;
}

export type BaseRef = string | BaseCommit;

const baseName = (base: BaseRef): string => typeof base === "string" ? base : base.name;

export function resolveBaseCommit(root: string, name: string): BaseCommit | undefined {
  const local = commitOf(root, name);
  if (local === undefined) return undefined;
  const head = "refs/heads/";
  const ref = name === "HEAD" || name === "@" ? "" : git(root, ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", name]).out.trim();
  if (!ref.startsWith(head)) return { name, commit: local };
  const fromOrigin = git(root, ["show-ref", "--hash", "--verify", `refs/remotes/origin/${ref.slice(head.length)}`]);
  if (fromOrigin.ok) return { name, commit: fromOrigin.out.trim() };
  const upstream = git(root, ["for-each-ref", "--count=1", "--format=%(upstream)", ref]).out.trim();
  return { name, commit: upstream.startsWith("refs/remotes/") ? (commitOf(root, upstream) ?? local) : local };
}

const comparisonCommit = (root: string, base: BaseRef): string =>
  typeof base === "string" ? (resolveBaseCommit(root, base)?.commit ?? base) : base.commit;

const must = (root: string, args: string[], input?: string): string => {
  const r = git(root, args, input);
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

export function verifyBase(root: string, base: string, action: (missing: MissingBase) => string): BaseCommit {
  if (!isRepository(root)) {
    throw new RecordError(root, "", "not a git repository");
  }
  const selected = resolveBaseCommit(root, base);
  if (selected !== undefined) return selected;
  const lines = (args: string[]): string[] => must(root, args).split("\n").filter((l) => l !== "");
  const tracking = lines(["for-each-ref", "--format=%(refname:lstrip=2)", `refs/remotes/*/${base}`])[0];
  const remote = tracking === undefined ? lines(["remote"]).find((r) => git(root, ["ls-remote", "--exit-code", "--heads", r, base]).ok) : undefined;
  throw new RecordError("", "/base", `base ref "${base}" does not exist. Next action: ${action({ base, ...(tracking === undefined ? {} : { tracking }), ...(remote === undefined ? {} : { remote }) })}`);
}

export function changedFiles(root: string, base: BaseRef): string[] {
  const selected = typeof base === "string" ? verifyBase(root, base, checkBaseAction) : base;
  const diff = ["diff", "-z", "--name-only", "--relative", "--diff-filter=ACMR"];
  const files = [
    ...names(must(root, [...diff, `${selected.commit}...HEAD`])),
    ...names(must(root, [...diff, "--cached"])),
    ...names(must(root, diff)),
    ...names(must(root, ["ls-files", "-z", "--others", "--exclude-standard"])),
  ];
  return [...new Set(files)].sort();
}

export const commitChanges = (root: string, commit: string, path: string): boolean => {
  const diff = git(root, ["diff-tree", "-r", "-m", "--first-parent", "--root", "--no-commit-id", "--name-only", commit, "--", path]);
  return !diff.ok || diff.out.trim() !== "";
};

export const stagedText = (root: string, path: string): string | undefined => {
  const shown = git(root, ["show", `:${path}`]);
  return shown.ok ? shown.out : undefined;
};

export const headCommit = (root: string): string | undefined => {
  const r = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return r.ok ? r.out.trim() : undefined;
};

export const cleanHead = (root: string): string | undefined =>
  must(root, ["status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=none"]) === "" ? headCommit(root) : undefined;

export const matchesHead = (root: string, path: string): boolean => must(root, ["status", "--porcelain", "-z", "--ignored", "--", path]) === "";

export const containsHead = (root: string, base: BaseRef): boolean => git(root, ["merge-base", "--is-ancestor", "HEAD", comparisonCommit(root, base)]).ok;

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

export function hasPathCommitIndex(root: string): boolean {
  const index = process.env.GIT_INDEX_FILE;
  if (index === undefined) return false;
  const file = resolve(root, index);
  const gitDir = must(root, ["rev-parse", "--absolute-git-dir"]).trim();
  const selected = join(gitDir, `next-index-${process.ppid}.lock`);
  return file === selected && lstatSync(selected, { throwIfNoEntry: false })?.isFile() === true;
}

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

export const mergeBase = (root: string, comparison: BaseRef): string => {
  const r = git(root, ["merge-base", comparisonCommit(root, comparison), "HEAD"]);
  return checkedMergeBase(root, comparison, r);
};

export async function mergeBaseForScan(root: string, comparison: BaseRef, head: string | undefined): Promise<string> {
  const args = ["merge-base", comparisonCommit(root, comparison), head ?? "HEAD"];
  const result = await new Promise<{ ok: boolean; out: string }>((resolve, reject) => {
    const child = execFile("git", args, { cwd: root, env: env(), encoding: "utf8" }, (error, out) => {
      if (error !== null && typeof error.code !== "number") reject(error);
      else resolve({ ok: error === null, out });
    });
    child.stdin?.end();
  });
  return checkedMergeBase(root, comparison, result);
}

function checkedMergeBase(root: string, comparison: BaseRef, r: { ok: boolean; out: string }): string {
  const base = baseName(comparison);
  if (r.ok) return r.out.trim();
  if (git(root, ["rev-parse", "--is-shallow-repository"]).out.trim() === "true") {
    throw new RecordError("", "/base", `${base} and HEAD have no merge base in this shallow clone. Next action: run git fetch --unshallow, then run warden check --base ${base} again.`);
  }
  throw new RecordError("", "/base", `${base} and HEAD share no history. Next action: run warden check --base <the branch this work merges into>.`);
}

export interface Changes {
  lines: Map<string, Set<number> | "all">;
  renames: Map<string, string>;
}

const HUNK = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/;

async function gitRecords(root: string, args: string[], delimiter: string, receive: (record: string) => void, input?: string): Promise<string | undefined> {
  const child = spawn("git", args, { cwd: root, env: env(), stdio: ["pipe", "pipe", "pipe"] });
  let error = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    if (error.length < 4096) error += chunk.slice(0, 4096 - error.length);
  });
  const completed = new Promise<string | undefined>((done) => {
    child.once("error", (cause) => done(cause.message));
    child.once("close", (code, signal) => done(code === 0 ? undefined : error.trim() || `git stopped with ${signal ?? `exit ${code}`}`));
  });
  const written = new Promise<void>((resolve, reject) => {
    child.stdin.once("error", reject);
    child.stdin.end(input, resolve);
  });
  const inputError = written.catch((cause: NodeJS.ErrnoException) => cause);
  try {
    let remainder = "";
    for await (const chunk of child.stdout.setEncoding("utf8") as AsyncIterable<string>) {
      const rows = (remainder + chunk).split(delimiter);
      remainder = rows.pop() as string;
      for (const line of rows) receive(line);
    }
    if (remainder !== "") receive(remainder);
  } catch (cause) {
    child.kill();
    await completed;
    throw cause;
  }
  return (await completed) ?? (await inputError)?.message;
}

async function gitLines(root: string, args: string[], input?: string): Promise<string[]> {
  const lines: string[] = [];
  const error = await gitRecords(root, args, "\n", (line) => lines.push(line), input);
  if (error !== undefined) throw new Error(`git ${args[0]} failed: ${error}`);
  return lines;
}

async function patchLines(root: string, at: string, stagedOnly: boolean, receive: (line: string) => void): Promise<void> {
  const args = ["-c", "core.quotePath=false", "diff", "-U0", "-M", "--no-color", "--no-ext-diff", "--relative", "--src-prefix=a/", "--dst-prefix=b/", ...(stagedOnly ? ["--cached"] : []), at, "--"];
  const failure = await gitRecords(root, args, "\n", receive);
  if (failure !== undefined) {
    throw new RecordError(root, "", `Git could not read the changed lines: ${failure}. Next action: run git diff from the project root to diagnose the Git error.`);
  }
}

export async function listWorktreeEntries(root: string): Promise<Map<string, boolean>> {
  const entries = new Map<string, boolean>();
  const indexed = await gitRecords(root, ["ls-files", "-z", "--stage"], "\0", (record) => {
    const file = record.slice(record.indexOf("\t") + 1);
    entries.set(file, entries.get(file) === true || record.startsWith("160000 "));
  });
  if (indexed !== undefined) {
    throw new RecordError(root, "", `Git could not read tracked paths: ${indexed}. Next action: run git ls-files --stage from the project root to diagnose the Git error.`);
  }
  const untracked = await gitRecords(root, ["ls-files", "-z", "--others", "--exclude-standard"], "\0", (file) => {
    if (!entries.has(file)) entries.set(file, false);
  });
  if (untracked !== undefined) {
    throw new RecordError(root, "", `Git could not read untracked paths: ${untracked}. Next action: run git ls-files --others --exclude-standard from the project root to diagnose the Git error.`);
  }
  return entries;
}

export async function skippedIndexPaths(root: string, paths?: Set<string>): Promise<Set<string>> {
  const skipped = new Set<string>();
  if (paths?.size === 0) return skipped;
  const failure = await gitRecords(root, ["ls-files", "-t", "-z"], "\0", (row) => {
    const path = row.slice(2);
    if (row.startsWith("S ") && (paths === undefined || paths.has(path))) skipped.add(path);
  });
  if (failure !== undefined) {
    throw new RecordError(root, "", `Git could not read sparse checkout paths: ${failure}. Next action: run git ls-files -t from the project root to diagnose the Git error.`);
  }
  return skipped;
}

export async function changesSinceMergeBase(root: string, base: BaseRef, stagedOnly = false): Promise<Changes> {
  const at = mergeBase(root, base);
  const lines: Changes["lines"] = new Map();
  let current: Set<number> | undefined;
  await patchLines(root, at, stagedOnly, (line) => {
    if (line.startsWith("+++ ")) {
      current = line.startsWith("+++ b/") ? new Set() : undefined;
      if (current !== undefined) lines.set(line.slice("+++ b/".length).replace(/\t$/, ""), current);
      return;
    }
    const hunk = HUNK.exec(line);
    if (hunk === null || current === undefined) return;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let n = start; n < start + count; n++) current.add(n);
  });
  if (!stagedOnly) for (const file of names(must(root, ["ls-files", "-z", "--others", "--exclude-standard"]))) lines.set(file, "all");
  return { lines, renames: await renamesAt(root, at, stagedOnly) };
}

export async function renamesAt(root: string, at: string, stagedOnly = false): Promise<Changes["renames"]> {
  const entries: string[] = [];
  const args = ["diff", "-z", "-M", "--name-status", "--relative", ...(stagedOnly ? ["--cached"] : []), at];
  const error = await gitRecords(root, args, "\0", (entry) => entries.push(entry));
  if (error !== undefined) throw new Error(`git diff failed: ${error}`);
  return parseRenames(entries);
}

function parseRenames(status: string[]): Changes["renames"] {
  const renames = new Map<string, string>();
  for (let i = 0; i < status.length; i++) {
    const kind = status[i] as string;
    if (kind.startsWith("R")) renames.set(status[i + 1] as string, status[i + 2] as string);
    i += kind.startsWith("R") || kind.startsWith("C") ? 2 : 1;
  }
  return renames;
}

interface TreeBlob {
  mode: string;
  oid: string;
}

export async function treeBlobsAt(root: string, at: string, folders: string[]): Promise<Map<string, TreeBlob>> {
  const result = new Map<string, TreeBlob>();
  const failure = await gitRecords(root, ["--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", at, "--", ...folders], "\0", (row) => {
    const tab = row.indexOf("\t");
    const match = /^(100[067][0-7]{2}) blob ([a-f0-9]+)$/.exec(row.slice(0, tab));
    if (match !== null) result.set(row.slice(tab + 1), { mode: match[1] as string, oid: match[2] as string });
  });
  if (failure !== undefined) throw new RecordError(root, "", `Git could not read the comparison tree: ${failure}. Next action: inspect that commit with git ls-tree, then rerun the check.`);
  return result;
}

export async function blobHeader(root: string, oid: string, size: number): Promise<string> {
  const child = spawn("git", ["cat-file", "blob", oid], { cwd: root, env: env(), stdio: ["ignore", "pipe", "ignore"] });
  const header = Buffer.alloc(size);
  let length = 0;
  let stopped = false;
  const completed = new Promise<boolean>((done) => {
    child.once("error", () => done(false));
    child.once("close", (code, signal) => done(code === 0 || (stopped && (signal === "SIGTERM" || signal === "SIGPIPE"))));
  });
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      length += chunk.copy(header, length, 0, size - length);
      if (length === size) {
        stopped = child.kill();
        break;
      }
    }
  } finally {
    if (length < size && child.exitCode === null && child.signalCode === null) child.stdout.resume();
    if (!await completed) throw new RecordError(root, "", `Git could not read blob ${oid}. Next action: verify the comparison commit is available locally, then rerun the check.`);
  }
  return header.toString("utf8", 0, length);
}

export function showAtCommit(root: string, commit: string, path: string): string | undefined {
  const spec = `${commit}:./${path}`;
  if (!git(root, ["cat-file", "-e", spec]).ok) return undefined;
  return must(root, ["show", spec]);
}

export const showAtMergeBase = (root: string, base: BaseRef, path: string): string | undefined =>
  showAtCommit(root, mergeBase(root, base), path);

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
  detached?: boolean;
}

const UNBORN = /^0+$/;

export async function worktrees(root: string): Promise<Worktree[]> {
  return (await gitLines(root, ["worktree", "list", "--porcelain"])).join("\n")
    .split("\n\n")
    .flatMap((block) => {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      const head = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1];
      return path === undefined ? [] : [{ path, ...(head === undefined || UNBORN.test(head) ? {} : { head }), ...(/^detached$/m.test(block) ? { detached: true } : {}) }];
    });
}

export async function repoTips(root: string, trees: Worktree[]): Promise<string[]> {
  const branches = await gitLines(root, ["for-each-ref", "--format=%(objectname)", "refs/heads"]);
  return [...new Set([...branches, ...trees.flatMap((w) => (w.head === undefined ? [] : [w.head]))])].sort();
}

const mergedTree = (root: string, parents: string[]): string | undefined => {
  if (parents.length !== 2) return undefined;
  const r = git(root, ["merge-tree", "--write-tree", ...parents]);
  return r.ok || r.out !== "" ? r.out.split("\n")[0] : undefined;
};

const describeCommits = (root: string, lines: string[]): Committed[] => {
  const commits = lines
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
const described = (root: string, range: string[]): Committed[] =>
  describeCommits(root, must(root, ["log", "--format=%H %T %P", ...range, "--"]).split("\n"));

const FETCHED = /^(fetch|pull|clone)/;

export async function fetchedTips(root: string): Promise<string[]> {
  const remotes = must(root, ["remote"]).split("\n").filter((r) => r !== "");
  const refs = remotes.flatMap((r) => must(root, ["for-each-ref", "--format=%(refname)", `refs/remotes/${r}/`]).split("\n").filter((l) => l !== ""));
  if (refs.length === 0) return [];
  const log = await gitLines(root, ["reflog", "show", "--format=%H%x09%gs", "--stdin", "--"], refs.join("\n") + "\n");
  return [...new Set(log.flatMap((line) => {
    const [sha, subject] = line.split("\t");
    return sha !== undefined && sha !== "" && FETCHED.test(subject ?? "") ? [sha] : [];
  }))];
}

export async function newCommits(root: string, tips: string[], seen: string[]): Promise<Committed[]> {
  const previous = new Set(seen);
  if (tips.every((tip) => previous.has(tip))) return [];
  const revisions = [...new Set([...seen, ...await fetchedTips(root)])];
  const known = (await gitLines(root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], revisions.map((tip) => `${tip}^{commit}\n`).join("")))
    .filter((line) => line.endsWith(" commit"))
    .map((line) => `^${line.split(" ")[0]}\n`);
  return describeCommits(root, await gitLines(root, ["log", "--format=%H %T %P", "--stdin", "--"], [...tips.map((tip) => `${tip}\n`), ...known].join("")));
}

export const allTips = async (root: string, tips: string[]): Promise<string[]> => [...new Set([...await gitLines(root, ["for-each-ref", "--format=%(objectname)"]), ...tips])];

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
  inherited?: StagedBlob[];
}

export function checkoutBlobs(root: string, paths: string[], dir: string): string {
  execFileSync("git", ["--literal-pathspecs", "checkout-index", `--prefix=${dir}/`, "--ignore-skip-worktree-bits", "-z", "--stdin"], { cwd: root, env: env(), input: paths.map((p) => `${p}\0`).join(""), stdio: ["pipe", "ignore", "pipe"] });
  return join(dir, must(root, ["rev-parse", "--show-prefix"]).trim());
}

export type SparseMode = "cone" | "patterns" | "off";

export const sparseMode = (root: string): SparseMode => {
  const on = (key: string): boolean => git(root, ["config", "--bool", key]).out.trim() === "true";
  return !on("core.sparseCheckout") ? "off" : on("core.sparseCheckoutCone") ? "cone" : "patterns";
};

export function stagedMismatch(root: string, base: BaseRef, readInherited = false): StagedMismatch {
  const literal = (args: string[]): string[] => names(must(root, ["--literal-pathspecs", ...args]));
  const at = mergeBase(root, base);
  const changed = (against: string): string[] => literal(["diff", "-z", "--cached", "--name-only", "--relative", "--no-renames", "--diff-filter=AMT", against]);
  const selected = new Set(changed("HEAD"));
  const staged = [...new Set([...changed(at), ...selected])];
  if (staged.length === 0) return { paths: [], hidden: [], absent: [] };
  const index = new Map(
    literal(["ls-files", "-s", "-z", "--", ...staged]).map((line) => {
      const separator = line.indexOf("\t");
      const [mode, sha] = line.slice(0, separator).split(" ");
      return [line.slice(separator + 1), { mode, sha }] as const;
    }),
  );
  const tags = new Map(literal(["ls-files", "-v", "-z", "--", ...staged]).map((line) => [line.slice(2), line[0] as string] as const));
  const regular = staged.filter((p) => index.get(p)?.mode === "100644" || index.get(p)?.mode === "100755");
  const present = regular.filter((p) => existsSync(join(root, p)) && lstatSync(join(root, p)).isFile());
  const hashes = present.length === 0 ? [] : must(root, ["--literal-pathspecs", "hash-object", "--", ...present]).trim().split("\n");
  const work = new Map(present.map((p, i) => [p, hashes[i]]));
  const absent = new Set(regular.filter((p) => tags.get(p)?.toUpperCase() === "S" && !existsSync(join(root, p))));
  const paths = regular.filter((p) => !absent.has(p) && work.get(p) !== index.get(p)?.sha);
  const hidden = paths.filter((p) => tags.get(p) === "S" || /^[a-z]$/.test(tags.get(p) ?? ""));
  const inherited = new Set(readInherited ? paths.filter((p) => !selected.has(p) && !hidden.includes(p)) : []);
  const blobs = (files: Iterable<string>): StagedBlob[] => [...files].map((path) => ({ path, sha: index.get(path)?.sha as string }));
  return {
    paths: paths.filter((p) => !inherited.has(p)), hidden, absent: blobs(absent),
    ...(inherited.size === 0 ? {} : { inherited: blobs(inherited) }),
  };
}

export const COMMIT_LOOKUP_BATCH = 256;

const fullObjectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function commitsOf(root: string, shas: string[]): Committed[] {
  const batchable = shas.length > 1 && shas.length <= COMMIT_LOOKUP_BATCH && shas.every((sha) => fullObjectId.test(sha));
  const known = batchable
    ? must(root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], shas.map((sha) => `${sha}^{commit}\n`).join(""))
        .split("\n")
        .flatMap((line) => line.endsWith(" commit") ? [line.slice(0, -" commit".length)] : [])
    : shas.filter((sha) => hasCommit(root, sha));
  return known.length === 0 ? [] : described(root, ["--no-walk=unsorted", ...known]);
}

export const lockVersionAt = (root: string, commit: string): string | undefined => {
  const r = git(root, ["show", `${commit}:.warden/lock.json`]);
  if (!r.ok) return undefined;
  try {
    const version = (JSON.parse(r.out) as { warden?: unknown }).warden;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
};

export const reachableFrom = async (root: string, sha: string, tips: string[]): Promise<boolean> =>
  (await gitLines(root, ["rev-list", "-1", "--ignore-missing", "--stdin", sha], tips.map((t) => `^${t}\n`).join(""))).length === 0;

export async function holdersOf(root: string, sha: string, trees: Worktree[]): Promise<string[]> {
  const refs: string[] = [];
  const error = await gitRecords(root, ["for-each-ref", "--contains", sha, "--format=%(refname)"], "\n", (ref) => refs.push(ref));
  if (error !== undefined) throw new Error(`git for-each-ref --contains ${sha} failed: ${error}`);
  const checked = new Map<string, boolean>();
  for (const { path, detached, head } of trees) {
    if (detached !== true || head === undefined) continue;
    if (!checked.has(head)) {
      checked.set(head, (await gitRecords(root, ["merge-base", "--is-ancestor", sha, head], "\n", () => {})) === undefined);
    }
    if (checked.get(head)) refs.push(`the detached HEAD of worktree ${path}`);
  }
  return refs;
}

export const isAncestor = (root: string, ancestor: string, of: string): boolean => git(root, ["merge-base", "--is-ancestor", ancestor, of]).ok;

export const reachable = async (root: string, sha: string, tips: string[]): Promise<boolean> => hasCommit(root, sha) && await reachableFrom(root, sha, tips);

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
  aliasEntries?: string[];
}

export interface Signatures {
  files: Map<string, string>;
  restore: Restore;
}

export function changeSignatures(root: string, base: BaseRef, dir: string, allowedSignersFile: string, staged: boolean, alongside: string[]): Signatures {
  return changeSignaturesAt(root, mergeBase(root, base), "HEAD", dir, allowedSignersFile, staged, alongside);
}

export function changeSignaturesAt(root: string, at: string, head: string, dir: string, allowedSignersFile: string, staged: boolean, alongside: string[]): Signatures {
  const icase = git(root, ["config", "--bool", "core.ignorecase"]).out.trim() === "true";
  const spec = `:(literal${icase ? ",icase" : ""})${dir}`;
  const diff = (...trees: string[]): string[] => names(must(root, ["diff", "-z", "--name-only", "--no-renames", "--ignore-submodules=none", "--relative", ...trees, "--", spec]));
  const committed = diff(at, head);
  const judged = staged ? diff("--cached", at) : committed;
  const scope = [...new Set([...committed, ...judged])];
  const files = new Map<string, string>();
  if (scope.length === 0) return { files, restore: { base: at, paths: [], known: [], stray: [], unstage: [], aliased: false } };
  const verify = ["-c", "gpg.ssh.program=ssh-keygen", "-c", "gpg.program=false", "-c", "gpg.x509.program=false", "-c", `gpg.ssh.allowedSignersFile=${allowedSignersFile}`, "--literal-pathspecs"];
  const mark = `\x01${randomUUID()}`;
  const log = must(root, [...verify, "log", "-z", "--topo-order", "--diff-merges=dense-combined", "--no-renames", "--ignore-submodules=none", "--relative", "--name-only", `--format=${mark}%G?`, `${at}..${head}`, "--", ...scope]);
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
  const baseEntries = listed(["ls-tree", "-r", "-z", "--name-only", "--full-tree", at]);
  const known = [...new Set([...baseEntries, ...listed(["ls-files", "-z", "--cached"])])].sort();
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
  const candidates = [...paths, ...indexed];
  const aliasEntries = aliased && icase ? baseEntries.filter((p) => candidates.some((e) => e !== p && same(e, p))) : [];
  return { files, restore: { base: at, paths, known, stray, unstage, aliased, ...(aliasEntries.length === 0 ? {} : { aliasEntries }) } };
}
