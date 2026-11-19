import { execFileSync } from "node:child_process";
import { type FSWatcher, existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { COMMIT_HOOK } from "../compiler/emit.js";
import { LOCK_PATH, firstLine, readLock } from "../compiler/lock.js";
import { RecordError, loadRecords, parseConfig } from "../records/load.js";
import { type Committed, allTips, commitsOf, commonDir, covers, newCommits, reachable, repoTips, restoreAction, worktrees } from "./changed.js";
import { type PluginState, claudeDir, commitHookItem, pluginAction, pluginState } from "./doctor.js";
import { type Evidence, LOOP_TAIL_BYTES, RUN_TOTAL, appendEvidence, evidenceProjects, readEvidenceFrom, readEvidenceTail, wardenHome } from "./evidence.js";
import { formatFeedback } from "./feedback.js";
import { findTampering } from "./tamper.js";

export const HEARTBEAT_MS = 10_000;

export const STALE_MS = 30_000;

export const SKEW_MS = 5_000;

export const START_DAEMON = "start the daemon: warden daemon install";

export interface Heartbeat {
  pid: number;
  at: string;
  startedAt: string;
  port: number;
}

export interface Detection {
  project: string;
  root: string;
  repo: string;
  file: string;
  detail: string;
  next: string;
}

interface RootState {
  open: Detection[];
  plugin?: PluginState["state"];
  pluginEnabled?: boolean;
}

interface RepoState {
  tips: string[];
  unchecked: Committed[];
}

interface State {
  roots: Record<string, RootState>;
  repos: Record<string, RepoState>;
}

export const heartbeatFile = (): string => join(wardenHome(), "daemon", "heartbeat.json");

export const stateFile = (): string => join(wardenHome(), "daemon", "state.json");

const writeAtomic = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, file);
};

const readOptional = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
};

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isHeartbeat = (value: unknown): value is Heartbeat => {
  const v = value as Partial<Heartbeat> | null;
  return typeof v === "object" && v !== null && typeof v.pid === "number" && typeof v.at === "string" && !Number.isNaN(Date.parse(v.at)) && typeof v.port === "number";
};

export function readHeartbeat(): Heartbeat | null | undefined {
  const text = readOptional(heartbeatFile());
  if (text === undefined) return undefined;
  const value = parsed(text);
  return isHeartbeat(value) ? value : null;
}

