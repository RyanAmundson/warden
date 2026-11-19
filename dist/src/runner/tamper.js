import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { expectedOutputs } from "../compiler/compile.js";
import { LOCK_FORMAT, LOCK_PATH, canonicalJson, readLock, sha256 } from "../compiler/lock.js";
import { RecordError, readText } from "../records/load.js";
import { kindRank } from "../records/types.js";
import { BASELINE_PATH, carryRenames, projectWideEntries, readBaseline } from "./baseline.js";
import { changeSignatures, changesSinceMergeBase, containsHead, historyOf, lastCommittedText, showAtMergeBase } from "./changed.js";
const SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"];
export const SIGNERS_FILE = "allowed_signers";
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const tempsIn = (root, dir, recursive) => {
    if (!existsSync(join(root, dir)))
        return [];
    return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
        const path = dir === "." ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory())
            return recursive ? tempsIn(root, path, true) : [];
        return entry.name.includes(".warden-tmp-") ? [path] : [];
    });
};
const leftoverTemps = (root, lock) => {
    const parents = Object.keys(lock?.generated ?? {}).map((key) => dirname(key));
    const shallow = [...new Set(parents)].flatMap((dir) => tempsIn(root, dir, false));
    return [...new Set([...tempsIn(root, ".warden", true), ...shallow])].sort();
};
const readJson = async (root, file) => {
    const text = await readText(join(root, file));
    if (text === undefined)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch (cause) {
        throw new RecordError(file, "", `not valid JSON: ${cause.message}. Next action: fix the JSON in ${file}, then run warden check again`);
    }
};
const parsedOrSkipped = (text) => {
    try {
        return [JSON.parse(text)];
    }
    catch {
        return [];
    }
};
export function recordedBases(root) {
    return historyOf(root, LOCK_PATH).flatMap((text) => parsedOrSkipped(text).flatMap((lock) => {
        const value = lock?.config?.base;
        return typeof value === "string" ? [value] : [];
    }));
}
export function readBaseLock(root, base) {
    const text = showAtMergeBase(root, base, LOCK_PATH);
    if (text === undefined)
        return undefined;
    let before;
    try {
        before = JSON.parse(text);
    }
    catch (cause) {
        throw new RecordError(LOCK_PATH, "", `at the merge base with ${base} is not valid JSON (${cause.message}). Next action: run warden compile on ${base} and commit the lock there, merge ${base} into this branch, then run warden check --base ${base} again.`);
    }
    if ((before.format ?? 0) > LOCK_FORMAT) {
        throw new RecordError(LOCK_PATH, "/format", `the lock at the merge base with ${base} has format ${before.format}; this Warden reads formats up to ${LOCK_FORMAT}. Next action: install Warden ${before.warden}, the release that wrote the lock on ${base}, then run warden check --base ${base} again.`);
    }
    return before;
}
const benchLoosened = (was, now) => was !== undefined &&
    (now === undefined || now.linearMax > was.linearMax || now.constantMs > was.constantMs || now.minMarginalMs > was.minMarginalMs || now.maxFiles < was.maxFiles);
