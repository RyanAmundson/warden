import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { COMMIT_HOOK } from "../compiler/emit.js";
import { LOCK_PATH, readLock } from "../compiler/lock.js";
import { RecordError, loadRecords, parseConfig } from "../records/load.js";
import { localCommits, restoreAction } from "./changed.js";
import { claudeDir, commitHookItem, pluginAction, pluginState } from "./doctor.js";
import { LOOP_TAIL_BYTES, RUN_TOTAL, appendEvidence, evidenceProjects, readEvidenceTail, wardenHome } from "./evidence.js";
import { formatFeedback } from "./feedback.js";
import { findTampering } from "./tamper.js";
export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 30_000;
export const SKEW_MS = 5_000;
export const COMMITS_SCANNED = 50;
export const START_DAEMON = "start the daemon: warden daemon install";
export const heartbeatFile = () => join(wardenHome(), "daemon", "heartbeat.json");
const writeAtomic = (file, text) => {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, text);
    renameSync(temp, file);
};
const isHeartbeat = (value) => {
    const v = value;
    return typeof v === "object" && v !== null && typeof v.pid === "number" && typeof v.at === "string" && !Number.isNaN(Date.parse(v.at)) && typeof v.port === "number";
};
const parsed = (text) => {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
};
export function readHeartbeat() {
    let text;
    try {
        text = readFileSync(heartbeatFile(), "utf8");
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return undefined;
        throw cause;
    }
    const value = parsed(text);
    return isHeartbeat(value) ? value : null;
}
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (cause) {
        return cause.code === "EPERM";
    }
};
export function heartbeatProblem(now = Date.now()) {
    const beat = readHeartbeat();
    const file = heartbeatFile();
    if (beat === undefined)
        return `Warden's daemon is not running: ${file} is missing. Next action: ${START_DAEMON}`;
    if (beat === null)
        return `${file} does not hold a heartbeat. Next action: ${START_DAEMON}`;
    const age = now - Date.parse(beat.at);
    if (age < -SKEW_MS)
        return `Warden's daemon heartbeat is dated ${Math.round(-age / 1000)} s in the future, so the daemon did not write it. Next action: ${START_DAEMON}`;
    if (age > STALE_MS)
        return `Warden's daemon heartbeat is ${Math.round(age / 1000)} s old; it is stale after ${STALE_MS / 1000} s. Next action: ${START_DAEMON}`;
    if (!alive(beat.pid))
        return `Warden's daemon heartbeat names process ${beat.pid}, which is not running. Next action: ${START_DAEMON}`;
    return undefined;
}
export function discoverRoots() {
    const roots = evidenceProjects().flatMap((p) => readEvidenceTail(p, LOOP_TAIL_BYTES).flatMap((e) => (e.root === undefined ? [] : [e.root])));
    return [...new Set(roots)].filter((r) => existsSync(join(r, ".warden/config.yaml")));
}
const nextOf = (message) => {
    const at = message.indexOf("Next action: ");
    return at === -1 ? undefined : message.slice(at + "Next action: ".length).replace(/\.$/, "");
};
const now = () => new Date().toISOString();
const pluginDetections = (root, project, mine) => {
    const plugin = pluginState(root);
    const records = mine.filter((e) => e.kind === "plugin");
    if (records.at(-1)?.status !== plugin.state) {
        const e = { at: now(), kind: "plugin", trigger: "daemon", root, status: plugin.state, file: plugin.file };
        appendEvidence(project, e);
        records.push(e);
    }
    if (plugin.state === "enabled" || !records.some((e) => e.status === "enabled"))
        return [];
    return [{ file: plugin.file, detail: `plugin-${plugin.state}`, next: pluginAction(plugin) }];
};
const isRun = (e) => e.kind === "cost" && e.guardrail === RUN_TOTAL;
const gateOffDetections = (root, mine) => {
    const off = mine.filter((e) => e.kind === "gate-off");
    const offRuns = new Set(off.map((e) => e.run));
    const gated = mine.filter((e) => isRun(e) && e.tier === "commit" && e.outcome !== "refused" && !offRuns.has(e.run)).at(-1);
    return off
        .filter((e) => gated === undefined || e.at > gated.at)
        .map((e) => ({ file: `run ${e.run ?? ""}`, detail: "gate-off", next: `unset WARDEN_DAEMON, then run warden check --base ${e.base ?? "main"} in ${root} with the daemon running`, once: true }));
};
const commitDetections = (root, project, mine, base) => {
    const before = new Set(mine.find((e) => e.kind === "watching")?.members ?? []);
    const commits = localCommits(root, COMMITS_SCANNED);
    const all = readEvidenceTail(project, LOOP_TAIL_BYTES);
    const stamped = new Set(all.filter((e) => isRun(e) && e.tier === "commit" && e.exit === 0 && e.tree !== undefined).map((e) => e.tree));
    const seen = new Set(mine.filter((e) => e.kind === "commit").map((e) => e.commit));
    return commits
        .filter((c) => !before.has(c.commit))
        .flatMap((c) => {
        const checked = stamped.has(c.tree);
        if (!seen.has(c.commit)) {
            appendEvidence(project, { at: now(), kind: "commit", trigger: "daemon", root, commit: c.commit, tree: c.tree, status: checked ? "checked" : "unchecked" });
            seen.add(c.commit);
        }
        return checked ? [] : [{ file: c.commit, detail: "unchecked-commit", next: `run warden check --base ${base} in ${root} with commit ${c.commit.slice(0, 12)} checked out and nothing else staged`, once: true }];
    });
};
export async function scanProject(root, wardenRoot, project) {
    const all = readEvidenceTail(project, LOOP_TAIL_BYTES);
    const mine = all.filter((e) => e.root === root);
    const at = (d) => ({ project, root, ...d });
    if (!mine.some((e) => e.kind === "watching")) {
        const e = { at: now(), kind: "watching", trigger: "daemon", root, members: localCommits(root, COMMITS_SCANNED).map((c) => c.commit) };
        appendEvidence(project, e);
        mine.push(e);
    }
    if (!existsSync(join(root, ".warden/config.yaml")))
        return [at({ file: ".warden/config.yaml", detail: "removed", next: restoreAction(root, ".warden/config.yaml") })];
    const found = [];
    const hook = commitHookItem(root);
    if (hook.fix !== undefined)
        found.push(at({ file: COMMIT_HOOK, detail: "hook-unwired", next: hook.fix }));
    found.push(...gateOffDetections(root, mine).map(at));
    try {
        found.push(...pluginDetections(root, project, mine).map(at));
        const set = await loadRecords(root, wardenRoot);
        const base = existsSync(join(root, LOCK_PATH)) ? readLock(root).config.base : set.config.base;
        found.push(...commitDetections(root, project, mine, base).map(at));
        for (const t of await findTampering(set, wardenRoot, base)) {
            const next = JSON.parse(formatFeedback([], set, "json", { tampered: [t] })).next.replace(/\.$/, "");
            found.push(at({ file: t.file, detail: t.guardrail === undefined ? t.detail : `${t.detail} ${t.guardrail}`, next }));
        }
    }
    catch (cause) {
        if (!(cause instanceof RecordError))
            throw cause;
        found.push(at({ file: cause.file, detail: "record-error", next: nextOf(cause.message) ?? `run warden compile in ${root} and fix what it reports` }));
    }
    return found;
}
const projectOf = (root) => {
    try {
        return parseConfig(".warden/config.yaml", readFileSync(join(root, ".warden/config.yaml"), "utf8")).project;
    }
    catch (cause) {
        if (!(cause instanceof RecordError))
            throw cause;
        return basename(root);
    }
};
const gitPath = (root, args) => resolve(root, execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim());
const watchSpecs = (root) => [
    { path: join(root, ".warden"), recursive: true, changes: true },
    { path: root, recursive: false, names: [".warden", ".claude"] },
    { path: gitPath(root, ["rev-parse", "--git-common-dir"]), recursive: false, names: ["config"] },
    { path: gitPath(root, ["rev-parse", "--git-path", "logs"]), recursive: false, names: ["HEAD"] },
    { path: gitPath(root, ["rev-parse", "--git-path", "hooks"]), recursive: false },
    { path: join(root, ".claude"), recursive: false, names: ["settings.json", "settings.local.json"] },
    { path: claudeDir(), recursive: false, names: ["settings.json"] },
];
const key = (d) => `${d.root ?? ""}\0${d.file ?? ""}\0${d.detail ?? ""}`;
export function startWatching(opts) {
    const projects = new Map();
    const startedAt = now();
    const debounce = opts.debounceMs ?? 200;
    let stopped = false;
    const report = (cause) => (opts.onError ?? ((e) => process.stderr.write(`${e.message}\n`)))(cause instanceof Error ? cause : new Error(String(cause)));
    const schedule = (w) => {
        if (stopped)
            return;
        clearTimeout(w.timer);
        w.timer = setTimeout(() => {
            w.timer = undefined;
            void scan(w);
        }, debounce);
    };
    const ensureWatchers = (w) => {
        const had = w.watchers.size;
        for (const spec of watchSpecs(w.root)) {
            if (w.watchers.has(spec.path) || !existsSync(spec.path))
                continue;
            const watcher = watch(spec.path, { recursive: spec.recursive }, (_event, name) => {
                if (spec.names !== undefined && (name === null || !spec.names.includes(name)))
                    return;
                if (spec.changes === true && name !== null && !name.includes(".warden-tmp-"))
                    w.changes.add(`.warden/${name}`);
                schedule(w);
            });
            watcher.on("error", () => {
                watcher.close();
                w.watchers.delete(spec.path);
                schedule(w);
            });
            w.watchers.set(spec.path, watcher);
        }
        return w.watchers.size > had;
    };
    const scan = (w) => {
        if (w.scanning !== undefined) {
            w.again = true;
            return w.scanning;
        }
        w.scanning = (async () => {
            ensureWatchers(w);
            for (const file of w.changes)
                appendEvidence(w.project, { at: now(), kind: "change", trigger: "daemon", root: w.root, file });
            w.changes.clear();
            const found = await scanProject(w.root, opts.wardenRoot, w.project);
            if (stopped)
                return;
            const recorded = new Set(readEvidenceTail(w.project, LOOP_TAIL_BYTES).filter((e) => e.kind === "tampered" && e.trigger === "daemon").map(key));
            const current = new Map(found.map((d) => [key(d), d]));
            for (const [k, d] of current) {
                if (w.open.has(k) || (d.once === true && recorded.has(k)))
                    continue;
                appendEvidence(w.project, { at: now(), kind: "tampered", trigger: "daemon", root: w.root, file: d.file, detail: d.detail, next: d.next });
                opts.onDetection?.(d);
            }
            w.open = current;
        })()
            .catch(report)
            .finally(() => {
            w.scanning = undefined;
            if (w.again === true && !stopped) {
                w.again = false;
                void scan(w);
            }
        });
        return w.scanning;
    };
    const discover = () => {
        for (const root of discoverRoots()) {
            if (projects.has(root))
                continue;
            const w = { root, project: projectOf(root), open: new Map(), watchers: new Map(), changes: new Set() };
            projects.set(root, w);
            void scan(w);
        }
    };
    const heartbeat = () => {
        const beat = { pid: process.pid, at: now(), startedAt, port: opts.port };
        writeAtomic(heartbeatFile(), `${JSON.stringify(beat)}\n`);
        return beat;
    };
    const tick = () => {
        try {
            heartbeat();
            for (const w of projects.values())
                if (existsSync(w.root) && ensureWatchers(w))
                    schedule(w);
            discover();
        }
        catch (cause) {
            report(cause);
        }
    };
    const evidenceDir = join(wardenHome(), "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    const evidenceWatcher = watch(evidenceDir, (_event, file) => {
        if (file === null || !file.endsWith(".jsonl") || file.endsWith(".1.jsonl"))
            return;
        const project = file.slice(0, -".jsonl".length);
        opts.onEvidence?.(project);
        for (const w of projects.values())
            if (w.project === project)
                schedule(w);
    });
    tick();
    const interval = setInterval(tick, opts.intervalMs ?? HEARTBEAT_MS);
    return {
        projects,
        startedAt,
        heartbeat,
        discover,
        settled: async () => {
            while ([...projects.values()].some((w) => w.scanning !== undefined || w.timer !== undefined))
                await new Promise((r) => setTimeout(r, 20));
        },
        stop: async () => {
            stopped = true;
            clearInterval(interval);
            evidenceWatcher.close();
            for (const w of projects.values()) {
                clearTimeout(w.timer);
                w.timer = undefined;
                for (const watcher of w.watchers.values())
                    watcher.close();
            }
            await Promise.all([...projects.values()].map((w) => w.scanning));
            const beat = readHeartbeat();
            if (beat?.pid === process.pid && beat.port === opts.port)
                rmSync(heartbeatFile(), { force: true });
        },
    };
}
