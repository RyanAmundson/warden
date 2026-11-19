import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { type Served, serve } from "../../src/cli/daemon.js";
import { STALE_MS, heartbeatFile, heartbeatProblem, registeredRoots } from "../../src/runner/daemon.js";
import { type Evidence, appendEvidence, readEvidence } from "../../src/runner/evidence.js";

const wardenRoot = resolve(import.meta.dirname, "../..");
const main = join(wardenRoot, "dist/src/cli/main.js");

let scratch: string;
let home: string;
let userHome: string;
let root: string;
let served: Served | undefined;
const saved = { WARDEN_HOME: process.env.WARDEN_HOME, HOME: process.env.HOME };

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const warden = (cwd: string, env: Record<string, string | undefined>, ...args: string[]): { code: number | null; out: string; err: string } => {
  const r = spawnSync("node", [main, ...args], { cwd, encoding: "utf8", env: { ...process.env, WARDEN_HOME: home, HOME: userHome, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const until = async (what: string, test: () => boolean): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never became true: ${what}`);
};

const get = (path: string): Promise<{ status: number; body: unknown }> =>
  new Promise((done, fail) => {
    request({ host: "127.0.0.1", port: served?.port, path }, (res) => {
      let text = "";
      res.on("data", (c: Buffer) => (text += c.toString("utf8")));
      res.on("end", () => done({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    })
      .on("error", fail)
      .end();
  });

const tampered = (project: string): Evidence[] => readEvidence(project).filter((e) => e.kind === "tampered" && e.trigger === "daemon");

beforeAll(() => {
  execFileSync("npx", ["tsc"], { cwd: wardenRoot, stdio: "ignore" });
});

beforeEach(async () => {
  scratch = realpathSync(await mkdtemp(join(tmpdir(), "warden-daemon-")));
  home = join(scratch, "warden-home");
  userHome = join(scratch, "home");
  root = join(scratch, "proj");
  await mkdir(userHome, { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "seed");
  expect(warden(root, {}, "init").code).toBe(0);
  git(root, "add", "-A");
  git(root, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "warden");
  process.env.WARDEN_HOME = home;
  process.env.HOME = userHome;
});

afterEach(async () => {
  await served?.close();
  served = undefined;
  process.env.WARDEN_HOME = saved.WARDEN_HOME;
  process.env.HOME = saved.HOME;
  await rm(scratch, { recursive: true, force: true });
});

afterAll(() => {
  process.env.WARDEN_HOME = saved.WARDEN_HOME;
  process.env.HOME = saved.HOME;
});

const start = async (): Promise<Served> => {
  served = await serve(wardenRoot, 0, { intervalMs: 50, debounceMs: 20 });
  await served.daemon.settled();
  return served;
};

const enablePlugin = (): Promise<void> => mkdir(join(userHome, ".claude"), { recursive: true }).then(() => writeFile(join(userHome, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "warden@warden": true } })));

it("init registers the project, and the daemon watches registered projects and roots found in Evidence", async () => {
  expect(registeredRoots()).toEqual([root]);
  const other = join(scratch, "other");
  await mkdir(join(other, ".warden"), { recursive: true });
  git(scratch, "init", "-q", "-b", "main", other);
  await writeFile(join(other, ".warden/config.yaml"), 'project: "other"\n');
  appendEvidence("other", { at: new Date().toISOString(), kind: "cost", guardrail: "run", outcome: "ran", root: other });
  appendEvidence("gone", { at: new Date().toISOString(), kind: "cost", guardrail: "run", outcome: "ran", root: join(scratch, "missing") });
  const s = await start();
  expect([...s.daemon.projects.keys()].sort()).toEqual([other, root].sort());
});

it("binds 127.0.0.1 only, writes a heartbeat, and removes it on stop", async () => {
  const s = await start();
  expect((s.server.address() as { address: string }).address).toBe("127.0.0.1");
  const beat = JSON.parse(readFileSync(heartbeatFile(), "utf8")) as { pid: number; at: string; port: number };
  expect(beat).toMatchObject({ pid: process.pid, port: s.port });
  const first = beat.at;
  await until("the heartbeat advances", () => (JSON.parse(readFileSync(heartbeatFile(), "utf8")) as { at: string }).at !== first);
  await s.close();
  served = undefined;
  expect(existsSync(heartbeatFile())).toBe(false);
});

it("records each tamper detection once as Evidence with one next action", async () => {
  await start();
  const project = "proj";
  expect(tampered(project).map((e) => [e.detail, e.next])).toEqual([["plugin-missing", "run claude plugin install warden@warden"]]);
  await served?.close();
  served = undefined;
  await enablePlugin();
  const s = await start();
  expect(s.daemon.projects.get(root)?.open.size).toBe(0);
  git(root, "config", "core.hooksPath", "elsewhere");
  await until("the hooksPath change is recorded", () => tampered(project).some((e) => e.detail === "hook-unwired"));
  expect(tampered(project).find((e) => e.detail === "hook-unwired")?.next).toBe("make elsewhere/pre-commit an executable script that runs .warden/generated/hooks/pre-commit and exits with its status");
  git(root, "config", "core.hooksPath", ".warden/generated/hooks");
  await writeFile(join(root, ".warden/generated/hooks/pre-commit"), "#!/bin/sh\nexit 0\n");
  await until("the hook edit is recorded", () => tampered(project).some((e) => e.detail === "generated-drift"));
  const drift = tampered(project).find((e) => e.detail === "generated-drift") as Evidence;
  expect(drift).toMatchObject({ file: ".warden/generated/hooks/pre-commit", root, next: "revert your change to .warden/generated/hooks/pre-commit" });
  await s.daemon.settled();
  expect(tampered(project).filter((e) => e.detail === "generated-drift")).toHaveLength(1);
  for (const e of tampered(project)) expect(e.next?.includes("Next action")).toBe(false);
});

it("a commit-tier check fails with exit 1 and one next action when the heartbeat is missing or stale", async () => {
  const missing = warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", "main");
  expect(missing.code).toBe(1);
  expect(missing.err).toBe(`Warden's daemon is not running: ${heartbeatFile()} is missing. Next action: start the daemon: warden daemon install\n`);
  await mkdir(join(home, "daemon"), { recursive: true });
  await writeFile(heartbeatFile(), JSON.stringify({ pid: 1, at: new Date(Date.now() - STALE_MS - 5000).toISOString(), startedAt: "", port: 0 }));
  const stale = warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", "main");
  expect(stale.code).toBe(1);
  expect(stale.err).toMatch(/^Warden's daemon heartbeat is 3\d s old; it is stale after 30 s\. Next action: start the daemon: warden daemon install\n$/);
  expect(warden(root, { WARDEN_DAEMON: "off" }, "check", "--base", "main").code).toBe(0);
  await writeFile(heartbeatFile(), JSON.stringify({ pid: 1, at: new Date().toISOString(), startedAt: "", port: 0 }));
  expect(warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", "main").code).toBe(0);
  expect(warden(root, { WARDEN_DAEMON: undefined }, "check", "--tier", "edit", "--base", "main").code).toBe(0);
});

it("heartbeatProblem is silent only when the heartbeat is fresh or WARDEN_DAEMON=off", async () => {
  const before = process.env.WARDEN_DAEMON;
  delete process.env.WARDEN_DAEMON;
  try {
    expect(heartbeatProblem()).toContain("Next action: start the daemon: warden daemon install");
    await mkdir(join(home, "daemon"), { recursive: true });
    await writeFile(heartbeatFile(), JSON.stringify({ pid: 1, at: new Date().toISOString(), startedAt: "", port: 0 }));
    expect(heartbeatProblem()).toBeUndefined();
    expect(heartbeatProblem(Date.now() + STALE_MS + 1000)).toContain("stale after 30 s");
    process.env.WARDEN_DAEMON = "off";
    expect(heartbeatProblem(Date.now() + STALE_MS + 1000)).toBeUndefined();
  } finally {
    process.env.WARDEN_DAEMON = before;
  }
});

it("serves every API route from the existing readers", async () => {
  await enablePlugin();
  expect(warden(root, {}, "check", "--base", "main", "src/a.ts").code).toBe(0);
  await start();
  const health = (await get("/api/health")) as { status: number; body: Record<string, unknown> };
  expect(health.status).toBe(200);
  expect(health.body).toMatchObject({ status: "ok", pid: process.pid, staleAfterMs: STALE_MS, projects: 1, openAlerts: 0, port: served?.port });
  const projects = (await get("/api/projects")).body as { projects: { project: string; roots: string[]; lastRun: Evidence; openAlerts: number }[] };
  expect(projects.projects).toHaveLength(1);
  expect(projects.projects[0]).toMatchObject({ project: "proj", roots: [root], openAlerts: 0, lastRun: { outcome: "ran", result: "pass", root } });
  const runs = (await get("/api/runs?project=proj&limit=5")).body as { runs: Evidence[] };
  expect(runs.runs.map((r) => r.trigger)).toEqual(["manual"]);
  const layers = (await get("/api/layers?project=proj")).body as { bands: { band: string; kinds: { kind: string; rules: { guardrail: string }[] }[] }[]; packs: { id: string }[] };
  expect(layers.bands.map((b) => b.band)).toEqual(["deterministic", "judgment", "prose"]);
  expect(layers.bands[0]?.kinds.flatMap((k) => k.rules).length).toBeGreaterThan(0);
  expect(layers.packs.map((p) => p.id)).toContain("core");
  const violations = (await get("/api/violations?project=proj")).body as { packs: { pack: string; baselined: number; guardrails: unknown[] }[] };
  expect(violations.packs[0]).toMatchObject({ pack: "core", baselined: 0 });
  expect(violations.packs[0]?.guardrails.length).toBeGreaterThan(0);
  const determinism = (await get("/api/determinism")).body as { projects: { project: string; counts: Record<string, number> }[] };
  expect(determinism.projects).toEqual([expect.objectContaining({ project: "proj", counts: { deterministic: 0, judgment: 0, prose: 0, unknown: 0 } })]);
  expect((await get("/api/tamper")).body).toEqual({ open: [], recent: [] });
  expect(await get("/api/runs")).toEqual({ status: 400, body: { error: "/api/runs needs ?project=<name>", next: "add ?project= with a name from GET /api/projects" } });
  expect(await get("/api/runs?project=nope")).toEqual({ status: 404, body: { error: "the daemon watches no project named nope", next: "pick a project name from GET /api/projects" } });
  expect((await get("/api/nope")).status).toBe(404);
});

it("streams tamper and evidence events over server-sent events", async () => {
  await enablePlugin();
  await start();
  const chunks: string[] = [];
  const req = request({ host: "127.0.0.1", port: served?.port, path: "/api/events" }, (res) => {
    expect(res.headers["content-type"]).toBe("text/event-stream");
    res.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  });
  req.end();
  try {
    await until("the stream opens", () => chunks.join("").includes("retry:"));
    git(root, "config", "core.hooksPath", "elsewhere");
    await until("a tamper event arrives", () => chunks.join("").includes("event: tamper"));
    await until("an evidence event arrives", () => chunks.join("").includes('event: evidence\ndata: {"project":"proj"}'));
    expect(chunks.join("")).toContain('"detail":"hook-unwired"');
  } finally {
    req.destroy();
  }
});

it("install writes the launchd plist under HOME and bootstraps it; uninstall removes it", async () => {
  const bin = join(scratch, "bin");
  const calls = join(scratch, "launchctl.log");
  await mkdir(bin);
  await writeFile(join(bin, "launchctl"), `#!/bin/sh\necho "$@" >> '${calls}'\n[ "$1" = print ] && exit 113\nexit 0\n`);
  await chmod(join(bin, "launchctl"), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };
  const plist = join(userHome, "Library/LaunchAgents/warden.daemon.plist");
  const installed = warden(root, env, "daemon", "install", "--port", "7555");
  expect(installed.code).toBe(0);
  const text = readFileSync(plist, "utf8");
  expect(text).toContain("<string>daemon</string>");
  expect(text).toContain("<string>7555</string>");
  expect(text).toContain(`<key>WARDEN_HOME</key><string>${home}</string>`);
  const uid = String(process.getuid?.());
  expect(readFileSync(calls, "utf8")).toBe(`print gui/${uid}/warden.daemon\nbootstrap gui/${uid} ${plist}\n`);
  expect(warden(root, env, "daemon", "uninstall").code).toBe(0);
  expect(existsSync(plist)).toBe(false);
  await writeFile(join(bin, "launchctl"), `#!/bin/sh\necho "boom" >&2\nexit 5\n`);
  const failed = warden(root, env, "daemon", "install");
  expect(failed.code).toBe(2);
  expect(failed.err).toContain(`Next action: run launchctl bootstrap gui/${uid} ${plist} and fix the error it prints`);
});