const alive = (pid: number): boolean => {
  if (pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

export function heartbeatProblem(now = Date.now()): string | undefined {
  const beat = readHeartbeat();
  const file = heartbeatFile();
  if (beat === undefined) return `Warden's daemon is not running: ${file} is missing. Next action: ${START_DAEMON}`;
  if (beat === null) return `${file} does not hold a heartbeat. Next action: ${START_DAEMON}`;
  const age = now - Date.parse(beat.at);
  if (age < -SKEW_MS) return `Warden's daemon heartbeat is dated ${Math.round(-age / 1000)} s in the future, so the daemon did not write it. Next action: ${START_DAEMON}`;
  if (age > STALE_MS) return `Warden's daemon heartbeat is ${Math.round(age / 1000)} s old; it is stale after ${STALE_MS / 1000} s. Next action: ${START_DAEMON}`;
  if (!alive(beat.pid)) return `Warden's daemon heartbeat names process ${beat.pid}, which is not a running daemon. Next action: ${START_DAEMON}`;
  return undefined;
}

export function readState(): State {
  const text = readOptional(stateFile());
  if (text === undefined) return { roots: {}, repos: {} };
  const value = parsed(text) as Partial<State> | undefined;
  if (typeof value !== "object" || value === null) throw new RecordError(stateFile(), "", `is not valid JSON. Next action: delete ${stateFile()} and restart the daemon; it rebuilds the file from git and Evidence`);
  return { roots: value.roots ?? {}, repos: value.repos ?? {} };
}

export function openAlerts(root: string): Detection[] {
  const repo = commonDir(root);
  return Object.values(readState().roots)
    .flatMap((r) => r.open)
    .filter((d) => d.repo === repo);
}

export function discoverRoots(): string[] {
  const roots = evidenceProjects().flatMap((p) => readEvidenceTail(p, LOOP_TAIL_BYTES).flatMap((e) => (e.root === undefined ? [] : [e.root])));
  return [...new Set(roots)].filter((r) => existsSync(join(r, ".warden/config.yaml")));
}

const nextOf = (message: string): string | undefined => {
  const at = message.indexOf("Next action: ");
  return at === -1 ? undefined : message.slice(at + "Next action: ".length).replace(/\.$/, "");
};

const now = (): string => new Date().toISOString();

const isRun = (e: Evidence): boolean => e.kind === "cost" && e.guardrail === RUN_TOTAL;

interface Index {
  offset: number;
  stamps: Evidence[];
  gateOff: Evidence[];
  offRuns: Set<string | undefined>;
  lastGated: Map<string, string>;
  unchecked: Set<string>;
  enabledRoots: Set<string>;
}

const emptyIndex = (): Index => ({ offset: 0, stamps: [], gateOff: [], offRuns: new Set(), lastGated: new Map(), unchecked: new Set(), enabledRoots: new Set() });

const refresh = (index: Index, project: string): Index => {
  const { events, offset } = readEvidenceFrom(project, index.offset);
  const ix = offset < index.offset ? emptyIndex() : index;
  ix.offset = offset;
  for (const e of events) {
    if (e.kind === "gate-off") {
      ix.gateOff.push(e);
      ix.offRuns.add(e.run);
    }
    if (e.kind === "commit" && e.commit !== undefined) {
      if (e.status === "unchecked") ix.unchecked.add(e.commit);
      else ix.unchecked.delete(e.commit);
    }
    if (e.kind === "plugin" && e.status === "enabled" && e.root !== undefined) ix.enabledRoots.add(e.root);
    if (!isRun(e) || e.tier !== "commit") continue;
    if (e.tree !== undefined && e.scope === "full" && (e.result === "pass" || e.outcome === "empty")) ix.stamps.push(e);
    if (e.root !== undefined && e.outcome !== "refused" && !ix.offRuns.has(e.run)) ix.lastGated.set(e.root, e.at);
  }
  return ix;
};

const stamped = (root: string, index: Index, c: Committed): boolean => c.expectedTree === c.tree || index.stamps.some((s) => covers(root, s, c));

type Found = Omit<Detection, "project" | "root" | "repo">;

const uncheckedAlert = (c: Committed, base: string): Found => {
  const short = c.commit.slice(0, 12);
  const next =
    c.parents[0] === undefined
      ? `run git switch -c warden-check-${short} ${base}, then git read-tree -u --reset ${short}, then warden check --base ${base}`
      : `in a checkout of commit ${short} with nothing staged, run warden check --base ${short}^`;
  return { file: c.commit, detail: "unchecked-commit", next };
};

const projectOf = (root: string): string => {
  try {
    return parseConfig(".warden/config.yaml", readFileSync(join(root, ".warden/config.yaml"), "utf8")).project;
  } catch (cause) {
    if (!(cause instanceof RecordError)) throw cause;
    return basename(root);
  }
};

const gitPath = (root: string, args: string[]): string => resolve(root, execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());

const REPO_FILE = /^(config|packed-refs|HEAD|refs\/heads\/.+|worktrees\/[^/]+\/HEAD)$/;

interface WatchSpec {
  path: string;
  recursive: boolean;
  accept?: (name: string) => boolean;
  changes?: boolean;
}

const named =
  (...names: string[]) =>
  (name: string): boolean =>
    names.includes(name);

const watchSpecs = (root: string): WatchSpec[] => [
  { path: join(root, ".warden"), recursive: true, changes: true },
  { path: root, recursive: false, accept: named(".warden", ".claude") },
  { path: gitPath(root, ["rev-parse", "--git-common-dir"]), recursive: true, accept: (name) => REPO_FILE.test(name) },
  { path: gitPath(root, ["rev-parse", "--git-path", "hooks"]), recursive: false },
  { path: join(root, ".claude"), recursive: false, accept: named("settings.json", "settings.local.json") },
  { path: claudeDir(), recursive: false, accept: named("settings.json") },
];

export interface DaemonOptions {
  wardenRoot: string;
  port: number;
  intervalMs?: number;
  debounceMs?: number;
  onDetection?: (d: Detection) => void;
  onEvidence?: (project: string) => void;
  onError?: (cause: Error) => void;
}

export interface Watched {
  root: string;
  project: string;
  repo: string;
  specs: WatchSpec[];
  open: Map<string, Detection>;
  watchers: Map<string, FSWatcher>;
  changes: Set<string>;
  filesChanged: boolean;
  recordFound: Detection[];
  base?: string;
  timer?: NodeJS.Timeout;
  scanning?: Promise<void>;
  again?: boolean;
}

export interface Daemon {
  projects: Map<string, Watched>;
  startedAt: string;
  heartbeat(): Heartbeat;
  discover(): void;
  rescan(): Promise<void>;
  settled(): Promise<void>;
  stop(): Promise<void>;
}

const key = (d: { root?: string; file?: string; detail?: string }): string => `${d.root ?? ""}\0${d.file ?? ""}\0${d.detail ?? ""}`;

export function startWatching(opts: DaemonOptions): Daemon {
  const projects = new Map<string, Watched>();
  const indexes = new Map<string, Index>();
  const state = readState();
  const startedAt = now();
  const debounce = opts.debounceMs ?? 200;
  let stopped = false;
  const report = (cause: unknown): void => (opts.onError ?? ((e) => process.stderr.write(`${e.message}\n`)))(cause instanceof Error ? cause : new Error(String(cause)));
  const saveState = (): void => writeAtomic(stateFile(), `${JSON.stringify(state)}\n`);
  const indexFor = (project: string): Index => {
    const ix = refresh(indexes.get(project) ?? emptyIndex(), project);
    indexes.set(project, ix);
    return ix;
  };
  const owner = (w: Watched): boolean => [...projects.values()].find((x) => x.repo === w.repo) === w;

  const pluginFound = (w: Watched, own: RootState, ix: Index): Found[] => {
    let plugin: PluginState;
    try {
      plugin = pluginState(w.root);
    } catch (cause) {
      if (!(cause instanceof RecordError)) throw cause;
      report(cause);
      return [...w.open.values()].filter((d) => d.detail.startsWith("plugin-"));
    }
    if (own.plugin !== plugin.state) {
      appendEvidence(w.project, { at: now(), kind: "plugin", trigger: "daemon", root: w.root, status: plugin.state, file: plugin.file });
      own.plugin = plugin.state;
    }
    if (plugin.state === "enabled") own.pluginEnabled = true;
    if (plugin.state === "enabled" || (own.pluginEnabled !== true && !ix.enabledRoots.has(w.root))) return [];
    return [{ file: plugin.file, detail: `plugin-${plugin.state}`, next: pluginAction(plugin) }];
  };

  const gateOffFound = (w: Watched, ix: Index): Found[] => {
    const gated = ix.lastGated.get(w.root);
    return ix.gateOff
      .filter((e) => e.root === w.root && (gated === undefined || e.at > gated))
      .map((e) => ({ file: `run ${e.run ?? ""}`, detail: "gate-off", next: `unset WARDEN_DAEMON, then run warden check --base ${e.base ?? "main"} in ${w.root} with the daemon running` }));
  };

  const commitFound = (w: Watched, base: string): Found[] => {
    const tips = repoTips(w.root);
    const ix = indexFor(w.project);
    const known = state.repos[w.repo];
    const rebuilt = known === undefined ? commitsOf(w.root, [...ix.unchecked]) : [];
    const fresh = newCommits(w.root, tips, known?.tips ?? tips).filter((c) => {
      const checked = stamped(w.root, ix, c);
      appendEvidence(w.project, { at: now(), kind: "commit", trigger: "daemon", root: w.root, commit: c.commit, tree: c.tree, status: checked ? "checked" : "unchecked" });
      return !checked;
    });
    const pending = [...(known?.unchecked ?? []), ...rebuilt, ...fresh];
    const refs = allTips(w.root);
    const unchecked = pending.filter((c, i) => pending.findIndex((x) => x.commit === c.commit) === i && !stamped(w.root, ix, c) && reachable(w.root, c.commit, refs));
    state.repos[w.repo] = { tips, unchecked };
    return unchecked.map((c) => uncheckedAlert(c, base));
  };

  const scanRoot = async (w: Watched): Promise<Detection[]> => {
    const own = (state.roots[w.root] ??= { open: [] });
    const at = (d: Found): Detection => ({ project: w.project, root: w.root, repo: w.repo, ...d });
    if (!existsSync(join(w.root, ".warden/config.yaml"))) return [at({ file: ".warden/config.yaml", detail: "removed", next: restoreAction(w.root, ".warden/config.yaml") })];
    const ix = indexFor(w.project);
    const found: Detection[] = [];
    const guarded = (source: string, run: () => Found[]): void => {
      try {
        found.push(...run().map(at));
      } catch (cause) {
        report(cause);
        found.push(at({ file: source, detail: "scan-error", next: `fix what this error names in ${w.root}, and the daemon scans again: ${firstLine((cause as Error).message)}` }));
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
        for (const t of await findTampering(set, opts.wardenRoot, w.base, false)) {
          const next = (JSON.parse(formatFeedback([], set, "json", { tampered: [t] })) as { next: string }).next.replace(/\.$/, "");
          w.recordFound.push(at({ file: t.file, detail: t.guardrail === undefined ? t.detail : `${t.detail} ${t.guardrail}`, next }));
        }
      } catch (cause) {
        report(cause);
        w.recordFound.push(
          cause instanceof RecordError
            ? at({ file: cause.file, detail: "record-error", next: nextOf(cause.message) ?? `run warden compile in ${w.root} and fix what it reports` })
            : at({ file: ".warden", detail: "scan-error", next: `fix what this error names in ${w.root}, and the daemon scans again: ${firstLine((cause as Error).message)}` }),
        );
      }
    }
    if (owner(w)) guarded("git history", () => commitFound(w, w.base ?? "main"));
    return [...found, ...w.recordFound];
  };

  const schedule = (w: Watched): void => {
    if (stopped) return;
    clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      w.timer = undefined;
      void scan(w);
    }, debounce);
  };
  const ensureWatchers = (w: Watched): boolean => {
    const had = w.watchers.size;
    for (const spec of w.specs) {
      if (w.watchers.has(spec.path) || !existsSync(spec.path)) continue;
      const watcher = watch(spec.path, { recursive: spec.recursive }, (_event, name) => {
        if (spec.accept !== undefined && (name === null || !spec.accept(name))) return;
        if (spec.changes === true && name !== null && !name.includes(".warden-tmp-")) w.changes.add(`.warden/${name}`);
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
  const scan = (w: Watched): Promise<void> => {
    if (w.scanning !== undefined) {
      w.again = true;
      return w.scanning;
    }
    w.scanning = (async () => {
      if (!existsSync(w.root)) {
        drop(w);
        return;
      }
      ensureWatchers(w);
      for (const file of w.changes) appendEvidence(w.project, { at: now(), kind: "change", trigger: "daemon", root: w.root, file });
      w.changes.clear();
      const found = await scanRoot(w);
      if (stopped) return;
      const current = new Map(found.map((d) => [key(d), d]));
      for (const [k, d] of current) {
        if (w.open.has(k)) continue;
        appendEvidence(w.project, { at: now(), kind: "tampered", trigger: "daemon", root: w.root, file: d.file, detail: d.detail, next: d.next });
        opts.onDetection?.(d);
      }
      w.open = current;
      (state.roots[w.root] ??= { open: [] }).open = [...current.values()];
      saveState();
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
  const drop = (w: Watched): void => {
    clearTimeout(w.timer);
    w.timer = undefined;
    for (const watcher of w.watchers.values()) watcher.close();
    projects.delete(w.root);
    delete state.roots[w.root];
    saveState();
    const next = [...projects.values()].find((x) => x.repo === w.repo);
    if (next !== undefined) schedule(next);
  };
  const watchRoot = (root: string): void => {
    if (projects.has(root)) return;
    const saved = state.roots[root]?.open ?? [];
    const w: Watched = { root, project: projectOf(root), repo: commonDir(root), specs: watchSpecs(root), open: new Map(saved.map((d) => [key(d), d])), watchers: new Map(), changes: new Set(), filesChanged: true, recordFound: [] };
    projects.set(root, w);
    void scan(w);
  };
  const worktreeRoots = (w: Watched): string[] => {
    try {
      return worktrees(w.root)
        .map((t) => t.path)
        .filter((p) => existsSync(join(p, ".warden/config.yaml")));
    } catch (cause) {
      report(cause);
      return [];
    }
  };
  const discover = (): void => {
    const remembered = Object.keys(state.roots).filter((r) => existsSync(join(r, ".warden/config.yaml")));
    for (const root of [...discoverRoots(), ...remembered, ...[...projects.values()].flatMap(worktreeRoots)]) {
      try {
        watchRoot(root);
      } catch (cause) {
        report(cause);
      }
    }
  };
  const heartbeat = (): Heartbeat => {
    const beat = { pid: process.pid, at: now(), startedAt, port: opts.port };
    writeAtomic(heartbeatFile(), `${JSON.stringify(beat)}\n`);
    return beat;
  };
  const tick = (): void => {
    try {
      heartbeat();
    } catch (cause) {
      report(cause);
    }
    for (const w of [...projects.values()]) {
      if (!existsSync(w.root)) {
        if (w.scanning === undefined) drop(w);
        continue;
      }
      try {
        if (ensureWatchers(w)) {
          w.filesChanged = true;
          schedule(w);
        }
      } catch (cause) {
        report(cause);
      }
    }
    discover();
  };
  const evidenceDir = join(wardenHome(), "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const evidenceWatcher = watch(evidenceDir, (_event, file) => {
    if (file === null || !file.endsWith(".jsonl") || file.endsWith(".1.jsonl")) return;
    const project = file.slice(0, -".jsonl".length);
    opts.onEvidence?.(project);
    for (const w of projects.values()) if (w.project === project) schedule(w);
  });
  tick();
  const interval = setInterval(tick, opts.intervalMs ?? HEARTBEAT_MS);
  return {
    projects,
    startedAt,
    heartbeat,
    discover,
    rescan: async () => {
      for (const w of projects.values()) w.filesChanged = true;
      await Promise.all([...projects.values()].map(scan));
      await Promise.all([...projects.values()].map(scan));
    },
    settled: async () => {
      while ([...projects.values()].some((w) => w.scanning !== undefined || w.timer !== undefined)) await new Promise((r) => setTimeout(r, 20));
    },
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      evidenceWatcher.close();
      for (const w of projects.values()) {
        clearTimeout(w.timer);
        w.timer = undefined;
        for (const watcher of w.watchers.values()) watcher.close();
      }
      await Promise.all([...projects.values()].map((w) => w.scanning));
      const beat = readHeartbeat();
      if (beat?.pid === process.pid && beat.port === opts.port) rmSync(heartbeatFile(), { force: true });
    },
  };
}
