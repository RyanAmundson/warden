import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { wardenVersion } from "../compiler/compile.js";
import { RecordError } from "../records/load.js";
import { type Daemon, type Detection, HEARTBEAT_MS, STALE_MS, heartbeatFile, readHeartbeat, startWatching } from "../runner/daemon.js";
import { type Evidence, readEvidence, wardenHome } from "../runner/evidence.js";
import { runRecords } from "./runs.js";
import { BANDS, bandCounts, loadView, packViolations } from "./view.js";

export const DEFAULT_PORT = 7419;

export const LABEL = "warden.daemon";

const PAGES = new Set(["/", "/runs", "/run", "/layers", "/violations", "/determinism", "/tamper"]);

const ASSETS: Record<string, string> = { "/app.css": "text/css; charset=utf-8", "/app.js": "text/javascript; charset=utf-8", "/render.js": "text/javascript; charset=utf-8" };

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly next: string,
  ) {
    super(message);
  }
}

interface ProjectEntry {
  project: string;
  roots: string[];
}

const projectsOf = (daemon: Daemon): ProjectEntry[] => {
  const byName = new Map<string, string[]>();
  for (const w of daemon.projects.values()) byName.set(w.project, [...(byName.get(w.project) ?? []), w.root]);
  return [...byName].map(([project, roots]) => ({ project, roots })).sort((a, b) => a.project.localeCompare(b.project));
};

const lastRan = (evidence: Evidence[]): Evidence | undefined => runRecords(evidence).filter((e) => e.outcome === "ran").at(-1);

const openAlerts = (daemon: Daemon, project?: string): Detection[] => [...daemon.projects.values()].filter((w) => project === undefined || w.project === project).flatMap((w) => [...w.open.values()]);

const bandsOf = (run: Evidence): Record<string, number> => Object.fromEntries([...BANDS.map((b) => b.name.toLowerCase()), "unknown"].map((name, i) => [name, bandCounts(run)[i] ?? 0]));

