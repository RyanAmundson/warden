import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, watch } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setImmediate as yieldToEvents } from "node:timers/promises";
import { COMMIT_HOOK, RELEASES } from "../compiler/emit.js";
import { FIRST_STAMPING, LOCK_PATH, firstLine, olderThan, readLock } from "../compiler/lock.js";
import { RecordError, loadRecords, parseConfig } from "../records/load.js";
import { COMMIT_LOOKUP_BATCH, allTips, commitsOf, commonDir, covers, holdersOf, lockVersionAt, newCommits, reachableFrom, reachable, repoTips, restoreAction, worktrees } from "./changed.js";
import { claudeDir, commitHookItem, pluginAction, pluginState } from "./doctor.js";
import { LOOP_TAIL_BYTES, RUN_TOTAL, appendEvidence, evidenceProjects, readEvidenceFrom, readEvidenceTail, wardenHome, writeAtomic } from "./evidence.js";
import { formatFeedback } from "./feedback.js";
import { findTampering } from "./tamper.js";
import { TRUST_SIGNERS, readTrustFiles, signatureValid, trustDir } from "./trust.js";
export const DEFAULT_PORT = 7419;
export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 30_000;
export const SKEW_MS = 5_000;
export const START_DAEMON = "start the daemon: warden daemon install";
export const heartbeatFile = () => join(wardenHome(), "daemon", "heartbeat.json");
export const stateFile = () => join(wardenHome(), "daemon", "state.json");
const readOptional = (file) => {
    try {
        return readFileSync(file, "utf8");
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return undefined;
        throw cause;
    }
};
const parsed = (text) => {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
};
const isHeartbeat = (value) => {
    const v = value;
    return typeof v === "object" && v !== null && typeof v.pid === "number" && typeof v.at === "string" && !Number.isNaN(Date.parse(v.at)) && typeof v.port === "number";
};
export function readHeartbeat() {
    const text = readOptional(heartbeatFile());
    if (text === undefined)
        return undefined;
    const value = parsed(text);
    return isHeartbeat(value) ? value : null;
}
const alive = (pid) => {
    if (pid <= 1)
        return false;
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
        return `Warden's daemon heartbeat names process ${beat.pid}, which is not a running daemon. Next action: ${START_DAEMON}`;
    return undefined;
}
export function readState() {
    const text = readOptional(stateFile());
    if (text === undefined)
        return { roots: {}, repos: {} };
    const value = parsed(text);
    if (typeof value !== "object" || value === null)
        throw new RecordError(stateFile(), "", `is not valid JSON. Next action: delete ${stateFile()} and restart the daemon; it rebuilds the file from git and Evidence`);
    return { roots: value.roots ?? {}, repos: value.repos ?? {} };
}
const REPO_WIDE = new Set(["hook-unwired", "unchecked-commit", "untrusted-trust"]);
export const UNWIRED = new Set(["hook-unwired", "hooks-disabled", "plugin-missing", "plugin-disabled", "gate-off", "removed"]);
const repoWide = (d) => REPO_WIDE.has(d.detail) || (d.detail === "scan-error" && d.file === HISTORY);
export function openAlerts(root, audit = false) {
    const repo = commonDir(root);
    const indexes = new Map();
    const indexOf = (project) => indexes.get(project) ?? indexes.set(project, refresh(emptyIndex(), project)).get(project);
    const alerts = Object.values(readState().roots)
        .flatMap((r) => r.open)
        .filter((d) => d.repo === repo && (d.root === root || repoWide(d)));
    if (audit)
        return alerts.filter((d) => !REPO_WIDE.has(d.detail));
    const unchecked = [...new Set(alerts.filter((d) => d.detail === "unchecked-commit").map((d) => d.file))];
    const commits = new Map();
    for (let offset = 0; offset < unchecked.length; offset += COMMIT_LOOKUP_BATCH) {
        for (const commit of commitsOf(root, unchecked.slice(offset, offset + COMMIT_LOOKUP_BATCH)))
            commits.set(commit.commit, commit);
    }
    return alerts.filter((d) => {
        const commit = d.detail === "unchecked-commit" ? commits.get(d.file) : undefined;
        return commit === undefined || !stamped(root, indexOf(d.project), commit);
    });
}
export function discoverRoots() {
    const roots = evidenceProjects().flatMap((p) => readEvidenceTail(p, LOOP_TAIL_BYTES).flatMap((e) => (e.root === undefined ? [] : [e.root])));
    return [...new Set(roots)].filter((r) => existsSync(join(r, ".warden/config.yaml")));
}
const nextOf = (message) => {
    const at = message.indexOf("Next action: ");
    return at === -1 ? undefined : message.slice(at + "Next action: ".length).replace(/\.$/, "");
};
export const SELF_CHECK_MARKER = ".warden-self-check";
const HISTORY = "git history";
const now = () => new Date().toISOString();
const isRun = (e) => e.kind === "cost" && e.guardrail === RUN_TOTAL;
const emptyIndex = () => ({ offset: 0, stamps: [], gateOff: [], offRuns: new Set(), lastGated: new Map(), unchecked: new Set(), enabledRoots: new Set() });
const refresh = (index, project) => {
    const { events, offset } = readEvidenceFrom(project, index.offset);
    const ix = offset < index.offset ? emptyIndex() : index;
    ix.offset = offset;
    for (const e of events) {
        if (e.kind === "gate-off") {
            ix.gateOff.push(e);
            ix.offRuns.add(e.run);
        }
        if (e.kind === "commit" && e.commit !== undefined) {
            if (e.status === "unchecked")
                ix.unchecked.add(e.commit);
            else
                ix.unchecked.delete(e.commit);
        }
        if (e.kind === "plugin" && e.status === "enabled" && e.root !== undefined)
            ix.enabledRoots.add(e.root);
        if (!isRun(e) || e.tier !== "commit")
            continue;
        if (e.tree !== undefined && e.scope === "full" && (e.result === "pass" || e.outcome === "empty" || (e.mode === "audit" && e.outcome === "ran")))
            ix.stamps.push(e);
        if (e.root !== undefined && e.outcome !== "refused" && !ix.offRuns.has(e.run))
            ix.lastGated.set(e.root, e.at);
    }
    return ix;
};
const stamped = (root, index, c) => c.expectedTree === c.tree || index.stamps.some((s) => covers(root, s, c));
const stampingVersion = (root, c, running) => {
    const version = lockVersionAt(root, c.commit);
    return version === undefined || !/^\d+\.\d+\.\d+$/.test(version) || olderThan(version, FIRST_STAMPING) || olderThan(running, version) ? undefined : version;
};
export const trustAction = (root, commit) => `ask the repository owner to run warden trust ${commit} --key <their trust key> --reason "<why>" in ${root}, in a terminal, and enter the key's passphrase; an agent cannot do this step`;
const unstampable = async (root, c, running, trees) => {
    const why = `its ${LOCK_PATH} is missing, unreadable, older than Warden ${FIRST_STAMPING}, or newer than this daemon's Warden ${running}, so no release can stamp it`;
    const holders = await holdersOf(root, c.commit, trees);
    const published = holders.filter((h) => h.startsWith("refs/remotes/"));
    if (published.length > 0)
        return `${trustAction(root, c.commit)}, because it is published in ${published.join(", ")} and ${why}`;
    return `remove commit ${c.commit.slice(0, 12)} from ${holders.join(", ")} by resetting or deleting each, because ${why}; then make its change again in a new commit with the hook`;
};
const uncheckedAlert = async (root, c, base, running, trees) => {
    const short = c.commit.slice(0, 12);
    const version = stampingVersion(root, c, running);
    if (version === undefined)
        return { file: c.commit, detail: "unchecked-commit", next: await unstampable(root, c, running, trees) };
    const warden = version === running ? "warden" : `npx --yes --package=${RELEASES}#v${version} warden`;
    const verify = c.parents[0] === undefined
        ? `run git switch -c warden-check-${short} ${base}, then git read-tree -u --reset ${short}, then ${warden} check --base ${base}`
        : `in a checkout of commit ${short} with nothing staged, run ${warden} check --base ${short}^`;
    const recover = `If the check finds a Guardrail violation, ask the repository owner to save the intended changes separately and remove ${short} from every ref and worktree that reaches it. After the daemon clears the alert, restore the intended changes, fix the findings, and commit through the hook`;
    return { file: c.commit, detail: "unchecked-commit", next: `${verify}. ${recover}` };
};
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
const gitPath = (root, args) => resolve(root, execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
const REPO_FILE = /^(config|packed-refs|HEAD|refs\/heads\/.+|worktrees\/[^/]+\/HEAD)$/;
const named = (...names) => (name) => names.includes(name);
const watchSpecs = (root, repo) => [
    { path: join(root, ".warden"), recursive: true, changes: true },
    { path: root, recursive: false, accept: named(".warden", ".claude") },
    { path: repo, recursive: true, accept: (name) => REPO_FILE.test(name) },
    { path: gitPath(root, ["rev-parse", "--git-path", "hooks"]), recursive: false },
    { path: join(root, ".claude"), recursive: false, accept: named("settings.json", "settings.local.json") },
    { path: claudeDir(), recursive: false, accept: named("settings.json") },
    { path: dirname(trustDir()), recursive: true, accept: (name) => name.startsWith(`${basename(trustDir())}/`) },
];
const key = (d) => `${d.root ?? ""}\0${d.file ?? ""}\0${d.detail ?? ""}`;
export function startWatching(opts) {
    const projects = new Map();
    const indexes = new Map();
    const state = readState();
    const startedAt = now();
    const debounce = opts.debounceMs ?? 200;
    let stopped = false;
    let scanQueue = Promise.resolve();
    const discoveries = new Map();
    const report = (cause) => (opts.onError ?? ((e) => process.stderr.write(`${e.message}\n`)))(cause instanceof Error ? cause : new Error(String(cause)));
    const saveState = () => writeAtomic(stateFile(), `${JSON.stringify(state)}\n`);
    const indexFor = (project) => {
        const ix = refresh(indexes.get(project) ?? emptyIndex(), project);
        indexes.set(project, ix);
        return ix;
    };
    const running = JSON.parse(readFileSync(join(opts.wardenRoot, "package.json"), "utf8")).version;
    const owner = (w) => [...projects.values()].find((x) => x.repo === w.repo) === w;
    const trustSigners = join(opts.wardenRoot, TRUST_SIGNERS);
    const verified = new Set();
    const evidenceMergedSinceStart = new Set();
    const trustFound = (w, known) => {
        const signers = existsSync(trustSigners) ? readFileSync(trustSigners, "utf8") : "";
        const trusted = new Set();
        const found = [];
        for (const t of readTrustFiles()) {
            if (t.record !== undefined && t.record.repo !== w.repo)
                continue;
            const cacheKey = `${signers}\0${t.text}`;
            if (t.record !== undefined && !verified.has(cacheKey) && signatureValid(trustSigners, t.record))
                verified.add(cacheKey);
            if (t.record !== undefined && verified.has(cacheKey))
                trusted.add(t.record.commit);
            else
                found.push({ file: t.file, detail: "untrusted-trust", next: `delete ${t.file}, because it is not signed for ${w.repo} by a key in ${trustSigners}. To trust a commit, ${trustAction(w.root, t.record?.commit ?? "<commit>")}` });
        }
        if ((known?.trusted ?? []).length > 0)
            found.push({ file: `${stateFile()} trusted`, detail: "untrusted-trust", next: `stop the daemon with warden daemon uninstall, delete the trusted list of ${w.repo} in ${stateFile()}, and start it again with warden daemon install --port ${opts.port}; the daemon does not honor that list. To trust a commit, ${trustAction(w.root, "<commit>")}` });
        return { trusted, found };
    };
    const pluginFound = (w, own, ix) => {
        let plugin;
        try {
            plugin = pluginState(w.root);
        }
        catch (cause) {
            if (!(cause instanceof RecordError))
                throw cause;
            report(cause);
            return [...w.open.values()].filter((d) => d.detail.startsWith("plugin-"));
        }
        if (own.plugin !== plugin.state) {
            appendEvidence(w.project, { at: now(), kind: "plugin", trigger: "daemon", root: w.root, status: plugin.state, file: plugin.file });
            own.plugin = plugin.state;
        }
        if (plugin.state === "enabled")
            own.pluginEnabled = true;
        if (plugin.state === "enabled" || (own.pluginEnabled !== true && !ix.enabledRoots.has(w.root)))
            return [];
        return [{ file: plugin.file, detail: `plugin-${plugin.state}`, next: pluginAction(plugin) }];
    };
    const gateOffFound = (w, ix) => {
        const gated = ix.lastGated.get(w.root);
        return ix.gateOff
            .filter((e) => e.root === w.root && (gated === undefined || e.at > gated))
            .map((e) => ({ file: `run ${e.run ?? ""}`, detail: "gate-off", next: `unset WARDEN_DAEMON, then run warden check --base ${e.base ?? "main"} in ${w.root} with the daemon running` }));
    };
    const commitFound = async (w, base) => {
        const trees = await worktrees(w.root);
        const tips = await repoTips(w.root, trees);
        const ix = indexFor(w.project);
        const known = state.repos[w.repo];
        const firstScan = !evidenceMergedSinceStart.has(w.repo);
        const rebuilt = firstScan ? commitsOf(w.root, [...new Set([...ix.unchecked, ...(known?.unchecked ?? []).map((c) => c.commit)])]) : [];
        const refs = await allTips(w.root, tips);
        const boundary = known?.boundary ?? refs;
        const owned = trustFound(w, known);
        const trusted = (c) => owned.trusted.has(c.commit);
        const flagged = new Set([...(known?.flagged ?? []), ...(known?.unchecked ?? []).map((c) => c.commit)]);
        const fresh = [];
        for (const c of await newCommits(w.root, tips, known?.tips ?? tips)) {
            const status = trusted(c) ? "trusted" : !ix.unchecked.has(c.commit) && !flagged.has(c.commit) && await reachableFrom(w.root, c.commit, boundary) ? "in-boundary" : stamped(w.root, ix, c) ? "checked" : "unchecked";
            appendEvidence(w.project, { at: now(), kind: "commit", trigger: "daemon", root: w.root, commit: c.commit, tree: c.tree, status });
            if (status === "unchecked")
                fresh.push(c);
        }
        const pending = [...rebuilt, ...(firstScan ? [] : (known?.unchecked ?? [])), ...fresh];
        const unchecked = [];
        const checked = new Set();
        for (const c of pending) {
            if (checked.has(c.commit))
                continue;
            checked.add(c.commit);
            if (!trusted(c) && !stamped(w.root, ix, c) && await reachable(w.root, c.commit, refs))
                unchecked.push(c);
        }
        for (const c of unchecked)
            flagged.add(c.commit);
        state.repos[w.repo] = { tips, unchecked, boundary, flagged: [...flagged], ...(known?.trusted === undefined ? {} : { trusted: known.trusted }) };
        evidenceMergedSinceStart.add(w.repo);
        const alerts = [...owned.found];
        for (const c of unchecked)
            alerts.push(await uncheckedAlert(w.root, c, base, running, trees));
        return alerts;
    };
    const scanRoot = async (w) => {
        const own = (state.roots[w.root] ??= { open: [] });
        const at = (d) => ({ project: w.project, root: w.root, repo: w.repo, ...d });
        if (!existsSync(join(w.root, ".warden/config.yaml")))
            return [at({ file: ".warden/config.yaml", detail: "removed", next: restoreAction(w.root, ".warden/config.yaml") })];
        const ix = indexFor(w.project);
        const found = [];
        const scanError = (source, cause) => {
            report(cause);
            found.push(at({ file: source, detail: "scan-error", next: `fix what this error names in ${w.root}, and the daemon scans again: ${firstLine(cause.message)}` }));
        };
        const guarded = (source, run) => {
            try {
                found.push(...run().map(at));
            }
            catch (cause) {
                scanError(source, cause);
            }
        };
        guarded("git hooks", () => {
            const hook = commitHookItem(w.root);
            return hook.fix === undefined ? [] : [{ file: COMMIT_HOOK, detail: "hook-unwired", next: hook.fix }];
        });
        guarded("gate-off Evidence", () => gateOffFound(w, ix));
        guarded("Claude settings", () => pluginFound(w, own, ix));
        if (w.filesChanged || w.base === undefined) {
            w.filesChanged = false;
            w.recordFound = [];
            try {
                const set = await loadRecords(w.root, opts.wardenRoot);
                w.base = existsSync(join(w.root, LOCK_PATH)) ? readLock(w.root).config.base : set.config.base;
                for (const t of await findTampering(set, opts.wardenRoot, w.base, false, true)) {
                    const next = JSON.parse(formatFeedback([], set, "json", { tampered: [t] })).next.replace(/\.$/, "");
                    w.recordFound.push(at({ file: t.file, detail: t.guardrail === undefined ? t.detail : `${t.detail} ${t.guardrail}`, next }));
                }
            }
            catch (cause) {
                report(cause);
                w.recordFound.push(cause instanceof RecordError
                    ? at({ file: cause.file, detail: "record-error", next: nextOf(cause.message) ?? `run warden compile in ${w.root} and fix what it reports` })
                    : at({ file: ".warden", detail: "scan-error", next: `fix what this error names in ${w.root}, and the daemon scans again: ${firstLine(cause.message)}` }));
            }
        }
        if (owner(w)) {
            try {
                found.push(...(await commitFound(w, w.base ?? "main")).map(at));
            }
            catch (cause) {
                scanError(HISTORY, cause);
            }
        }
        return [...found, ...w.recordFound];
    };
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
        for (const spec of w.specs) {
            if (w.watchers.has(spec.path) || !existsSync(spec.path))
                continue;
            const watcher = watch(spec.path, { recursive: spec.recursive }, (_event, name) => {
                if (spec.accept !== undefined && (name === null || !spec.accept(name)))
                    return;
                if (spec.changes === true && name !== null && !name.includes(".warden-tmp-"))
                    w.changes.add(`.warden/${name}`);
                w.filesChanged = true;
                schedule(w);
            });
            watcher.on("error", () => {
                watcher.close();
                w.watchers.delete(spec.path);
                w.filesChanged = true;
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
        w.scanning = scanQueue.then(async () => {
            if (stopped)
                return;
            await yieldToEvents();
            if (stopped)
                return;
            if (!existsSync(w.root)) {
                drop(w);
                return;
            }
            ensureWatchers(w);
            for (const file of w.changes)
                appendEvidence(w.project, { at: now(), kind: "change", trigger: "daemon", root: w.root, file });
            w.changes.clear();
            const found = await scanRoot(w);
            if (stopped)
                return;
            const current = new Map(found.map((d) => [key(d), d]));
            for (const [k, d] of current) {
                if (w.open.has(k))
                    continue;
                appendEvidence(w.project, { at: now(), kind: "tampered", trigger: "daemon", root: w.root, repo: w.repo, file: d.file, detail: d.detail, next: d.next });
                opts.onDetection?.(d);
            }
            w.open = current;
            (state.roots[w.root] ??= { open: [] }).open = [...current.values()];
            saveState();
        })
            .catch(report)
            .finally(() => {
            w.scanning = undefined;
            if (w.again === true && !stopped) {
                w.again = false;
                void scan(w);
            }
        });
        scanQueue = w.scanning;
        return w.scanning;
    };
    const drop = (w) => {
        clearTimeout(w.timer);
        w.timer = undefined;
        for (const watcher of w.watchers.values())
            watcher.close();
        projects.delete(w.root);
        delete state.roots[w.root];
        saveState();
        const next = [...projects.values()].find((x) => x.repo === w.repo);
        if (next !== undefined)
            schedule(next);
    };
    const watchRoot = (root) => {
        if (projects.has(root))
            return;
        const saved = state.roots[root]?.open ?? [];
        const repo = commonDir(root);
        const w = { root, project: projectOf(root), repo, specs: watchSpecs(root, repo), open: new Map(saved.map((d) => [key(d), d])), watchers: new Map(), changes: new Set(), filesChanged: true, recordFound: [] };
        projects.set(root, w);
        void scan(w);
    };
    const worktreeRoots = async (repo) => {
        try {
            return (await worktrees(repo))
                .map((t) => t.path)
                .filter((p) => existsSync(join(p, ".warden/config.yaml")) && !existsSync(join(p, SELF_CHECK_MARKER)));
        }
        catch (cause) {
            report(cause);
            return [];
        }
    };
    const watchRoots = (roots) => {
        for (const root of roots) {
            if (stopped)
                return;
            try {
                watchRoot(root);
            }
            catch (cause) {
                report(cause);
            }
        }
    };
    const discover = () => {
        if (stopped)
            return Promise.resolve();
        const remembered = Object.keys(state.roots).filter((r) => existsSync(join(r, ".warden/config.yaml")));
        watchRoots([...discoverRoots(), ...remembered]);
        const repositories = new Set([...projects.values()].map((w) => w.repo));
        return Promise.all([...repositories].map((repo) => {
            const pending = discoveries.get(repo);
            if (pending !== undefined)
                return pending;
            const discovery = worktreeRoots(repo)
                .then(watchRoots)
                .finally(() => { discoveries.delete(repo); });
            discoveries.set(repo, discovery);
            return discovery;
        })).then(() => { });
    };
    const discoverInBackground = () => {
        try {
            void discover().catch(report);
        }
        catch (cause) {
            report(cause);
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
        }
        catch (cause) {
            report(cause);
        }
        for (const w of [...projects.values()]) {
            if (!existsSync(w.root)) {
                if (w.scanning === undefined)
                    drop(w);
                continue;
            }
            try {
                if (ensureWatchers(w)) {
                    w.filesChanged = true;
                    schedule(w);
                }
            }
            catch (cause) {
                report(cause);
            }
        }
    };
    const evidenceDir = join(wardenHome(), "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    const evidenceWatcher = watch(evidenceDir, (_event, file) => {
        if (file === null || !file.endsWith(".jsonl") || file.endsWith(".1.jsonl"))
            return;
        const project = file.slice(0, -".jsonl".length);
        opts.onEvidence?.(project);
        const known = [...projects.values()].filter((w) => w.project === project);
        for (const w of known)
            schedule(w);
        if (known.length === 0)
            discoverInBackground();
    });
    try {
        void discover().catch(report);
    }
    catch (cause) {
        evidenceWatcher.close();
        throw cause;
    }
    tick();
    const interval = setInterval(() => {
        tick();
        discoverInBackground();
    }, opts.intervalMs ?? HEARTBEAT_MS);
    return {
        projects,
        startedAt,
        heartbeat,
        discover,
        rescan: async () => {
            for (const w of projects.values())
                w.filesChanged = true;
            await Promise.all([...projects.values()].map(scan));
            await Promise.all([...projects.values()].map(scan));
        },
        settled: async () => {
            while (discoveries.size > 0 || [...projects.values()].some((w) => w.scanning !== undefined || w.timer !== undefined))
                await new Promise((r) => setTimeout(r, 20));
        },
        stop: async () => {
            stopped = true;
            clearInterval(interval);
            await Promise.all(discoveries.values());
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
