import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { wardenVersion } from "../compiler/compile.js";
import { RecordError } from "../records/load.js";
import { HEARTBEAT_MS, STALE_MS, UNWIRED, heartbeatFile, readHeartbeat, startWatching } from "../runner/daemon.js";
import { enrollmentPolicyDir } from "../runner/enrollment.js";
import { readEvidence, wardenHome } from "../runner/evidence.js";
import { PackSettingsError, packSettings, packSettingsBody, savePackSettings } from "./pack-settings.js";
import { currentRuleDetails, projectFailures, runEvidence } from "./run-evidence.js";
import { runRecords } from "./runs.js";
import { SAFE_NAME, VIDEO_FILE, recordingOf, videosRoot } from "./video.js";
import { BANDS, bandCounts, loadView, packViolations } from "./view.js";
export const LABEL = "warden.daemon";
const PAGES = new Set(["/", "/runs", "/run", "/failures", "/layers", "/violations", "/determinism", "/tamper"]);
const ASSETS = {
    "/app.css": "text/css; charset=utf-8",
    "/app.js": "text/javascript; charset=utf-8",
    "/render.js": "text/javascript; charset=utf-8",
    "/fonts/Archivo.woff2": "font/woff2",
    "/fonts/JetBrainsMono.woff2": "font/woff2",
};
class HttpError extends Error {
    status;
    next;
    constructor(status, message, next) {
        super(message);
        this.status = status;
        this.next = next;
    }
}
const projectsOf = (daemon) => {
    const byName = new Map();
    for (const w of daemon.projects.values()) {
        const repositories = byName.get(w.project) ?? new Map();
        const entry = repositories.get(w.repo) ?? { repo: w.repo, roots: [], openAlerts: 0 };
        entry.roots.push(w.root);
        entry.openAlerts += w.open.size;
        repositories.set(w.repo, entry);
        byName.set(w.project, repositories);
    }
    const watched = [...byName].map(([project, repos]) => {
        const repositories = [...repos.values()];
        return { project, roots: repositories.flatMap((r) => r.roots), repositories };
    });
    for (const auditOnly of daemon.auditOnly.values())
        watched.push({ project: auditOnly.project, roots: [], repositories: [], auditOnly });
    return watched.sort((a, b) => a.project.localeCompare(b.project));
};
const runSummary = (run) => {
    if (run?.report === undefined)
        return run ?? null;
    const { failures: _failures, ...summary } = run;
    return summary;
};
const lastRan = (evidence) => runRecords(evidence).filter((e) => e.outcome === "ran").at(-1);
const openAlerts = (daemon, project, repo) => [...daemon.projects.values()]
    .filter((w) => (project === undefined || w.project === project) && (repo === undefined || w.repo === repo))
    .flatMap((w) => [...w.open.values()]);
