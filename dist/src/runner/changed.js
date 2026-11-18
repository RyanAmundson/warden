import { execFileSync } from "node:child_process";
import { RecordError } from "../records/load.js";
const git = (root, args) => {
    try {
        return { ok: true, out: execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), err: "" };
    }
    catch (cause) {
        const e = cause;
        if (typeof e.status !== "number")
            throw cause;
        return { ok: false, out: e.stdout ?? "", err: e.stderr ?? "" };
    }
};
const names = (text) => text.split("\0").filter((l) => l !== "");
const must = (root, args) => {
    const r = git(root, args);
    if (!r.ok)
        throw new Error(`git ${args.join(" ")} failed: ${r.err.trim()}`);
    return r.out;
};
export const isRepository = (root) => git(root, ["rev-parse", "--is-inside-work-tree"]).ok;
export const CHECK_BASE_ACTION = "run warden check --base <an existing branch>";
export function verifyBase(root, base, action) {
    if (!isRepository(root)) {
        throw new RecordError(root, "", "not a git repository");
    }
    if (!git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).ok) {
        throw new RecordError("", "/base", `base ref "${base}" does not exist. Next action: ${action}`);
    }
}
export function changedFiles(root, base) {
    verifyBase(root, base, CHECK_BASE_ACTION);
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
export const containsHead = (root, ref) => git(root, ["merge-base", "--is-ancestor", "HEAD", ref]).ok;
export function historyOf(root, path) {
    const commits = names(must(root, ["log", "-z", "--format=%H", "HEAD", "--", path]));
    if (commits.length === 0)
        return [];
    const out = execFileSync("git", ["cat-file", "--batch"], { cwd: root, input: commits.map((sha) => `${sha}:./${path}\n`).join(""), maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "pipe"] });
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
const mergeBase = (root, base) => {
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
