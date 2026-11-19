import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { COMMIT_HOOK } from "../compiler/emit.js";
import { LOCK_PATH, readLock } from "../compiler/lock.js";
import { RecordError, loadRecords, parseConfig } from "../records/load.js";
import { commitHookItem } from "./doctor.js";
import { LOOP_TAIL_BYTES, appendEvidence, evidenceProjects, readEvidenceTail, wardenHome } from "./evidence.js";
import { formatFeedback } from "./feedback.js";
import { findTampering } from "./tamper.js";
export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 30_000;
export const START_DAEMON = "start the daemon: warden daemon install";
export const heartbeatFile = () => join(wardenHome(), "daemon", "heartbeat.json");
const registryFile = () => join(wardenHome(), "projects.json");
const writeAtomic = (file, text) => {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, text);
    renameSync(temp, file);
};
const readJsonFile = (file) => {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return undefined;
        throw new RecordError(file, "", `is not valid JSON (${cause.message}). Next action: delete ${file}; the daemon rewrites it`);
    }
};
export function readHeartbeat() {
    return readJsonFile(heartbeatFile());
}
export function heartbeatProblem(now = Date.now()) {
    if (process.env.WARDEN_DAEMON === "off")
        return undefined;
    const beat = readHeartbeat();
    if (beat === undefined)
        return `Warden's daemon is not running: ${heartbeatFile()} is missing. Next action: ${START_DAEMON}`;
    const age = now - Date.parse(beat.at);
    if (!(age <= STALE_MS))
        return `Warden's daemon heartbeat is ${Math.round(age / 1000)} s old; it is stale after ${STALE_MS / 1000} s. Next action: ${START_DAEMON}`;
    return undefined;
}
export function registeredRoots() {
    const value = readJsonFile(registryFile());
    return Array.isArray(value) ? value.filter((r) => typeof r === "string") : [];
}
export function registerProject(root) {
    const roots = registeredRoots();
    if (!roots.includes(root))
        writeAtomic(registryFile(), `${JSON.stringify([...roots, root], null, 2)}\n`);
}
export function discoverRoots() {
    const fromEvidence = evidenceProjects().flatMap((p) => readEvidenceTail(p, LOOP_TAIL_BYTES).flatMap((e) => (e.root === undefined ? [] : [e.root])));
    return [...new Set([...registeredRoots(), ...fromEvidence])].filter((r) => existsSync(join(r, ".warden/config.yaml")));
}
const PLUGIN = "warden@warden";
const pluginDetection = (root) => {
    const files = [join(homedir(), ".claude/settings.json"), join(root, ".claude/settings.json"), join(root, ".claude/settings.local.json")];
    let enabled;
    for (const file of files) {
        const value = readJsonFile(file)?.enabledPlugins?.[PLUGIN];
        if (value !== undefined)
            enabled = { file, on: value === true };
    }
    if (enabled?.on === true)
        return undefined;
    if (enabled === undefined)
        return { file: ".claude/settings.json", detail: "plugin-missing", next: `run claude plugin install ${PLUGIN}` };
    return { file: enabled.file, detail: "plugin-disabled", next: `set enabledPlugins "${PLUGIN}" to true in ${enabled.file}` };
};
const nextOf = (message) => {
    const at = message.indexOf("Next action: ");
    return at === -1 ? undefined : message.slice(at + "Next action: ".length).replace(/\.$/, "");
};
export async function scanProject(root, wardenRoot, project) {
    const at = (d) => ({ project, root, ...d });
    if (!existsSync(join(root, ".warden/config.yaml")))
        return [at({ file: ".warden/config.yaml", detail: "removed", next: `run git checkout -- .warden in ${root}` })];
    const found = [];
    const hook = commitHookItem(root);
    if (hook.fix !== undefined)
        found.push(at({ file: COMMIT_HOOK, detail: "hook-unwired", next: hook.fix }));
    const plugin = pluginDetection(root);
    if (plugin !== undefined)
        found.push(at(plugin));
    try {
        const set = await loadRecords(root, wardenRoot);
        const base = existsSync(join(root, LOCK_PATH)) ? readLock(root).config.base : set.config.base;
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
const watchedPaths = (root) => [
    { path: join(root, ".warden"), recursive: true },
    { path: gitPath(root, ["rev-parse", "--git-common-dir"]), recursive: false },
    { path: gitPath(root, ["rev-parse", "--git-path", "hooks"]), recursive: false },
    { path: join(root, ".claude"), recursive: false },
    { path: join(homedir(), ".claude"), recursive: false },
].filter((w) => existsSync(w.path));
export function startWatching(opts) {
    const projects = new Map();
    const startedAt = new Date().toISOString();
    const debounce = opts.debounceMs ?? 200;
    const report = (cause) => (opts.onError ?? ((e) => process.stderr.write(`${e.message}\n`)))(cause instanceof Error ? cause : new Error(String(cause)));
    const scan = (w) => {
        if (w.scanning !== undefined) {
            w.again = true;
            return w.scanning;
        }
        w.scanning = scanProject(w.root, opts.wardenRoot, w.project)
            .then((found) => {
            const now = new Map(found.map((d) => [`${d.file}\0${d.detail}`, d]));
            for (const [key, d] of now) {
                if (w.open.has(key))
                    continue;
                appendEvidence(w.project, { at: new Date().toISOString(), kind: "tampered", trigger: "daemon", root: w.root, file: d.file, detail: d.detail, next: d.next });
                opts.onDetection?.(d);
            }
            w.open = now;
        }, report)
            .finally(() => {
            w.scanning = undefined;
            if (w.again === true) {
                w.again = false;
                void scan(w);
            }
        });
        return w.scanning;
    };
    const schedule = (w) => {
        clearTimeout(w.timer);
        w.timer = setTimeout(() => {
            w.timer = undefined;
            void scan(w);
        }, debounce);
    };
    const discover = () => {
        for (const root of discoverRoots()) {
            if (projects.has(root))
                continue;
            const project = projectOf(root);
            const w = { root, project, open: new Map(), watchers: [] };
            projects.set(root, w);
            w.watchers = watchedPaths(root).map(({ path, recursive }) => watch(path, { recursive }, () => schedule(w)));
            void scan(w);
        }
    };
    const heartbeat = () => {
        const beat = { pid: process.pid, at: new Date().toISOString(), startedAt, port: opts.port };
        writeAtomic(heartbeatFile(), `${JSON.stringify(beat)}\n`);
        return beat;
    };
    const tick = () => {
        try {
            heartbeat();
            discover();
        }
        catch (cause) {
            report(cause);
        }
    };
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
        stop: () => {
            clearInterval(interval);
            for (const w of projects.values()) {
                clearTimeout(w.timer);
                for (const watcher of w.watchers)
                    watcher.close();
            }
            rmSync(heartbeatFile(), { force: true });
        },
    };
}