const projectEvidence = ({ project, auditOnly }) => {
    const evidence = readEvidence(project);
    return auditOnly === undefined ? evidence : evidence.filter((run) => run.trigger === "main audit" && run.root === auditOnly.root && run.ref === auditOnly.ref);
};
const modeOf = (runs) => {
    const last = runs.filter((run) => run.trigger !== "audit" && run.trigger !== "main audit" && run.steps?.["tools-ready"] !== undefined).at(-1);
    return last === undefined ? null : last.mode ?? "enforce";
};
const bandsOf = (run) => Object.fromEntries([...BANDS.map((b) => b.name.toLowerCase()), "unknown"].map((name, i) => [name, bandCounts(run)[i] ?? 0]));
function projectCheckout(daemon, entry, url) {
    if (entry.auditOnly !== undefined)
        throw new HttpError(409, "This project audits a published ref and has no watched checkouts.", "open GET /api/runs or GET /api/failures for the published audit");
    const selected = url.searchParams.get("root");
    if (selected !== null && !entry.roots.includes(selected)) {
        throw new PackSettingsError(404, "This checkout is not watched for the selected project.");
    }
    const roots = entry.roots.filter((root) => existsSync(join(root, ".warden", "config.yaml")));
    const root = selected ?? roots.find((path) => daemon.projects.get(path)?.repo === join(path, ".git")) ?? roots[0];
    if (!root || !roots.includes(root))
        throw new PackSettingsError(409, "The selected project's config is unavailable. Reload the project list.");
    return root;
}
export async function changeProjectPacks(daemon, wardenRoot, url, request) {
    const { revision, changes } = await packSettingsBody(request);
    const entry = projectsOf(daemon).find((project) => project.project === url.searchParams.get("project"));
    if (!entry || !url.searchParams.has("root"))
        throw new PackSettingsError(404, "Select a watched project and checkout.");
    const root = projectCheckout(daemon, entry, url);
    return savePackSettings(root, entry.project, wardenRoot, revision, changes);
}
export async function route(daemon, wardenRoot, url) {
    const projects = projectsOf(daemon);
    const pick = () => {
        const name = url.searchParams.get("project");
        if (name === null)
            throw new HttpError(400, `${url.pathname} needs ?project=<name>`, `add ?project= with a name from GET /api/projects`);
        const found = projects.find((p) => p.project === name);
        if (found === undefined)
            throw new HttpError(404, `the daemon watches no project named ${name}`, "pick a project name from GET /api/projects");
        return found;
    };
    switch (url.pathname) {
        case "/api/health": {
            const beat = readHeartbeat();
            return { status: "ok", pid: process.pid, version: await wardenVersion(wardenRoot), startedAt: daemon.startedAt, heartbeatAt: beat?.at ?? null, heartbeatFile: heartbeatFile(), intervalMs: HEARTBEAT_MS, staleAfterMs: STALE_MS, port: beat?.port ?? null, projects: projects.length, openAlerts: openAlerts(daemon).length };
        }
        case "/api/projects":
            return { projects: projects.map((p) => {
                    const runs = runRecords(projectEvidence(p));
                    const mainRuns = p.auditOnly === undefined
                        ? runs.filter((run) => run.trigger === "main audit" && run.root !== undefined && p.roots.includes(run.root))
                        : runs.filter((run) => run.report === undefined);
                    const latestReports = new Map(runs.flatMap((run) => run.report === undefined ? [] : [[run.report.adapter, run]]));
                    const latest = mainRuns.at(-1);
                    const revisionRuns = mainRuns.filter((run) => run.commit === latest?.commit && run.ref === latest?.ref && run.root === latest?.root);
                    return {
                        ...p,
                        lastRun: runSummary(runs.at(-1)),
                        lastMainAudit: latest ?? null,
                        mainReports: [...latestReports.values()].map(runSummary),
                        mainAuditRuns: ["edit", "boundary"].flatMap((tier) => revisionRuns.filter((run) => run.tier === tier).slice(-1)),
                        openAlerts: p.repositories.reduce((sum, r) => sum + r.openAlerts, 0),
                        mode: p.auditOnly === undefined ? modeOf(runs) : "audit",
                        unwired: [...new Map(openAlerts(daemon, p.project).filter((d) => UNWIRED.has(d.detail)).map((d) => [`${d.repo}\0${d.detail}\0${d.file}`, d])).values()],
                    };
                }) };
        case "/api/runs": {
            const entry = pick();
            const { project } = entry;
            const limit = Number(url.searchParams.get("limit") ?? "20");
            if (!Number.isInteger(limit) || limit < 1)
                throw new HttpError(400, `limit must be a positive integer, not ${url.searchParams.get("limit")}`, "pass ?limit= with a positive integer");
            const evidence = projectEvidence(entry);
            const id = url.searchParams.get("run") ?? (url.searchParams.has("detail") ? runRecords(evidence).at(-1)?.run ?? null : null);
            const detail = id === null ? undefined : runEvidence(evidence, id, limit);
            const runs = id === null ? runRecords(evidence).slice(-limit).reverse() : (detail?.runs ?? []);
            const run = detail?.runs[0];
            const enrollment = entry.auditOnly;
            const root = run?.root;
            const ruleDetails = detail !== undefined && run !== undefined && run.report === undefined && root !== undefined && (enrollment !== undefined || entry.roots.includes(root))
                ? await currentRuleDetails(run, detail.findings, project, root, wardenRoot, enrollment && enrollmentPolicyDir(enrollment.dir))
                : undefined;
            return { project, ...detail, ...(ruleDetails === undefined ? {} : { currentRuleDetails: ruleDetails }), runs: runs.map((run) => {
                    const video = run.run === undefined ? undefined : recordingOf(project, run.run);
                    return video === undefined ? run : { ...run, video };
                }) };
        }
        case "/api/failures": {
            const entry = pick();
            const { project, roots, auditOnly } = entry;
            return { project, ...projectFailures(projectEvidence(entry), auditOnly === undefined ? roots : [auditOnly.root]), alerts: openAlerts(daemon, project) };
        }
        case "/api/layers": {
            const entry = pick();
            const { project } = entry;
            const root = projectCheckout(daemon, entry, url);
            const model = await loadView(root, wardenRoot);
            const promoted = new Set(model.practices.filter((p) => p.promote).map((p) => p.practice));
            return {
                project,
                bands: BANDS.map((b) => ({ band: b.name.toLowerCase(), kinds: b.kinds.map((kind) => ({ kind, rules: model.layers.filter((r) => r.kind === kind).map((r) => ({ ...r, promote: promoted.has(r.practice) })) })) })),
                practices: model.practices,
                packs: model.packList,
                ...(url.searchParams.get("edit") === "1" ? { packSettings: await packSettings(root, project, wardenRoot) } : {}),
            };
        }
        case "/api/violations": {
            const entry = pick();
            const { project } = entry;
            const root = projectCheckout(daemon, entry, url);
            const model = await loadView(root, wardenRoot);
            return {
                project,
                packs: packViolations(model).map((p) => ({ pack: p.label, baselined: p.old, new: p.fresh ?? null, lastRun: p.run === undefined ? null : { at: p.run.at, trigger: p.run.trigger ?? null, run: p.run.run ?? null }, guardrails: p.rows.map((r) => ({ guardrail: r.label.trim(), baselined: r.old, new: r.fresh ?? null })) })),
            };
        }
        case "/api/determinism":
            return {
                projects: projects.map((entry) => {
                    const { project } = entry;
                    const run = lastRan(projectEvidence(entry));
                    return { project, run: run?.run ?? null, at: run?.at ?? null, counts: run === undefined ? null : bandsOf(run) };
                }),
            };
        case "/api/tamper": {
            const project = url.searchParams.get("project") ?? undefined;
            const repo = url.searchParams.get("repo") ?? undefined;
            const entries = project === undefined ? projects : [pick()];
            if (repo !== undefined && !entries.some((entry) => entry.repositories.some((r) => r.repo === repo))) {
                throw new HttpError(404, "the selected repository is not watched", "pick a repository from GET /api/projects");
            }
            const recent = entries.flatMap((entry) => {
                const roots = new Set(entry.repositories.find((r) => r.repo === repo)?.roots);
                return readEvidence(entry.project).filter((e) => e.kind === "tampered" &&
                    (repo === undefined || (e.repo === undefined ? e.root !== undefined && roots.has(e.root) : e.repo === repo)))
                    .map((e) => ({ project: entry.project, ...e }));
            });
            return { open: openAlerts(daemon, project, repo), recent: recent.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50) };
        }
        default:
            throw new HttpError(404, `no route ${url.pathname}`, "GET /api/health, /api/projects, /api/runs, /api/video, /api/failures, /api/layers, /api/violations, /api/determinism, /api/tamper, or /api/events");
    }
}
const MEDIA = { webm: "video/webm", jpg: "image/jpeg" };
function videoFile(daemon, url) {
    const project = url.searchParams.get("project");
    const run = url.searchParams.get("run") ?? "";
    const name = url.searchParams.get("file") ?? "";
    if (project === null || !projectsOf(daemon).some((p) => p.project === project))
        throw new HttpError(404, `the daemon watches no project named ${project ?? "(none)"}`, "pick a project name from GET /api/projects");
    if (!SAFE_NAME.test(run) || !VIDEO_FILE.test(name))
        throw new HttpError(400, "/api/video needs ?run=<run id>&file=<name>.webm or .jpg", "take run and file from a run's video in GET /api/runs");
    const file = join(videosRoot(project), run, name);
    if (!existsSync(file))
        throw new HttpError(404, `run ${run} of ${project} has no recorded ${name}`, "take run and file from a run's video in GET /api/runs");
    return { file, type: MEDIA[name.slice(name.lastIndexOf(".") + 1)] };
}
function sendFile(req, res, { file, type }) {
    const size = statSync(file).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    const head = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-cache" };
    const first = range?.[1] ?? "";
    const last = range?.[2] ?? "";
    if (range === null || (first === "" && last === "") || (first !== "" && last !== "" && Number(first) > Number(last))) {
        res.writeHead(200, { ...head, "content-length": size });
        pipeline(createReadStream(file), res, () => { });
        return;
    }
    const start = first === "" ? Math.max(0, size - Number(last)) : Number(first);
    const end = first === "" || last === "" ? size - 1 : Math.min(Number(last), size - 1);
    if (start >= size) {
        res.writeHead(416, { ...head, "content-range": `bytes */${size}` }).end();
        return;
    }
    res.writeHead(206, { ...head, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    pipeline(createReadStream(file, { start, end }), res, () => { });
}
const failure = (cause) => cause instanceof HttpError ? cause : cause instanceof PackSettingsError ? new HttpError(cause.status, cause.message, "review the pack selection and reload Layers if the checkout changed") : cause instanceof RecordError ? new HttpError(422, cause.message, /Next action: (.*?)\.?$/.exec(cause.message)?.[1] ?? "run warden check in the project and fix what it reports") : new HttpError(500, cause.message, "read the daemon log and fix what it names");
const sendError = (res, cause) => {
    const http = failure(cause);
    res.writeHead(http.status, { "content-type": "application/json" }).end(`${JSON.stringify({ error: http.message, next: http.next })}\n`);
};
export async function serve(wardenRoot, port, opts = {}) {
    const clients = new Set();
    const send = (event, data) => {
        for (const res of clients)
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const bound = server.address().port;
    const hosts = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`]);
    let daemon;
    try {
        daemon = startWatching({ wardenRoot, port: bound, ...opts, onDetection: (d) => send("tamper", d), onEvidence: (project) => send("evidence", { project }) });
    }
    catch (cause) {
        await new Promise((resolve) => server.close(() => resolve()));
        throw cause;
    }
    const beat = setInterval(() => send("heartbeat", readHeartbeat() ?? null), opts.intervalMs ?? HEARTBEAT_MS);
    server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${bound}`);
        if (!hosts.has(req.headers.host ?? "")) {
            res.writeHead(403, { "content-type": "application/json" }).end(`${JSON.stringify({ error: `Host ${req.headers.host ?? "(none)"} is not this daemon`, next: `open http://127.0.0.1:${bound}/ directly` })}\n`);
            return;
        }
        const changes = req.method === "POST" && url.pathname === "/api/packs";
        if (req.method !== "GET" && !changes) {
            res.writeHead(405, { "content-type": "application/json" }).end(`${JSON.stringify({ error: `${req.method} is not supported`, next: "send a GET request" })}\n`);
            return;
        }
        const asset = PAGES.has(url.pathname) ? { file: "index.html", type: "text/html; charset=utf-8" } : Object.hasOwn(ASSETS, url.pathname) ? { file: url.pathname.slice(1), type: ASSETS[url.pathname] } : undefined;
        if (asset !== undefined) {
            readFile(join(wardenRoot, "web", asset.file)).then((body) => res.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache" }).end(body), (cause) => res.writeHead(500, { "content-type": "application/json" }).end(`${JSON.stringify({ error: cause.message, next: "reinstall Warden so its web folder is present" })}\n`));
            return;
        }
        if (url.pathname === "/api/events") {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
            res.write(`retry: ${HEARTBEAT_MS}\n\n`);
            clients.add(res);
            req.on("close", () => clients.delete(res));
            return;
        }
        if (url.pathname === "/api/video") {
            try {
                sendFile(req, res, videoFile(daemon, url));
            }
            catch (cause) {
                sendError(res, cause);
            }
            return;
        }
        const result = changes ? changeProjectPacks(daemon, wardenRoot, url, req) : route(daemon, wardenRoot, url);
        result.then((body) => res.writeHead(200, { "content-type": "application/json" }).end(`${JSON.stringify(body)}\n`), (cause) => sendError(res, cause));
    });
    return {
        server,
        daemon,
        port: bound,
        close: async () => {
            clearInterval(beat);
            for (const res of clients)
                res.end();
            clients.clear();
            await daemon.stop();
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
export async function runDaemon(wardenRoot, port) {
    let served;
    try {
        served = await serve(wardenRoot, port);
    }
    catch (cause) {
        const next = cause.code === "EADDRINUSE" ? `port ${port} on 127.0.0.1 is in use, perhaps by another warden daemon. Next action: run warden daemon --port <a free port>` : cause.message.includes("Next action: ") ? `the daemon could not start: ${cause instanceof RecordError ? `${cause.file} ` : ""}${cause.message}` : `the daemon could not start: ${cause.message}. Next action: fix what that names under ${wardenHome()}, then run warden daemon`;
        process.stderr.write(`${next}\n`);
        return 2;
    }
    process.stdout.write(`warden daemon listening on http://127.0.0.1:${served.port}, watching ${served.daemon.projects.size} project${served.daemon.projects.size === 1 ? "" : "s"}\n`);
    await new Promise((resolve) => {
        process.once("SIGTERM", resolve);
        process.once("SIGINT", resolve);
    });
    await served.close();
    return 0;
}
export const plistFile = () => join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const xml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export const plist = (main, port) => {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", WARDEN_HOME: wardenHome(), ...(process.env.CLAUDE_CONFIG_DIR === undefined ? {} : { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }) };
    const log = join(wardenHome(), "daemon", "daemon.log");
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        `  <key>Label</key><string>${LABEL}</string>`,
        "  <key>ProgramArguments</key>",
        "  <array>",
        ...[process.execPath, main, "daemon", "--port", String(port)].map((a) => `    <string>${xml(a)}</string>`),
        "  </array>",
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        ...Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`),
        "  </dict>",
        "  <key>RunAtLoad</key><true/>",
        "  <key>KeepAlive</key><true/>",
        `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
        `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
        "</dict>",
        "</plist>",
        "",
    ].join("\n");
};
const domain = () => `gui/${userInfo().uid}`;
const launchctl = (...args) => {
    const r = spawnSync("launchctl", args, { encoding: "utf8" });
    if (r.error !== undefined)
        throw r.error;
    return { status: r.status, err: r.stderr.trim() };
};
const loaded = () => launchctl("print", `${domain()}/${LABEL}`).status === 0;
export function installDaemon(main, port) {
    mkdirSync(join(wardenHome(), "daemon"), { recursive: true });
    mkdirSync(dirname(plistFile()), { recursive: true });
    writeFileSync(plistFile(), plist(main, port));
    if (loaded()) {
        const out = launchctl("bootout", `${domain()}/${LABEL}`);
        if (out.status !== 0) {
            process.stderr.write(`launchctl bootout failed: ${out.err}. Next action: run launchctl bootout ${domain()}/${LABEL}, then warden daemon install\n`);
            return 2;
        }
    }
    const out = launchctl("bootstrap", domain(), plistFile());
    if (out.status !== 0) {
        process.stderr.write(`launchctl bootstrap failed: ${out.err}. Next action: run launchctl bootstrap ${domain()} ${plistFile()} and fix the error it prints\n`);
        return 2;
    }
    process.stdout.write(`Installed ${plistFile()}; the daemon serves http://127.0.0.1:${port}\n`);
    return 0;
}
export function uninstallDaemon() {
    if (loaded()) {
        const out = launchctl("bootout", `${domain()}/${LABEL}`);
        if (out.status !== 0) {
            process.stderr.write(`launchctl bootout failed: ${out.err}. Next action: run launchctl bootout ${domain()}/${LABEL}, then warden daemon uninstall\n`);
            return 2;
        }
    }
    const had = existsSync(plistFile());
    rmSync(plistFile(), { force: true });
    process.stdout.write(had ? `Removed ${plistFile()}\n` : `${plistFile()} was not installed; nothing to remove\n`);
    return 0;
}