export async function route(daemon: Daemon, wardenRoot: string, url: URL): Promise<unknown> {
  const projects = projectsOf(daemon);
  const pick = (): ProjectEntry => {
    const name = url.searchParams.get("project");
    if (name === null) throw new HttpError(400, `${url.pathname} needs ?project=<name>`, `add ?project= with a name from GET /api/projects`);
    const found = projects.find((p) => p.project === name);
    if (found === undefined) throw new HttpError(404, `the daemon watches no project named ${name}`, "pick a project name from GET /api/projects");
    return found;
  };
  switch (url.pathname) {
    case "/api/health": {
      const beat = readHeartbeat();
      return { status: "ok", pid: process.pid, version: await wardenVersion(wardenRoot), startedAt: daemon.startedAt, heartbeatAt: beat?.at ?? null, heartbeatFile: heartbeatFile(), intervalMs: HEARTBEAT_MS, staleAfterMs: STALE_MS, port: beat?.port ?? null, projects: projects.length, openAlerts: openAlerts(daemon).length };
    }
    case "/api/projects":
      return { projects: projects.map((p) => ({ ...p, lastRun: runRecords(readEvidence(p.project)).at(-1) ?? null, openAlerts: openAlerts(daemon, p.project).length })) };
    case "/api/runs": {
      const { project } = pick();
      const limit = Number(url.searchParams.get("limit") ?? "20");
      if (!Number.isInteger(limit) || limit < 1) throw new HttpError(400, `limit must be a positive integer, not ${url.searchParams.get("limit")}`, "pass ?limit= with a positive integer");
      return { project, runs: runRecords(readEvidence(project)).slice(-limit).reverse() };
    }
    case "/api/layers": {
      const { project, roots } = pick();
      const model = await loadView(roots[0] as string, wardenRoot);
      const promoted = new Set(model.practices.filter((p) => p.promote).map((p) => p.practice));
      return {
        project,
        bands: BANDS.map((b) => ({ band: b.name.toLowerCase(), kinds: b.kinds.map((kind) => ({ kind, rules: model.layers.filter((r) => r.kind === kind).map((r) => ({ ...r, promote: promoted.has(r.practice) })) })) })),
        practices: model.practices,
        packs: model.packList,
      };
    }
    case "/api/violations": {
      const { project, roots } = pick();
      const model = await loadView(roots[0] as string, wardenRoot);
      return {
        project,
        packs: packViolations(model).map((p) => ({ pack: p.label, baselined: p.old, new: p.fresh ?? null, lastRun: p.run === undefined ? null : { at: p.run.at, trigger: p.run.trigger ?? null, run: p.run.run ?? null }, guardrails: p.rows.map((r) => ({ guardrail: r.label.trim(), baselined: r.old, new: r.fresh ?? null })) })),
      };
    }
    case "/api/determinism":
      return {
        projects: projects.map(({ project }) => {
          const run = lastRan(readEvidence(project));
          return { project, run: run?.run ?? null, at: run?.at ?? null, counts: run === undefined ? null : bandsOf(run) };
        }),
      };
    case "/api/tamper": {
      const project = url.searchParams.get("project") ?? undefined;
      const names = project === undefined ? projects.map((p) => p.project) : [pick().project];
      return { open: openAlerts(daemon, project), recent: names.flatMap((name) => readEvidence(name).filter((e) => e.kind === "tampered").map((e) => ({ project: name, ...e }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50) };
    }
    default:
      throw new HttpError(404, `no route ${url.pathname}`, "GET /api/health, /api/projects, /api/runs, /api/layers, /api/violations, /api/determinism, /api/tamper, or /api/events");
  }
}

export interface Served {
  server: Server;
  daemon: Daemon;
  port: number;
  close(): Promise<void>;
}

export async function serve(wardenRoot: string, port: number, opts: { intervalMs?: number; debounceMs?: number } = {}): Promise<Served> {
  const clients = new Set<ServerResponse>();
  const send = (event: string, data: unknown): void => {
    for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = (server.address() as { port: number }).port;
  const hosts = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`]);
  const daemon = startWatching({ wardenRoot, port: bound, ...opts, onDetection: (d) => send("tamper", d), onEvidence: (project) => send("evidence", { project }) });
  const beat = setInterval(() => send("heartbeat", readHeartbeat() ?? null), opts.intervalMs ?? HEARTBEAT_MS);
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${bound}`);
    if (!hosts.has(req.headers.host ?? "")) {
      res.writeHead(403, { "content-type": "application/json" }).end(`${JSON.stringify({ error: `Host ${req.headers.host ?? "(none)"} is not this daemon`, next: `open http://127.0.0.1:${bound}/ directly` })}\n`);
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" }).end(`${JSON.stringify({ error: `${req.method} is not supported`, next: "send a GET request" })}\n`);
      return;
    }
    const asset = PAGES.has(url.pathname) ? { file: "index.html", type: "text/html; charset=utf-8" } : Object.hasOwn(ASSETS, url.pathname) ? { file: url.pathname.slice(1), type: ASSETS[url.pathname] as string } : undefined;
    if (asset !== undefined) {
      readFile(join(wardenRoot, "web", asset.file)).then(
        (body) => res.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache" }).end(body),
        (cause: Error) => res.writeHead(500, { "content-type": "application/json" }).end(`${JSON.stringify({ error: cause.message, next: "reinstall Warden so its web folder is present" })}\n`),
      );
      return;
    }
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`retry: ${HEARTBEAT_MS}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    route(daemon, wardenRoot, url).then(
      (body) => res.writeHead(200, { "content-type": "application/json" }).end(`${JSON.stringify(body)}\n`),
      (cause: Error) => {
        const http = cause instanceof HttpError ? cause : cause instanceof RecordError ? new HttpError(422, cause.message, /Next action: (.*?)\.?$/.exec(cause.message)?.[1] ?? "run warden check in the project and fix what it reports") : new HttpError(500, cause.message, "read the daemon log and fix what it names");
        res.writeHead(http.status, { "content-type": "application/json" }).end(`${JSON.stringify({ error: http.message, next: http.next })}\n`);
      },
    );
  });
  return {
    server,
    daemon,
    port: bound,
    close: async () => {
      clearInterval(beat);
      for (const res of clients) res.end();
      clients.clear();
      await daemon.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function runDaemon(wardenRoot: string, port: number): Promise<number> {
  let served: Served;
  try {
    served = await serve(wardenRoot, port);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EADDRINUSE") throw cause;
    process.stderr.write(`port ${port} on 127.0.0.1 is in use, perhaps by another warden daemon. Next action: run warden daemon --port <a free port>\n`);
    return 2;
  }
  process.stdout.write(`warden daemon listening on http://127.0.0.1:${served.port}, watching ${served.daemon.projects.size} project${served.daemon.projects.size === 1 ? "" : "s"}\n`);
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  await served.close();
  return 0;
}

export const plistFile = (): string => join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);

const xml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const plist = (main: string, port: number): string => {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", WARDEN_HOME: wardenHome(), ...(process.env.CLAUDE_CONFIG_DIR === undefined ? {} : { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }) };
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

const domain = (): string => `gui/${userInfo().uid}`;

const launchctl = (...args: string[]): { status: number | null; err: string } => {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  if (r.error !== undefined) throw r.error;
  return { status: r.status, err: r.stderr.trim() };
};

const loaded = (): boolean => launchctl("print", `${domain()}/${LABEL}`).status === 0;

export function installDaemon(main: string, port: number): number {
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

export function uninstallDaemon(): number {
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
