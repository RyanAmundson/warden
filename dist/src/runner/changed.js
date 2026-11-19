import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RecordError } from "../records/load.js";
const noGrafts = join(tmpdir(), `warden-no-grafts-${randomUUID()}`);
const env = () => ({
    ...process.env,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: noGrafts,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.commitGraph",
    GIT_CONFIG_VALUE_0: "false",
});
const git = (root, args) => {
    try {
        return { ok: true, out: execFileSync("git", args, { cwd: root, env: env(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), err: "" };
    }
    catch (cause) {
        const e = cause;
        if (typeof e.status !== "number")
            throw cause;
        return { ok: false, out: e.stdout ?? "", err: e.stderr ?? "" };
    }
};
const names = (text) => text.split("\0").filter((l) => l !== "");
export const hasCommit = (root, ref) => git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok;
const must = (root, args) => {
    const r = git(root, args);
    if (!r.ok)
        throw new Error(`git ${args.join(" ")} failed: ${r.err.trim()}`);
    return r.out;
};
export const isRepository = (root) => git(root, ["rev-parse", "--is-inside-work-tree"]).ok;
export const checkBaseAction = ({ base, tracking, remote }) => {
    if (tracking !== undefined)
        return `run git branch ${base} ${tracking}, then run the same warden command again`;
    if (remote !== undefined)
        return `run git fetch ${remote} ${base}:${base}, then run the same warden command again`;
    return "run warden check --base <an existing branch>";
};
export function verifyBase(root, base, action) {
    if (!isRepository(root)) {
        throw new RecordError(root, "", "not a git repository");
    }
    if (hasCommit(root, base))
        return;
    const lines = (args) => must(root, args).split("\n").filter((l) => l !== "");
    const tracking = lines(["for-each-ref", "--format=%(refname:lstrip=2)", `refs/remotes/*/${base}`])[0];
    const remote = tracking === undefined ? lines(["remote"]).find((r) => git(root, ["ls-remote", "--exit-code", "--heads", r, base]).ok) : undefined;
    throw new RecordError("", "/base", `base ref "${base}" does not exist. Next action: ${action({ base, ...(tracking === undefined ? {} : { tracking }), ...(remote === undefined ? {} : { remote }) })}`);
}
export function changedFiles(root, base) {
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
export const headCommit = (root) => {
    const r = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return r.ok ? r.out.trim() : undefined;
};
export const matchesHead = (root, path) => must(root, ["status", "--porcelain", "-z", "--ignored", "--", path]) === "";
export const containsHead = (root, ref) => git(root, ["merge-base", "--is-ancestor", "HEAD", ref]).ok;
export function historyOf(root, path) {
    const commits = names(must(root, ["log", "-z", "--full-history", "--format=%H", "HEAD", "--", path]));
    if (commits.length === 0)
        return [];
    const out = execFileSync("git", ["cat-file", "--batch"], { cwd: root, env: env(), input: commits.map((sha) => `${sha}:./${path}\n`).join(""), maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "pipe"] });
    const texts = [];
    for (let at = 0; at < out.length;) {
        const end = out.indexOf(10, at);
        const header = out.subarray(at, end).toString("utf8");
        at = end + 1;
        if (header.endsWith(" missing"))
            continue;
        const size = Number(header.slice(header.lastIndexOf(" ") + 1));
        texts.push(out.subarray(at, at + size).toString("utf8"));
        at += size + 1;
    }
    return texts;
}
export const stageFile = (root, path) => {
    must(root, ["add", "--", path]);
};
export const unstagedFiles = (root) => names(must(root, ["diff", "-z", "--name-only", "--relative"]));
export const trackedFiles = (root, paths) => new Set(paths.length === 0 ? [] : names(must(root, ["--literal-pathspecs", "ls-files", "-z", "--cached", "--", ...paths])));
export const stagedFiles = (root) => names(must(root, ["diff", "-z", "--name-only", "--relative", "--cached", "HEAD"]));
export function lastCommittedText(root, path) {
    if (!isRepository(root))
        return undefined;
    const head = git(root, ["show", `HEAD:./${path}`]);
    if (head.ok)
        return head.out;
    const last = git(root, ["log", "-1", "--format=%H", "--", path]);
    if (!last.ok || last.out.trim() === "")
        return undefined;
    const before = git(root, ["show", `${last.out.trim()}^:./${path}`]);
    return before.ok ? before.out : undefined;
}
export const mergeBase = (root, base) => {
    const r = git(root, ["merge-base", base, "HEAD"]);
    if (r.ok)
        return r.out.trim();
    if (git(root, ["rev-parse", "--is-shallow-repository"]).out.trim() === "true") {
        throw new RecordError("", "/base", `${base} and HEAD have no merge base in this shallow clone. Next action: run git fetch --unshallow, then run warden check --base ${base} again.`);
    }
    throw new RecordError("", "/base", `${base} and HEAD share no history. Next action: run warden check --base <the branch this work merges into>.`);
};
const HUNK = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/;
export function changesSinceMergeBase(root, base) {
    const at = mergeBase(root, base);
    const lines = new Map();
    let current;
    const patch = must(root, ["-c", "core.quotePath=false", "diff", "-U0", "-M", "--no-color", "--no-ext-diff", "--relative", "--src-prefix=a/", "--dst-prefix=b/", at]);
    for (const line of patch.split("\n")) {
        if (line.startsWith("+++ ")) {
            current = line.startsWith("+++ b/") ? new Set() : undefined;
            if (current !== undefined)
                lines.set(line.slice("+++ b/".length).replace(/\t$/, ""), current);
            continue;
        }
        const hunk = HUNK.exec(line);
        if (hunk === null || current === undefined)
            continue;
        const start = Number(hunk[1]);
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        for (let n = start; n < start + count; n++)
            current.add(n);
    }
    for (const file of names(must(root, ["ls-files", "-z", "--others", "--exclude-standard"])))
        lines.set(file, "all");
    const renames = new Map();
    const status = names(must(root, ["diff", "-z", "-M", "--name-status", "--relative", at]));
    for (let i = 0; i < status.length; i++) {
        const kind = status[i];
        if (kind.startsWith("R"))
            renames.set(status[i + 1], status[i + 2]);
        i += kind.startsWith("R") || kind.startsWith("C") ? 2 : 1;
    }
    return { lines, renames };
}
export function showAtMergeBase(root, base, path) {
    const spec = `${mergeBase(root, base)}:./${path}`;
    if (!git(root, ["cat-file", "-e", spec]).ok)
        return undefined;
    return must(root, ["show", spec]);
}
export function changeSignatures(root, base, dir, allowedSignersFile, staged, alongside) {
    const at = mergeBase(root, base);
    const icase = git(root, ["config", "--bool", "core.ignorecase"]).out.trim() === "true";
    const spec = `:(literal${icase ? ",icase" : ""})${dir}`;
    const diff = (...trees) => names(must(root, ["diff", "-z", "--name-only", "--no-renames", "--ignore-submodules=none", "--relative", ...trees, "--", spec]));
    const committed = diff(at, "HEAD");
    const judged = staged ? diff("--cached", at) : committed;
    const scope = [...new Set([...committed, ...judged])];
    const files = new Map();
    if (scope.length === 0)
        return { files, restore: { base: at, paths: [], known: [], stray: [], aliased: false } };
    const verify = ["-c", "gpg.ssh.program=ssh-keygen", "-c", "gpg.program=false", "-c", "gpg.x509.program=false", "-c", `gpg.ssh.allowedSignersFile=${allowedSignersFile}`, "--literal-pathspecs"];
    const mark = `\x01${randomUUID()}`;
    const log = must(root, [...verify, "log", "-z", "--topo-order", "--diff-merges=dense-combined", "--no-renames", "--ignore-submodules=none", "--relative", "--name-only", `--format=${mark}%G?`, `${at}..HEAD`, "--", ...scope]);
    const seen = new Set();
    const bad = new Map();
    for (const entry of log.split(mark).slice(1)) {
        const end = entry.search(/[\n\0]/);
        const status = entry[0];
        for (const path of names(entry.slice(end + 1).replace(/^\n/, ""))) {
            seen.add(path);
            if (status !== "G" && !bad.has(path))
                bad.set(path, status);
        }
    }
    for (const path of committed)
        if (!seen.has(path))
            bad.set(path, "N");
    for (const path of judged)
        if (bad.has(path))
            files.set(path, bad.get(path));
    const paths = [...new Set([...bad.keys(), ...scope.filter((p) => alongside.includes(p))])].sort();
    const listed = (args) => (paths.length === 0 ? [] : names(must(root, ["--literal-pathspecs", ...args, "--", ...paths])));
    const known = [...new Set([...listed(["ls-tree", "-r", "-z", "--name-only", "--full-tree", at]), ...listed(["ls-files", "-z", "--cached"])])].sort();
    const onDisk = (p) => {
        let path = dir;
        for (const part of p.slice(dir.length + 1).split("/")) {
            const entries = readdirSync(join(root, path));
            const name = entries.includes(part) ? part : icase ? entries.find((e) => e.toLowerCase() === part.toLowerCase()) : undefined;
            if (name === undefined)
                return undefined;
            path = `${path}/${name}`;
            const entry = lstatSync(join(root, path));
            if (entry.isSymbolicLink() || !entry.isDirectory())
                return path;
        }
        return path;
    };
    const stray = [...new Set(paths.filter((p) => !known.includes(p)).map(onDisk).filter((p) => p !== undefined))].sort();
    const aliased = new Set(paths.map((p) => p.toLowerCase())).size < paths.length;
    return { files, restore: { base: at, paths, known, stray, aliased } };
}