const loosened = (root, base, lock) => {
    const before = readBaseLock(root, base);
    if (before === undefined)
        return [];
    const changed = (was, now) => was !== undefined && was !== now;
    const found = [];
    const tiers = Object.keys(lock.config.tierBudgetMs);
    const committed = lastCommittedText(root, LOCK_PATH);
    const heads = [lock, ...(committed === undefined ? [] : parsedOrSkipped(committed))];
    const restoring = base === recordedBases(root).at(-1) && containsHead(root, base);
    if (heads.some((l) => changed(before.config.base, l.config?.base) && !(restoring && l.config?.base === base)))
        found.push({ file: LOCK_PATH, detail: "base-moved" });
    if (changed(before.config.project, lock.config.project) ||
        lock.config.loopBreakerRepeats > before.config.loopBreakerRepeats ||
        benchLoosened(before.config.bench, lock.config.bench) ||
        tiers.some((t) => lock.config.tierBudgetMs[t] > before.config.tierBudgetMs[t])) {
        found.push({ file: LOCK_PATH, detail: "loosened" });
    }
    const covers = (now, was) => was.every((x) => now.includes(x));
    const widens = (now, was) => {
        const [a, b] = [now.split(/(\{[^{}]*\})/), was.split(/(\{[^{}]*\})/)];
        if (a.length !== b.length)
            return false;
        return a.every((part, i) => {
            const old = b[i];
            if (part === old)
                return true;
            if (i % 2 === 0)
                return false;
            const members = new Set(part.slice(1, -1).split(","));
            return old.slice(1, -1).split(",").every((m) => members.has(m));
        });
    };
    const pathsCover = (now, was) => was.every((x) => now.some((y) => widens(y, x)));
    for (const [id, g] of Object.entries(before.guardrails)) {
        const now = lock.guardrails[id];
        const known = now !== undefined && g.kind !== undefined;
        const stronger = known && g.kind === "instruction" && kindRank(now.kind) < kindRank(g.kind);
        const cmdLintToRuntime = known && g.kind === "lint" && now.kind === "runtime" && g.implementation.startsWith("cmd:");
        if (known && !cmdLintToRuntime && kindRank(now.kind) > kindRank(g.kind))
            found.push({ file: LOCK_PATH, detail: "weakened-kind", guardrail: id, was: g.kind });
        const weaker = now === undefined ||
            now.budgetMs > g.budgetMs ||
            !covers(now.runs, g.runs) ||
            !pathsCover(now.paths, g.paths) ||
            (!stronger && (now.implementation !== g.implementation || canonicalJson(now.options) !== canonicalJson(g.options)));
        if (weaker)
            found.push({ file: LOCK_PATH, detail: "loosened", guardrail: id });
    }
    const { renames } = changesSinceMergeBase(root, base);
    const baseBaseline = carryRenames(JSON.parse(showAtMergeBase(root, base, BASELINE_PATH) ?? "{}"), renames);
    for (const [id, entries] of Object.entries(carryRenames(readBaseline(root), renames))) {
        if (id in lock.guardrails && !(id in before.guardrails))
            continue;
        for (const [file, n] of Object.entries(entries)) {
            if (!existsSync(join(root, file)))
                continue;
            if (n > (baseBaseline[id]?.[file] ?? 0))
                found.push({ file: BASELINE_PATH, detail: "loosened", guardrail: id });
        }
    }
    const sources = Object.keys({ ...before.sources, ...lock.sources }).filter((k) => k.startsWith(".warden/") && before.sources?.[k] !== lock.sources[k]);
    return sources.length === 0 ? found : found.map((t) => (t.file === LOCK_PATH && t.detail === "loosened" ? { ...t, sources } : t));
};
const unsignedChanges = (root, base, wardenRoot) => {
    const signers = join(wardenRoot, SIGNERS_FILE);
    const listed = existsSync(signers) && readFileSync(signers, "utf8").trim() !== "";
    const { files, commits, dirty } = changeSignatures(root, base, ".warden", signers);
    const failed = [...files].filter(([file]) => file !== BASELINE_PATH);
    if (!listed)
        return failed.map(([file]) => ({ file, detail: "no-allowed-signers" }));
    if (failed.some(([, status]) => status !== "N") && spawnSync("ssh-keygen", ["-?"]).error !== undefined) {
        throw new RecordError("", "", "ssh-keygen is not on PATH, so signatures on .warden changes cannot be checked. Next action: install OpenSSH so ssh-keygen is on PATH, then run warden check again.");
    }
    return failed.map(([file, status]) => ({ file, detail: status === "N" ? "unsigned" : "untrusted-signature", commits, dirty }));
};
export async function findTampering(set, wardenRoot, base) {
    const root = set.root;
    const lock = existsSync(join(root, LOCK_PATH)) ? readLock(root) : undefined;
    const found = leftoverTemps(root, lock).map((file) => ({ file, detail: "leftover-temp" }));
    for (const file of SETTINGS_FILES) {
        const value = await readJson(root, file);
        if (isObject(value) && value.disableAllHooks === true)
            found.push({ file, detail: "hooks-disabled" });
    }
    if (lock === undefined)
        return [...found, { file: LOCK_PATH, detail: "missing-lock" }];
    const expected = await expectedOutputs(set, root, wardenRoot);
    const sources = [...new Set([...Object.keys(lock.sources), ...Object.keys(expected.lock.sources)])].sort();
    const sourceDrift = sources.filter((file) => lock.sources[file] !== expected.lock.sources[file]);
    found.push(...sourceDrift.map((file) => ({ file, detail: "source-drift" })));
    if (sourceDrift.length === 0 && canonicalJson({ ...lock, tools: null }) !== canonicalJson({ ...expected.lock, tools: null })) {
        found.push({ file: LOCK_PATH, detail: "lock-drift" });
    }
    for (const [file, hash] of Object.entries(lock.generated)) {
        const actual = await readText(join(root, file));
        if (actual === undefined || sha256(actual) !== hash)
            found.push({ file, detail: "generated-drift" });
    }
    found.push(...projectWideEntries(readBaseline(root)).map((guardrail) => ({ file: BASELINE_PATH, detail: "loosened", guardrail })));
    return [...found, ...loosened(root, base, lock), ...unsignedChanges(root, base, wardenRoot)];
}
