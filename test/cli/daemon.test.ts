import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { type Served, serve } from "../../src/cli/daemon.js";
import { STALE_MS, heartbeatFile, heartbeatProblem } from "../../src/runner/daemon.js";
import { type Evidence, appendEvidence, readEvidence } from "../../src/runner/evidence.js";

const wardenRoot = resolve(import.meta.dirname, "../..");
const main = join(wardenRoot, "dist/src/cli/main.js");
const PROJECT = "proj";

let scratch: string;
let home: string;
let userHome: string;
let claude: string;
let root: string;
let served: Served | undefined;
const saved = { WARDEN_HOME: process.env.WARDEN_HOME, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, WARDEN_DAEMON: process.env.WARDEN_DAEMON };

const restore = (): void => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const commitUnhooked = (message: string): void => {
  git(root, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", message);
};

const warden = (cwd: string, env: Record<string, string | undefined>, ...args: string[]): { code: number | null; out: string; err: string } => {
  const r = spawnSync("node", [main, ...args], { cwd, encoding: "utf8", env: { ...process.env, WARDEN_HOME: home, HOME: userHome, CLAUDE_CONFIG_DIR: claude, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const until = async (what: string, test: () => boolean): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never became true: ${what}`);
};

const get = (path: string, host?: string): Promise<{ status: number; body: unknown }> =>
  new Promise((done, fail) => {
    request({ host: "127.0.0.1", port: served?.port, path, ...(host === undefined ? {} : { headers: { host } }) }, (res) => {
      let text = "";
      res.on("data", (c: Buffer) => (text += c.toString("utf8")));
      res.on("end", () => done({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    })
      .on("error", fail)
      .end();
  });

const tampered = (): Evidence[] => readEvidence(PROJECT).filter((e) => e.kind === "tampered" && e.trigger === "daemon");

const beat = (fields: Record<string, unknown>): Promise<void> =>
  mkdir(join(home, "daemon"), { recursive: true }).then(() => writeFile(heartbeatFile(), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), startedAt: "", port: 0, ...fields })));

const setPlugin = async (on: boolean, file = join(claude, "settings.json")): Promise<void> => {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify({ enabledPlugins: { "warden@warden": on } }));
};

beforeAll(() => {
  execFileSync("npx", ["tsc"], { cwd: wardenRoot, stdio: "ignore" });
});

beforeEach(async () => {
  scratch = realpathSync(await mkdtemp(join(tmpdir(), "warden-daemon-")));
  home = join(scratch, "warden-home");
  userHome = join(scratch, "home");
  claude = join(userHome, ".claude");
  root = join(scratch, PROJECT);
  await mkdir(userHome, { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  commitUnhooked("seed");
  expect(warden(root, {}, "init").code).toBe(0);
  git(root, "add", "-A");
  commitUnhooked("warden");
  process.env.WARDEN_HOME = home;
  process.env.HOME = userHome;
  process.env.CLAUDE_CONFIG_DIR = claude;
});

afterEach(async () => {
  await served?.close();
  served = undefined;
  restore();
  await rm(scratch, { recursive: true, force: true });
});

afterAll(restore);

const start = async (): Promise<Served> => {
  served = await serve(wardenRoot, 0, { intervalMs: 50, debounceMs: 20 });
  await served.daemon.settled();
  return served;
};

const stop = async (): Promise<void> => {
  await served?.close();
  served = undefined;
};

it("init records the root in Evidence, and the daemon watches every root found in Evidence", async () => {
  expect(readEvidence(PROJECT).filter((e) => e.kind === "registered")).toEqual([expect.objectContaining({ root })]);
  expect(existsSync(join(home, "projects.json"))).toBe(false);
  const other = join(scratch, "other");
  await mkdir(join(other, ".warden"), { recursive: true });
  git(scratch, "init", "-q", "-b", "main", other);
  await writeFile(join(other, ".warden/config.yaml"), 'project: "other"\n');
  appendEvidence("other", { at: new Date().toISOString(), kind: "cost", guardrail: "run", outcome: "ran", root: other });
  appendEvidence("gone", { at: new Date().toISOString(), kind: "cost", guardrail: "run", outcome: "ran", root: join(scratch, "missing") });
  const s = await start();
  expect([...s.daemon.projects.keys()].sort()).toEqual([other, root].sort());
});

it("binds 127.0.0.1, writes a heartbeat, removes only its own heartbeat on stop, and refuses a foreign Host", async () => {
  const s = await start();
  expect((s.server.address() as { address: string }).address).toBe("127.0.0.1");
  const first = JSON.parse(readFileSync(heartbeatFile(), "utf8")) as { pid: number; at: string; port: number };
  expect(first).toMatchObject({ pid: process.pid, port: s.port });
  await until("the heartbeat advances", () => (JSON.parse(readFileSync(heartbeatFile(), "utf8")) as { at: string }).at !== first.at);
  expect(await get("/api/health", "evil.example:80")).toEqual({ status: 403, body: { error: "Host evil.example:80 is not this daemon", next: `open http://127.0.0.1:${s.port}/ directly` } });
  expect((await get("/api/health", `localhost:${s.port}`)).status).toBe(200);
  await stop();
  expect(existsSync(heartbeatFile())).toBe(false);
  await start();
  await beat({ pid: 1, port: 9 });
  await stop();
  expect(existsSync(heartbeatFile())).toBe(true);
});

it("a fresh project gets no alert; a plugin that was enabled and then disabled is flagged with one next action", async () => {
  const s = await start();
  expect([...(s.daemon.projects.get(root)?.open.values() ?? [])]).toEqual([]);
  expect(tampered()).toEqual([]);
  await setPlugin(true);
  await until("the enabled plugin is recorded", () => readEvidence(PROJECT).some((e) => e.kind === "plugin" && e.status === "enabled"));
  const local = join(root, ".claude/settings.local.json");
  await setPlugin(false, local);
  await until("the disabled plugin is flagged", () => tampered().some((e) => e.detail === "plugin-disabled"));
  expect(tampered().find((e) => e.detail === "plugin-disabled")?.next).toBe(`set enabledPlugins "warden@warden" to true in ${local}`);
});

it("records hook and .warden changes as tamper Evidence once, with one next action", async () => {
  const s = await start();
  git(root, "config", "core.hooksPath", "elsewhere");
  await until("the hooksPath change is recorded", () => tampered().some((e) => e.detail === "hook-unwired"));
  expect(tampered().find((e) => e.detail === "hook-unwired")?.next).toBe("make elsewhere/pre-commit an executable script that runs .warden/generated/hooks/pre-commit and exits with its status");
  git(root, "config", "core.hooksPath", ".warden/generated/hooks");
  await writeFile(join(root, ".warden/generated/hooks/pre-commit"), "#!/bin/sh\nexit 0\n");
  await until("the hook edit is recorded", () => tampered().some((e) => e.detail === "generated-drift"));
  expect(tampered().find((e) => e.detail === "generated-drift")).toMatchObject({ file: ".warden/generated/hooks/pre-commit", root, next: "revert your change to .warden/generated/hooks/pre-commit" });
  expect(readEvidence(PROJECT).some((e) => e.kind === "change" && e.file === ".warden/generated/hooks/pre-commit")).toBe(true);
  await s.daemon.settled();
  expect(tampered().filter((e) => e.detail === "generated-drift")).toHaveLength(1);
  await rm(join(root, ".warden"), { recursive: true, force: true });
  await until("the removal is recorded", () => tampered().some((e) => e.detail === "removed"));
  expect(tampered().find((e) => e.detail === "removed")?.next).toBe(`run git checkout HEAD -- .warden in ${root}`);
});

it("records each commit and flags one that no passing commit-tier check stamped", async () => {
  await start();
  await writeFile(join(root, "src/b.ts"), "export const b = 2;\n");
  git(root, "add", "-A");
  commitUnhooked("skipped the hook");
  const skipped = git(root, "rev-parse", "HEAD").trim();
  await until("the unchecked commit is flagged", () => tampered().some((e) => e.detail === "unchecked-commit" && e.file === skipped));
  expect(readEvidence(PROJECT).find((e) => e.kind === "commit" && e.commit === skipped)).toMatchObject({ status: "unchecked", root });
  await writeFile(join(root, "src/c.ts"), "export const c = 3;\n");
  git(root, "add", "-A");
  expect(warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", "main").code).toBe(0);
  commitUnhooked("checked");
  const checked = git(root, "rev-parse", "HEAD").trim();
  await until("the checked commit is recorded", () => readEvidence(PROJECT).some((e) => e.kind === "commit" && e.commit === checked));
  expect(readEvidence(PROJECT).find((e) => e.kind === "commit" && e.commit === checked)?.status).toBe("checked");
  expect(tampered().filter((e) => e.detail === "unchecked-commit").map((e) => e.file)).toEqual([skipped]);
  await stop();
  await start();
  expect(tampered().filter((e) => e.detail === "unchecked-commit")).toHaveLength(1);
});

it("a commit-tier check refuses and records a missing, stale, future, dead, or malformed heartbeat", async () => {
  const check = (): { code: number | null; err: string } => warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", "main");
  const missing = check();
  expect(missing).toMatchObject({ code: 1, err: `Warden's daemon is not running: ${heartbeatFile()} is missing. Next action: start the daemon: warden daemon install\n` });
  await beat({ at: new Date(Date.now() - STALE_MS - 5000).toISOString() });
  expect(check()).toMatchObject({ code: 1, err: expect.stringMatching(/heartbeat is 3\d s old; it is stale after 30 s\. Next action: start the daemon: warden daemon install\n$/) });
  await beat({ at: "2099-01-01T00:00:00Z" });
  expect(check()).toMatchObject({ code: 1, err: expect.stringContaining("in the future, so the daemon did not write it. Next action: start the daemon") });
  const dead = spawnSync("true").pid as number;
  await beat({ pid: dead });
  expect(check()).toMatchObject({ code: 1, err: expect.stringContaining(`names process ${dead}, which is not running. Next action: start the daemon`) });
  await mkdir(join(home, "daemon"), { recursive: true });
  await writeFile(heartbeatFile(), "null");
  expect(check()).toMatchObject({ code: 1, err: `${heartbeatFile()} does not hold a heartbeat. Next action: start the daemon: warden daemon install\n` });
  expect(readEvidence(PROJECT).filter((e) => e.outcome === "refused").map((e) => [e.exit, e.next])).toEqual(Array(5).fill([1, "start the daemon: warden daemon install"]));
  await beat({});
  expect(check().code).toBe(0);
  expect(warden(root, { WARDEN_DAEMON: undefined }, "check", "--tier", "edit", "--base", "main").code).toBe(0);
});

it("heartbeatProblem accepts only a fresh, live heartbeat", async () => {
  expect(heartbeatProblem()).toContain("Next action: start the daemon: warden daemon install");
  await beat({});
  expect(heartbeatProblem()).toBeUndefined();
  expect(heartbeatProblem(Date.now() + STALE_MS + 1000)).toContain("stale after 30 s");
  expect(heartbeatProblem(Date.now() - 60_000)).toContain("in the future");
  await writeFile(heartbeatFile(), "42");
  expect(heartbeatProblem()).toContain("does not hold a heartbeat");
});

it("WARDEN_DAEMON=off skips the gate but records it, and the daemon raises it until a gated check runs", async () => {
  expect(warden(root, { WARDEN_DAEMON: "off" }, "check", "--base", "main").code).toBe(0);
  expect(readEvidence(PROJECT).filter((e) => e.kind === "gate-off")).toEqual([expect.objectContaining({ root, tier: "commit", base: "main" })]);
  const s = await start();
  const alert = tampered().find((e) => e.detail === "gate-off");
  expect(alert?.next).toBe(`unset WARDEN_DAEMON, then run warden check --base main in ${root} with the daemon running`);
  expect(warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", "main").code).toBe(0);
  await until("the gated check closes the alert", () => [...(s.daemon.projects.get(root)?.open.values() ?? [])].every((d) => d.detail !== "gate-off"));
  expect(warden(root, { WARDEN_DAEMON: "off" }, "check", "--tier", "edit", "--base", "main").code).toBe(0);
  expect(readEvidence(PROJECT).filter((e) => e.kind === "gate-off")).toHaveLength(1);
});

it("doctor notes a plugin that was never installed, with the marketplace step first, without failing", () => {
  const r = warden(root, {}, "doctor");
  expect(r.code).toBe(0);
  expect(r.out).toContain("note  Claude plugin warden@warden is not installed, so Claude Code edits are not checked; to check them, run claude plugin marketplace add RyanAmundson/warden, then claude plugin install warden@warden\n");
});

it("serves every API route from the existing readers", async () => {
  await setPlugin(true);
  expect(warden(root, {}, "check", "--base", "main", "src/a.ts").code).toBe(0);
  await start();
  const health = (await get("/api/health")) as { status: number; body: Record<string, unknown> };
  expect(health.status).toBe(200);
  expect(health.body).toMatchObject({ status: "ok", pid: process.pid, staleAfterMs: STALE_MS, projects: 1, port: served?.port });
  const projects = (await get("/api/projects")).body as { projects: { project: string; roots: string[]; lastRun: Evidence; openAlerts: number }[] };
  expect(projects.projects).toHaveLength(1);
  expect(projects.projects[0]).toMatchObject({ project: PROJECT, roots: [root], lastRun: { outcome: "ran", result: "pass", root } });
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
  expect(determinism.projects).toEqual([expect.objectContaining({ project: PROJECT, counts: { deterministic: 0, judgment: 0, prose: 0, unknown: 0 } })]);
  const tamper = (await get("/api/tamper")).body as { open: { detail: string }[]; recent: Evidence[] };
  expect(tamper.open.map((d) => d.detail)).toEqual(["gate-off"]);
  expect(await get("/api/runs")).toEqual({ status: 400, body: { error: "/api/runs needs ?project=<name>", next: "add ?project= with a name from GET /api/projects" } });
  expect(await get("/api/runs?project=nope")).toEqual({ status: 404, body: { error: "the daemon watches no project named nope", next: "pick a project name from GET /api/projects" } });
  expect((await get("/api/nope")).status).toBe(404);
});

it("streams tamper and evidence events over server-sent events", async () => {
  await start();
  const chunks: string[] = [];
  const req = request({ host: "127.0.0.1", port: served?.port, path: "/api/events" }, (res) => {
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
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
  expect(warden(root, env, "daemon", "install", "--port", "7555").code).toBe(0);
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
