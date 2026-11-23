import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { type Served, serve } from "../../src/cli/daemon.js";
import { STALE_MS, heartbeatFile, heartbeatProblem, openAlerts, stateFile } from "../../src/runner/daemon.js";
import { FIRST_STAMPING } from "../../src/compiler/lock.js";
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
const saved = { WARDEN_HOME: process.env.WARDEN_HOME, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, WARDEN_DAEMON: process.env.WARDEN_DAEMON, TMPDIR: process.env.TMPDIR };

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

const start = async (port = 0): Promise<Served> => {
  served = await serve(wardenRoot, port, { intervalMs: 200, debounceMs: 20 });
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
  const broken = join(scratch, "broken");
  await mkdir(join(broken, ".warden"), { recursive: true });
  await writeFile(join(broken, ".warden/config.yaml"), 'project: "broken"\n');
  appendEvidence("broken", { at: new Date().toISOString(), kind: "cost", guardrail: "run", outcome: "ran", root: broken });
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
  served = await serve(wardenRoot, 0, { intervalMs: 60_000, debounceMs: 20 });
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
  await until("the hook edit is recorded as a change", () => readEvidence(PROJECT).some((e) => e.kind === "change" && e.file === ".warden/generated/hooks/pre-commit"));
  await s.daemon.rescan();
  expect(tampered().filter((e) => e.detail === "generated-drift")).toHaveLength(1);
  await rm(join(root, ".warden"), { recursive: true, force: true });
  await until("the removal is recorded", () => tampered().some((e) => e.detail === "removed"));
  expect(tampered().find((e) => e.detail === "removed")?.next).toBe(`run git checkout HEAD -- .warden in ${root}`);
});

const openOf = (s: Served): { detail: string; file: string }[] => [...s.daemon.projects.values()].flatMap((w) => [...w.open.values()]);

const unchecked = (s: Served): string[] => openOf(s).filter((d) => d.detail === "unchecked-commit").map((d) => d.file);

it("records each commit, flags one that no full check stamped, and closes the alert only when its own next action runs", async () => {
  const s = await start();
  await writeFile(join(root, "src/b.ts"), "export const b = 2;\n");
  git(root, "add", "-A");
  commitUnhooked("skipped the hook");
  const skipped = git(root, "rev-parse", "HEAD").trim();
  await until("the unchecked commit is flagged", () => unchecked(s).includes(skipped));
  expect(readEvidence(PROJECT).find((e) => e.kind === "commit" && e.commit === skipped)).toMatchObject({ status: "unchecked", root });
  const alert = tampered().find((e) => e.file === skipped);
  const short = skipped.slice(0, 12);
  expect(alert?.next).toContain(`in a checkout of commit ${short} with nothing staged, run warden check --base ${short}^`);
  expect(alert?.next).toContain(`If the check finds a Guardrail violation, ask the repository owner to save the intended changes separately and remove ${short} from every ref and worktree that reaches it. After the daemon clears the alert, restore the intended changes, fix the findings, and commit through the hook`);
  const empty = warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", "main");
  expect(empty).toMatchObject({ code: 1, err: expect.stringContaining(`unchecked-commit ${skipped}`) });
  await s.daemon.rescan();
  expect(unchecked(s)).toEqual([skipped]);
  expect(warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", `${skipped.slice(0, 12)}^`).code).toBe(0);
  await until("the commit's own check closes the alert", () => unchecked(s).length === 0);
});

it("clears the old alert before the owner commits a corrected change", async () => {
  delete process.env.WARDEN_DAEMON;
  const s = await start();
  const file = "src/counter.ts";
  await writeFile(join(root, file), "// Counter used by the example.\nexport const counter = 1;\n");
  git(root, "add", file);
  commitUnhooked("counter before review");
  const original = git(root, "rev-parse", "HEAD").trim();
  await until("the original commit is flagged", () => unchecked(s).includes(original));
  const check = warden(root, {}, "check", "--base", `${original}^`);
  expect(check.code).toBe(1);
  expect(check.out + check.err).toContain("no-comments");

  git(root, "reset", "--mixed", "HEAD^");
  await s.daemon.rescan();
  expect(unchecked(s)).toEqual([]);

  await writeFile(join(root, file), "export const counter = 1;\n");
  git(root, "add", file);
  const result = await hooked("commit", "-m", "correct the counter");
  expect(result.status, result.out).toBe(0);
  const corrected = git(root, "rev-parse", "HEAD").trim();
  await until("the corrected commit is checked", () => readEvidence(PROJECT).some((e) => e.kind === "commit" && e.commit === corrected && e.status === "checked"));
  expect(unchecked(s)).toEqual([]);
});

it("a commit after a passing full check is recorded as checked", async () => {
  const s = await start();
  await writeFile(join(root, "src/c.ts"), "export const c = 3;\n");
  git(root, "add", "-A");
  expect(warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", "main").code).toBe(0);
  commitUnhooked("checked");
  const checked = git(root, "rev-parse", "HEAD").trim();
  await until("the checked commit is recorded", () => readEvidence(PROJECT).some((e) => e.kind === "commit" && e.commit === checked));
  expect(readEvidence(PROJECT).find((e) => e.kind === "commit" && e.commit === checked)?.status).toBe("checked");
  await s.daemon.rescan();
  expect(unchecked(s)).toEqual([]);
});

it("a path-limited check does not stamp a commit whose other staged files were never checked", async () => {
  const s = await start();
  await writeFile(join(root, "src/bad.ts"), "// a comment\nexport const bad = 1;\n");
  git(root, "add", "-A");
  expect(warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", "main").code).toBe(1);
  expect(warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", "main", "src/a.ts").code).toBe(0);
  expect(readEvidence(PROJECT).filter((e) => e.guardrail === "run" && e.tier === "commit").map((e) => e.scope)).toEqual(["full", "partial"]);
  commitUnhooked("bypass");
  const bypass = git(root, "rev-parse", "HEAD").trim();
  await until("the bypass is flagged", () => unchecked(s).includes(bypass));
});

it("flags unchecked commits from another worktree and from a fast-forward of a commit made with plumbing", async () => {
  const s = await start();
  const wt = join(scratch, "wt");
  git(root, "worktree", "add", "-q", wt, "-b", "side");
  await writeFile(join(wt, "src/w.ts"), "export const w = 1;\n");
  git(wt, "add", "-A");
  git(wt, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "in a worktree");
  const inWorktree = git(wt, "rev-parse", "HEAD").trim();
  await until("the worktree commit is flagged", () => unchecked(s).includes(inWorktree));
  await until("the worktree is watched", () => s.daemon.projects.has(wt));
  await writeFile(join(root, "src/p.ts"), "export const p = 1;\n");
  git(root, "add", "src/p.ts");
  const tree = git(root, "write-tree").trim();
  git(root, "rm", "-q", "--cached", "src/p.ts");
  await rm(join(root, "src/p.ts"));
  const plumbed = git(root, "commit-tree", tree, "-p", "HEAD", "-m", "plumbing").trim();
  git(root, "merge", "-q", "--ff-only", plumbed);
  await until("the fast-forwarded commit is flagged", () => unchecked(s).includes(plumbed));
});

it("a working-copy drift in one worktree refuses commits only there, and a hook problem refuses every worktree", async () => {
  const wt = join(scratch, "wt");
  git(root, "worktree", "add", "-q", wt, "-b", "side");
  const s = await start();
  await until("the worktree is watched", () => s.daemon.projects.has(wt));
  await s.daemon.settled();
  await writeFile(join(root, ".warden/generated/hooks/pre-commit"), "#!/bin/sh\nexit 0\n");
  await until("the drift is open in its own root", () => openAlerts(root).some((d) => d.detail === "generated-drift"));
  expect(openAlerts(wt)).toEqual([]);
  expect(warden(wt, { WARDEN_DAEMON: undefined }, "check", "--base", "main").code).toBe(0);
  const own = warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", "main");
  expect(own.code).not.toBe(0);
  git(root, "config", "core.hooksPath", "elsewhere");
  await until("the hook problem is open", () => openAlerts(wt).some((d) => d.detail === "hook-unwired") && openAlerts(root).some((d) => d.detail === "hook-unwired"));
  const refused = warden(wt, { WARDEN_DAEMON: undefined }, "check", "--base", "main");
  expect(refused.code).not.toBe(0);
  expect(readEvidence(PROJECT).filter((e) => e.kind === "cost" && e.guardrail === "run" && e.root === wt).at(-1)).toMatchObject({ exit: refused.code, alert: "hook-unwired" });
});

it("a stored hook problem applies to every worktree of the repository, and a stored drift only to its own root", async () => {
  const wt = join(scratch, "wt");
  git(root, "worktree", "add", "-q", wt, "-b", "side");
  await mkdir(join(home, "daemon"), { recursive: true });
  const hook = { project: PROJECT, root, repo: realpathSync(join(root, ".git")), file: ".warden/generated/hooks/pre-commit", detail: "hook-unwired", next: "run git config core.hooksPath .warden/generated/hooks" };
  const drift = { ...hook, detail: "generated-drift", next: "revert your change to .warden/generated/hooks/pre-commit" };
  const history = { ...hook, file: "git history", detail: "scan-error", next: "fix what this error names" };
  const records = { ...hook, file: ".warden", detail: "scan-error", next: "fix what this error names" };
  await writeFile(stateFile(), JSON.stringify({ roots: { [root]: { open: [hook, drift, history, records] } }, repos: {} }));
  expect(openAlerts(wt).map((d) => [d.detail, d.file])).toEqual([["hook-unwired", hook.file], ["scan-error", "git history"]]);
  expect(openAlerts(root)).toHaveLength(4);
});

it("watches a worktree under the temporary directory, and skips only the self-check's marked worktree", async () => {
  process.env.TMPDIR = join(scratch, "tmp");
  const prev = join(scratch, "tmp/warden-self-check.x/prev");
  const other = join(scratch, "tmp/agent");
  git(root, "worktree", "add", "-q", "--no-checkout", "--detach", prev, "HEAD");
  await writeFile(join(prev, ".warden-self-check"), "");
  git(prev, "reset", "-q", "--hard");
  git(root, "worktree", "add", "-q", other, "-b", "side");
  const s = await start();
  await until("the unmarked worktree is watched", () => s.daemon.projects.has(other));
  s.daemon.discover();
  await s.daemon.settled();
  expect(s.daemon.projects.has(prev)).toBe(false);
  expect(Object.keys(JSON.parse(readFileSync(stateFile(), "utf8")).roots)).not.toContain(prev);
});

it("keeps its checkpoint across a restart past 1 MB of Evidence, and without a checkpoint seeds one from the current tips", async () => {
  await start();
  await stop();
  await writeFile(join(root, "src/d.ts"), "export const d = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("while the daemon was down");
  const down = git(root, "rev-parse", "HEAD").trim();
  const pad = "x".repeat(480);
  for (let i = 0; i < 2300; i++) appendEvidence(PROJECT, { at: new Date().toISOString(), kind: "cost", guardrail: "run", tier: "edit", outcome: "ran", result: "pass", root, detail: pad });
  expect(readFileSync(join(home, "evidence", `${PROJECT}.jsonl`)).length).toBeGreaterThan(1_100_000);
  let s = await start();
  expect(unchecked(s)).toEqual([down]);
  await stop();
  await rm(stateFile());
  s = await start();
  expect(unchecked(s)).toEqual([down]);
  await stop();
  await rm(stateFile());
  await writeFile(join(root, "src/u.ts"), "export const u = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("before any checkpoint");
  const unseen = git(root, "rev-parse", "HEAD").trim();
  s = await start();
  expect(unchecked(s)).toEqual([down]);
  expect(Object.values(JSON.parse(readFileSync(stateFile(), "utf8")).repos as Record<string, { tips: string[] }>).map((r) => r.tips)).toEqual([[unseen]]);
  await writeFile(join(root, "src/e.ts"), "export const e = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("after the seed");
  const after = git(root, "rev-parse", "HEAD").trim();
  await until("a commit after the seed is flagged", () => unchecked(s).includes(after));
  expect(unchecked(s).sort()).toEqual([down, after].sort());
});

const treeWith = async (file: string): Promise<string> => {
  await writeFile(join(root, file), "export const o = 1;\n");
  git(root, "add", file);
  const tree = git(root, "write-tree").trim();
  git(root, "rm", "-q", "--cached", file);
  await rm(join(root, file));
  return tree;
};

const lockedBy = async (version: string): Promise<void> => {
  const file = join(root, ".warden/lock.json");
  await writeFile(file, readFileSync(file, "utf8").replace(/"warden": "[^"]+"/, `"warden": "${version}"`));
  git(root, "add", "-A");
};

const running = (JSON.parse(readFileSync(join(wardenRoot, "package.json"), "utf8")) as { version: string }).version;
const why = `its .warden/lock.json is missing, unreadable, older than Warden ${FIRST_STAMPING}, or newer than this daemon's Warden ${running}, so no release can stamp it`;

const unstampable = (sha: string, holders: string[]): string => `remove commit ${sha.slice(0, 12)} from ${holders.join(", ")} by resetting or deleting each, because ${why}; then make its change again in a new commit with the hook`;

it("flags a merge whose first parent predates Warden", async () => {
  const s = await start();
  const seed = git(root, "rev-list", "--max-parents=0", "HEAD").trim();
  const merge = git(root, "commit-tree", await treeWith("src/m.ts"), "-p", seed, "-p", "HEAD", "-m", "merge onto a pre-Warden parent").trim();
  git(root, "update-ref", "refs/heads/main", merge);
  git(root, "reset", "-q", "--hard");
  await until("the merge is flagged", () => unchecked(s).includes(merge));
  expect(readEvidence(PROJECT).find((e) => e.kind === "commit" && e.commit === merge)?.status).toBe("unchecked");
});

it("exempts a commit that any ref held when the daemon first saw the repository, even after that ref is gone", async () => {
  git(root, "switch", "-q", "-c", "early");
  await writeFile(join(root, "src/early.ts"), "export const early = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("before the daemon");
  const early = git(root, "rev-parse", "HEAD").trim();
  git(root, "update-ref", "refs/wip/early", early);
  git(root, "switch", "-q", "main");
  git(root, "branch", "-q", "-D", "early");
  const s = await start();
  git(root, "merge", "-q", "--ff-only", early);
  git(root, "update-ref", "-d", "refs/wip/early");
  await until("the commit is recorded", () => readEvidence(PROJECT).some((e) => e.kind === "commit" && e.commit === early));
  expect(readEvidence(PROJECT).find((e) => e.kind === "commit" && e.commit === early)?.status).toBe("in-boundary");
  expect(unchecked(s)).toEqual([]);
});

const downgrade = async (): Promise<string> => {
  await lockedBy("0.1.10");
  commitUnhooked("downgraded lock");
  return git(root, "rev-parse", "HEAD").trim();
};

const soleHolder = async (hold: (sha: string) => string, release: () => void): Promise<void> => {
  const s = await start();
  const down = await downgrade();
  await until("the downgrade is flagged", () => unchecked(s).includes(down));
  const holder = hold(down);
  git(root, "reset", "-q", "--hard", "HEAD^");
  await s.daemon.rescan();
  expect(openAlerts(root).find((d) => d.file === down)?.next).toBe(unstampable(down, [holder]));
  release();
  await s.daemon.rescan();
  expect(unchecked(s)).not.toContain(down);
};

it("flags a commit that downgrades its lock, names its branch, and closes once the branch drops it", async () => {
  const s = await start();
  const down = await downgrade();
  await until("the downgrade is flagged", () => unchecked(s).includes(down));
  expect(openAlerts(root).find((d) => d.file === down)?.next).toBe(unstampable(down, ["refs/heads/main"]));
  git(root, "reset", "-q", "--hard", "HEAD^");
  await until("removing the commit closes the alert", () => !unchecked(s).includes(down));
});

it("names a tag that holds an unstampable commit, and closes once the tag is deleted", async () => {
  await soleHolder(
    (sha) => {
      git(root, "tag", "kept", sha);
      return "refs/tags/kept";
    },
    () => git(root, "tag", "-d", "kept"),
  );
});

it("names a stash that holds an unstampable commit, and closes once the stash is dropped", async () => {
  await soleHolder(
    (sha) => {
      writeFileSync(join(root, "src/stashed.ts"), `export const stashed = "${sha}";\n`);
      git(root, "stash", "-q", "--include-untracked");
      return "refs/stash";
    },
    () => git(root, "stash", "drop", "-q"),
  );
});

it("names a detached worktree that holds an unstampable commit, and closes once it is removed", async () => {
  const detached = join(scratch, "detached");
  await soleHolder(
    (sha) => {
      git(root, "worktree", "add", "-q", "--detach", detached, sha);
      return `the detached HEAD of worktree ${detached}`;
    },
    () => git(root, "worktree", "remove", "--force", detached),
  );
});

it("a malformed lock in history stays flagged in every worktree and never stops the history scan", async () => {
  const wt = join(scratch, "wt");
  git(root, "worktree", "add", "-q", wt, "-b", "side");
  const s = await start();
  await until("the worktree is watched", () => s.daemon.projects.has(wt));
  await writeFile(join(root, ".warden/lock.json"), "{");
  git(root, "add", "-A");
  commitUnhooked("malformed lock");
  const bad = git(root, "rev-parse", "HEAD").trim();
  await until("the malformed commit is flagged", () => openAlerts(wt).some((d) => d.file === bad));
  expect(openAlerts(wt).find((d) => d.file === bad)?.next).toBe(unstampable(bad, ["refs/heads/main"]));
  expect(openOf(s).filter((d) => d.detail === "scan-error" && d.file === "git history")).toEqual([]);
  git(root, "reset", "-q", "--hard", "HEAD^");
  await until("removing the commit closes the alert in every worktree", () => !openAlerts(wt).some((d) => d.file === bad));
});

it("clears a commit recorded as unchecked only when the owner lists it as trusted in the daemon's state", async () => {
  let s = await start();
  await writeFile(join(root, "src/t.ts"), "export const t = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("reviewed elsewhere");
  const reviewed = git(root, "rev-parse", "HEAD").trim();
  await until("the commit is flagged", () => unchecked(s).includes(reviewed));
  await stop();
  const repo = realpathSync(join(root, ".git"));
  const saved = JSON.parse(readFileSync(stateFile(), "utf8")) as { repos: Record<string, Record<string, unknown>> };
  await writeFile(stateFile(), JSON.stringify(saved));
  s = await start();
  expect(unchecked(s)).toEqual([reviewed]);
  await stop();
  const entry = { commit: reviewed, reason: "independent review PASS", at: new Date().toISOString() };
  (saved.repos[repo] as Record<string, unknown>).trusted = [entry];
  await writeFile(stateFile(), JSON.stringify(saved));
  s = await start();
  expect(unchecked(s)).toEqual([]);
  await s.daemon.rescan();
  expect(unchecked(s)).toEqual([]);
  expect(JSON.parse(readFileSync(stateFile(), "utf8")).repos[repo].trusted).toEqual([entry]);
});

it("gives a lock that names a release newer than the daemon's the unstampable next action", async () => {
  const s = await start();
  await lockedBy("9.9.9");
  commitUnhooked("compiled by a release that does not exist");
  const forged = git(root, "rev-parse", "HEAD").trim();
  await until("the commit is flagged", () => unchecked(s).includes(forged));
  expect(openAlerts(root).find((d) => d.file === forged)?.next).toBe(unstampable(forged, ["refs/heads/main"]));
  git(root, "reset", "-q", "--hard", "HEAD^");
  await until("removing the commit closes the alert", () => !unchecked(s).includes(forged));
});

it("asks the owner to trust a published unstampable commit instead of naming a rewrite", async () => {
  const remote = join(scratch, "remote.git");
  git(scratch, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "remote", "add", "origin", remote);
  const s = await start();
  await lockedBy("0.1.10");
  commitUnhooked("downgraded and pushed");
  const pushed = git(root, "rev-parse", "HEAD").trim();
  await until("the commit is flagged", () => unchecked(s).includes(pushed));
  git(root, "push", "-q", "origin", "main");
  await s.daemon.rescan();
  expect(openAlerts(root).find((d) => d.file === pushed)?.next).toBe(`ask the repository owner to stop the daemon with warden daemon uninstall, add commit ${pushed} with a reason to the trusted list of ${realpathSync(join(root, ".git"))} in ${stateFile()}, and start it again with warden daemon install --port ${s.port}, because it is published in refs/remotes/origin/main and ${why}`);
  await stop();
  const saved = JSON.parse(readFileSync(stateFile(), "utf8")) as { repos: Record<string, Record<string, unknown>> };
  (saved.repos[realpathSync(join(root, ".git"))] as Record<string, unknown>).trusted = [{ commit: pushed, reason: "owner reviewed it", at: new Date().toISOString() }];
  await writeFile(stateFile(), JSON.stringify(saved));
  const again = await start(s.port);
  expect(again.port).toBe(s.port);
  expect(unchecked(again)).toEqual([]);
});

it("flags a commit again when it returns after removal and its Evidence is gone, though the boundary reaches it", async () => {
  let s = await start();
  await writeFile(join(root, "src/back.ts"), "export const back = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("flagged, removed, then restored");
  const back = git(root, "rev-parse", "HEAD").trim();
  await until("the commit is flagged", () => unchecked(s).includes(back));
  git(root, "reset", "-q", "--hard", "HEAD^");
  await until("removing the commit closes the alert", () => !unchecked(s).includes(back));
  await stop();
  const repo = realpathSync(join(root, ".git"));
  const saved = JSON.parse(readFileSync(stateFile(), "utf8")) as { repos: Record<string, Record<string, unknown>> };
  (saved.repos[repo] as Record<string, unknown>).boundary = [back];
  await writeFile(stateFile(), JSON.stringify(saved));
  await rm(join(home, "evidence"), { recursive: true, force: true });
  appendEvidence(PROJECT, { at: new Date().toISOString(), kind: "registered", root });
  s = await start();
  git(root, "reset", "-q", "--hard", back);
  await until("the restored commit is flagged again", () => unchecked(s).includes(back));
});

it("keeps a flagged commit inside the boundary flagged after its Evidence is gone", async () => {
  let s = await start();
  await writeFile(join(root, "src/aged.ts"), "export const aged = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("flagged, then aged out");
  const aged = git(root, "rev-parse", "HEAD").trim();
  await until("the commit is flagged", () => unchecked(s).includes(aged));
  await stop();
  const repo = realpathSync(join(root, ".git"));
  const saved = JSON.parse(readFileSync(stateFile(), "utf8")) as { repos: Record<string, Record<string, unknown>> };
  (saved.repos[repo] as Record<string, unknown>).boundary = [aged];
  await writeFile(stateFile(), JSON.stringify(saved));
  await rm(join(home, "evidence"), { recursive: true, force: true });
  appendEvidence(PROJECT, { at: new Date().toISOString(), kind: "registered", root });
  s = await start();
  expect(unchecked(s)).toEqual([aged]);
});

it("judges a root commit, its next action closes the alert, and a deleted branch drops its alert", async () => {
  const s = await start();
  const orphan = git(root, "commit-tree", await treeWith("src/o.ts"), "-m", "orphan").trim();
  git(root, "branch", "orphan", orphan);
  await until("the root commit is flagged", () => unchecked(s).includes(orphan));
  const short = orphan.slice(0, 12);
  const next = tampered().find((e) => e.file === orphan)?.next;
  expect(next).toContain(`run git switch -c warden-check-${short} main, then git read-tree -u --reset ${short}, then warden check --base main`);
  expect(next).toContain(`If the check finds a Guardrail violation, ask the repository owner to save the intended changes separately and remove ${short}`);
  git(root, "switch", "-q", "-c", `warden-check-${short}`, "main");
  git(root, "read-tree", "-u", "--reset", short);
  expect(warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", "main").code).toBe(0);
  await until("the root commit's alert closes", () => !unchecked(s).includes(orphan));
  git(root, "reset", "-q", "--hard");
  git(root, "switch", "-q", "main");
  const gone = git(root, "commit-tree", await treeWith("src/g.ts"), "-m", "doomed").trim();
  git(root, "branch", "doomed", gone);
  await until("the second root commit is flagged", () => unchecked(s).includes(gone));
  git(root, "branch", "-q", "-D", "doomed");
  await until("the unreachable commit's alert is dropped", () => !unchecked(s).includes(gone));
});

it("judges a merge whose tree is not the automatic merge of its parents, and passes a clean merge", async () => {
  const s = await start();
  const main = git(root, "rev-parse", "HEAD").trim();
  const side = git(root, "commit-tree", await treeWith("src/side.ts"), "-p", main, "-m", "side").trim();
  const automatic = git(root, "merge-tree", "--write-tree", main, side).split("\n")[0] as string;
  const clean = git(root, "commit-tree", automatic, "-p", main, "-p", side, "-m", "clean merge").trim();
  git(root, "update-ref", "refs/heads/main", clean);
  git(root, "reset", "-q", "--hard");
  await until("the clean merge is recorded", () => readEvidence(PROJECT).some((e) => e.kind === "commit" && e.commit === clean));
  expect(readEvidence(PROJECT).find((e) => e.kind === "commit" && e.commit === clean)?.status).toBe("checked");
  const evil = git(root, "commit-tree", await treeWith("src/evil.ts"), "-p", clean, "-p", side, "-m", "evil merge").trim();
  expect(git(root, "rev-list", "--parents", "-n", "1", evil).trim().split(" ")).toHaveLength(3);
  git(root, "update-ref", "refs/heads/main", evil);
  git(root, "reset", "-q", "--hard");
  await until("the evil merge is flagged", () => unchecked(s).includes(evil));
  expect(unchecked(s).sort()).toEqual([side, evil].sort());
});

it("an orphan worktree or a broken ref never stops detection, and a failing source raises its own alert", async () => {
  const s = await start();
  git(root, "worktree", "add", "-q", "--orphan", "-b", "empty", join(scratch, "orph"));
  await writeFile(join(root, "src/f.ts"), "export const f = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("next to an orphan worktree");
  const next = git(root, "rev-parse", "HEAD").trim();
  await until("the commit is flagged despite the orphan worktree", () => unchecked(s).includes(next));
  await writeFile(join(root, ".git/refs/heads/ghost"), `${"1".repeat(40)}\n`);
  git(root, "config", "core.hooksPath", "elsewhere");
  await until("the hook change is still detected", () => openOf(s).some((d) => d.detail === "hook-unwired"));
  await until("the failing history source raises an alert", () => openOf(s).some((d) => d.detail === "scan-error" && d.file === "git history"));
});

it("drops a removed worktree's root and hands commit judging to a live root without a restart", async () => {
  const wt = join(scratch, "first");
  git(root, "worktree", "add", "-q", wt, "-b", "first");
  await rm(join(home, "evidence"), { recursive: true, force: true });
  appendEvidence(PROJECT, { at: new Date().toISOString(), kind: "registered", root: wt });
  appendEvidence(PROJECT, { at: new Date().toISOString(), kind: "registered", root });
  const s = await start();
  expect([...s.daemon.projects.keys()]).toEqual([wt, root]);
  git(root, "worktree", "remove", wt);
  await until("the removed root is dropped", () => !s.daemon.projects.has(wt));
  await writeFile(join(root, "src/h.ts"), "export const h = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("after the first root left");
  const after = git(root, "rev-parse", "HEAD").trim();
  await until("the live root judges the commit", () => unchecked(s).includes(after));
});

it("does not judge commits that arrive already reachable from a remote-tracking ref", async () => {
  const remote = join(scratch, "remote.git");
  git(scratch, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "origin", "main");
  const clone = join(scratch, "clone");
  git(scratch, "clone", "-q", remote, clone);
  const s = await start();
  await writeFile(join(clone, "src/r.ts"), "export const r = 1;\n");
  git(clone, "add", "-A");
  git(clone, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "from another machine");
  git(clone, "push", "-q", "origin", "main");
  const remoteCommit = git(clone, "rev-parse", "HEAD").trim();
  git(root, "fetch", "-q", "origin");
  git(root, "merge", "-q", "--ff-only", "origin/main");
  await until("the pulled commit is seen", () => git(root, "rev-parse", "HEAD").trim() === remoteCommit);
  await s.daemon.rescan();
  expect(unchecked(s)).toEqual([]);
  await writeFile(join(root, "src/l.ts"), "export const l = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("local");
  const local = git(root, "rev-parse", "HEAD").trim();
  await until("a local commit is still flagged", () => unchecked(s).includes(local));
  expect(unchecked(s)).toEqual([local]);
});

it("a corrupt checkpoint stops startup with one next action", async () => {
  await mkdir(join(home, "daemon"), { recursive: true });
  await writeFile(stateFile(), "{");
  const r = warden(root, {}, "daemon", "--port", "0");
  expect(r.code).toBe(2);
  expect(r.err.match(/Next action: /g)).toHaveLength(1);
  expect(r.err.startsWith(`the daemon could not start: ${stateFile()} is not valid JSON`)).toBe(true);
});

it("a commit-tier check judges the staged blob of a file that is missing from disk", async () => {
  await writeFile(join(root, "src/bad.ts"), "// a comment\nexport const bad = 1;\n");
  git(root, "add", "-A");
  await rm(join(root, "src/bad.ts"));
  const r = warden(root, {}, "check", "--base", "main");
  expect(r.code).toBe(1);
  expect(r.out).toContain("Next action: run git add -- 'src/bad.ts', then run warden check --base main.");
  git(root, "add", "--", "src/bad.ts");
  expect(warden(root, {}, "check", "--base", "main").code).toBe(0);
});

it("a commit-tier check in a sparse checkout ignores files an earlier branch commit changed outside the sparse set", async () => {
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs/x.md"), "hi\n");
  git(root, "add", "-A");
  commitUnhooked("docs");
  git(root, "switch", "-q", "-c", "feat");
  await writeFile(join(root, "docs/x.md"), "hi\nmore\n");
  git(root, "add", "-A");
  commitUnhooked("docs on branch");
  git(root, "sparse-checkout", "set", "--no-cone", "/*", "!/docs/");
  expect(existsSync(join(root, "docs/x.md"))).toBe(false);
  await writeFile(join(root, "src/s.ts"), "export const s = 1;\n");
  git(root, "add", "src/s.ts");
  expect(warden(root, {}, "check", "--base", "main").code).toBe(0);
});

it("a conflict-resolution merge in a sparse checkout passes when the other parent changed a file outside the sparse set", async () => {
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs/x.md"), "hi\n");
  git(root, "add", "-A");
  commitUnhooked("docs");
  git(root, "switch", "-q", "-c", "feat");
  await writeFile(join(root, "src/a.ts"), "export const a = 2;\n");
  git(root, "add", "-A");
  commitUnhooked("feat a");
  git(root, "switch", "-q", "main");
  await writeFile(join(root, "src/a.ts"), "export const a = 3;\n");
  await writeFile(join(root, "docs/x.md"), "hi\nmore\n");
  git(root, "add", "-A");
  commitUnhooked("main a and docs");
  git(root, "switch", "-q", "feat");
  git(root, "sparse-checkout", "set", "--no-cone", "/*", "!/docs/");
  expect(() => git(root, "-c", "core.hooksPath=/dev/null", "merge", "-q", "--no-edit", "main")).toThrow();
  expect(existsSync(join(root, "docs/x.md"))).toBe(false);
  await writeFile(join(root, "src/a.ts"), "export const a = 4;\n");
  git(root, "add", "src/a.ts");
  expect(warden(root, {}, "check", "--base", "main").code).toBe(0);
});

it("a skip-worktree file with clean content on disk does not hide a bad blob committed without the hook", async () => {
  git(root, "switch", "-q", "-c", "feat");
  await writeFile(join(root, "src/a.ts"), "// bad comment\nexport const a = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("bad");
  await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
  git(root, "update-index", "--skip-worktree", "src/a.ts");
  const r = warden(root, {}, "check", "--base", "main");
  expect(r.code).toBe(1);
  expect(r.out).toContain("Next action: run git update-index --no-skip-worktree -- 'src/a.ts'");
});

const SIX = "export const l1 = 1;\nexport const l2 = 2;\nexport const l3 = 3;\nexport const l4 = 4;\nexport const l5 = 5;\nexport const l6 = 6;\n";

const hooked = async (...args: string[]): Promise<{ status: number | null; out: string }> => {
  const bin = join(scratch, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "warden"), `#!/bin/sh\nexec node '${main}' "$@"\n`, { mode: 0o755 });
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_EDITOR: "true" } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const sparseOut = (cone: boolean): void => {
  if (cone) git(root, "sparse-checkout", "set", "--cone", "src", ".warden");
  else git(root, "sparse-checkout", "set", "--no-cone", "/*", "!/docs/");
};

const seedDocs = async (): Promise<void> => {
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs/x.ts"), SIX);
  git(root, "add", "-A");
  commitUnhooked("docs");
};

it.each([false, true])("a merge in a sparse checkout (cone %s) commits when both sides changed a file outside the sparse set", async (cone) => {
  await seedDocs();
  git(root, "switch", "-q", "-c", "feat");
  await writeFile(join(root, "src/a.ts"), "export const a = 2;\n");
  await writeFile(join(root, "docs/x.ts"), SIX.replace("l1 = 1", "l1 = 10"));
  git(root, "add", "-A");
  commitUnhooked("feat");
  git(root, "switch", "-q", "main");
  await writeFile(join(root, "src/a.ts"), "export const a = 3;\n");
  await writeFile(join(root, "docs/x.ts"), SIX.replace("l6 = 6", "l6 = 60"));
  git(root, "add", "-A");
  commitUnhooked("main");
  git(root, "switch", "-q", "feat");
  sparseOut(cone);
  expect(() => git(root, "-c", "core.hooksPath=/dev/null", "merge", "-q", "--no-edit", "main")).toThrow();
  expect(existsSync(join(root, "docs/x.ts"))).toBe(false);
  await writeFile(join(root, "src/a.ts"), "export const a = 4;\n");
  git(root, "add", "src/a.ts");
  expect(await hooked("commit", "-q", "--no-edit")).toMatchObject({ status: 0 });
  expect(git(root, "show", "HEAD:docs/x.ts")).toBe(SIX.replace("l1 = 1", "l1 = 10").replace("l6 = 6", "l6 = 60"));
});

it.each(["commit", "continue"])("a cherry-pick conflict in a sparse checkout commits with git %s", async (how) => {
  await seedDocs();
  git(root, "switch", "-q", "-c", "other");
  await writeFile(join(root, "src/a.ts"), "export const a = 3;\n");
  await writeFile(join(root, "docs/x.ts"), SIX.replace("l6 = 6", "l6 = 60"));
  git(root, "add", "-A");
  commitUnhooked("other");
  git(root, "switch", "-q", "-c", "feat", "main");
  await writeFile(join(root, "src/a.ts"), "export const a = 2;\n");
  await writeFile(join(root, "docs/x.ts"), SIX.replace("l1 = 1", "l1 = 10"));
  git(root, "add", "-A");
  commitUnhooked("feat");
  sparseOut(false);
  expect(() => git(root, "-c", "core.hooksPath=/dev/null", "cherry-pick", "other")).toThrow();
  await writeFile(join(root, "src/a.ts"), "export const a = 4;\n");
  git(root, "add", "src/a.ts");
  const r = how === "commit" ? await hooked("commit", "-q", "--no-edit") : await hooked("cherry-pick", "--continue");
  expect(r).toMatchObject({ status: 0 });
});

it("a revert conflict in a sparse checkout commits", async () => {
  await seedDocs();
  git(root, "switch", "-q", "-c", "feat");
  await writeFile(join(root, "docs/x.ts"), SIX.replace("l1 = 1", "l1 = 10"));
  git(root, "add", "-A");
  commitUnhooked("docs v2");
  await writeFile(join(root, "src/a.ts"), "export const a = 2;\n");
  await writeFile(join(root, "docs/x.ts"), SIX.replace("l1 = 1", "l1 = 10").replace("l6 = 6", "l6 = 60"));
  git(root, "add", "-A");
  commitUnhooked("to revert");
  const reverted = git(root, "rev-parse", "HEAD").trim();
  await writeFile(join(root, "src/a.ts"), "export const a = 3;\n");
  git(root, "add", "-A");
  commitUnhooked("after");
  sparseOut(false);
  expect(() => git(root, "-c", "core.hooksPath=/dev/null", "revert", "--no-edit", reverted)).toThrow();
  await writeFile(join(root, "src/a.ts"), "export const a = 4;\n");
  git(root, "add", "src/a.ts");
  expect(await hooked("commit", "-q", "--no-edit")).toMatchObject({ status: 0 });
});

it("a skip-worktree file deleted from disk does not hide a bad blob committed without the hook", async () => {
  git(root, "switch", "-q", "-c", "feat");
  await writeFile(join(root, "src/a.ts"), "// bad comment\nexport const a = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("bad");
  git(root, "update-index", "--skip-worktree", "src/a.ts");
  await rm(join(root, "src/a.ts"));
  const r = warden(root, {}, "check", "--base", "main");
  expect(r.code).toBe(1);
  expect(r.out).toContain("src/a.ts:1");
  expect(readEvidence(PROJECT).filter((e) => e.kind === "fired" && e.file === "src/a.ts").map((e) => e.detail)).toEqual([createHash("sha256").update("// bad comment\nexport const a = 1;\n").digest("hex")]);
  expect(r.out).toContain("Next action: run git update-index --no-skip-worktree -- 'src/a.ts', then git checkout -- 'src/a.ts' to bring src/a.ts onto disk, then change the code at the lines above");
  git(root, "update-index", "--no-skip-worktree", "--", "src/a.ts");
  git(root, "checkout", "--", "src/a.ts");
  expect(readFileSync(join(root, "src/a.ts"), "utf8")).toContain("// bad comment");
  await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
  git(root, "add", "src/a.ts");
  expect(warden(root, {}, "check", "--base", "main").code).toBe(0);
});

it("a violation in a file outside the sparse set names the sparse-checkout step first, and that step works", async () => {
  await seedDocs();
  git(root, "switch", "-q", "-c", "feat");
  await writeFile(join(root, "src/a.ts"), "export const a = 2;\n");
  git(root, "add", "-A");
  commitUnhooked("feat");
  git(root, "switch", "-q", "main");
  await writeFile(join(root, "src/a.ts"), "export const a = 3;\n");
  await writeFile(join(root, "docs/x.ts"), `// bad comment\n${SIX}`);
  git(root, "add", "-A");
  commitUnhooked("main");
  git(root, "switch", "-q", "feat");
  sparseOut(false);
  expect(() => git(root, "-c", "core.hooksPath=/dev/null", "merge", "-q", "--no-edit", "main")).toThrow();
  await writeFile(join(root, "src/a.ts"), "export const a = 4;\n");
  git(root, "add", "src/a.ts");
  const r = warden(root, {}, "check", "--base", "main");
  expect(r.code).toBe(1);
  expect(r.out).toContain("Next action: run git sparse-checkout add -- 'docs' to bring docs/x.ts onto disk, then change the code at the lines above");
  git(root, "sparse-checkout", "add", "--", "docs");
  expect(existsSync(join(root, "docs/x.ts"))).toBe(true);
  await writeFile(join(root, "docs/x.ts"), SIX);
  git(root, "add", "docs/x.ts");
  expect(warden(root, {}, "check", "--base", "main").code).toBe(0);
});

const between = (text: string, start: string, end: string): string => {
  const from = text.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return text.slice(from + start.length, text.indexOf(end, from + start.length));
};

const follow = (step: string): void => {
  execFileSync("sh", ["-c", step.replaceAll(", then ", " && ")], { cwd: root, stdio: "ignore" });
};

it.each([
  { dir: "docs/[id]", cone: false, step: "git sparse-checkout add -- 'docs/\\[id\\]'" },
  { dir: "docs/[id]", cone: true, step: "git sparse-checkout add --skip-checks -- 'docs/[id]'" },
  { dir: "!x", cone: false, step: "git sparse-checkout add -- '\\!x'" },
  { dir: "#x", cone: false, step: "git sparse-checkout add -- '\\#x'" },
  { dir: "x ", cone: false, step: "git sparse-checkout add -- 'x\\ '" },
  { dir: "x ", cone: true, step: "git update-index --no-skip-worktree -- 'x /k.ts', then git checkout -- 'x /k.ts'" },
])("the printed steps bring $dir onto disk and stage it (cone $cone)", async ({ dir, cone, step }) => {
  const file = `${dir}/k.ts`;
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, file), "export const k = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("k");
  git(root, "switch", "-q", "-c", "feat");
  await writeFile(join(root, file), "// bad\nexport const k = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("bad");
  if (cone) git(root, "sparse-checkout", "set", "--cone", "src", ".warden");
  else git(root, "sparse-checkout", "set", "--no-cone", "/src/", "/.warden/");
  expect(existsSync(join(root, file))).toBe(false);
  await writeFile(join(root, "src/a.ts"), "export const a = 2;\n");
  git(root, "add", "src/a.ts");
  const r = warden(root, {}, "check", "--base", "main");
  expect(r.code).toBe(1);
  expect(between(r.out, "Next action: run ", ` to bring ${file} onto disk`)).toBe(step);
  follow(step);
  expect(readFileSync(join(root, file), "utf8")).toContain("// bad");
  await writeFile(join(root, file), "export const k = 1;\n");
  const unstaged = warden(root, {}, "check", "--base", "main");
  expect(unstaged.code).toBe(1);
  follow(between(unstaged.out, "Next action: run ", ", then run warden check"));
  expect(warden(root, {}, "check", "--base", "main").code).toBe(0);
});

const countingGit = async (extra = ""): Promise<{ bin: string; log: string }> => {
  const bin = join(scratch, "gitbin");
  const log = join(scratch, "git.log");
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "git"), `#!/bin/sh\necho "$*" >> '${log}'\n"${real}" "$@"\nrc=$?\n${extra}\nexit $rc\n`, { mode: 0o755 });
  return { bin, log };
};

it("judging files missing from disk runs the same number of git processes for 2 files as for 30", async () => {
  git(root, "switch", "-q", "-c", "feat");
  await mkdir(join(root, "lib"), { recursive: true });
  const files = Array.from({ length: 30 }, (_, i) => `lib/f${i}.ts`);
  for (const f of files) await writeFile(join(root, f), `export const v = ${files.indexOf(f)};\n`);
  git(root, "add", "-A");
  commitUnhooked("many");
  const { bin, log } = await countingGit();
  const hide = async (some: string[]): Promise<void> => {
    git(root, "update-index", "--skip-worktree", "--", ...some);
    for (const f of some) await rm(join(root, f));
  };
  const spawns = async (): Promise<number> => {
    await rm(log, { force: true });
    expect(warden(root, { PATH: `${bin}:${process.env.PATH}` }, "check", "--base", "main").code).toBe(0);
    return readFileSync(log, "utf8").trim().split("\n").length;
  };
  await hide(files.slice(0, 2));
  const few = await spawns();
  await hide(files.slice(2));
  expect(await spawns()).toBeLessThanOrEqual(few);
});

it.each(["SIGINT", "SIGHUP"] as const)("a check interrupted by %s removes its folder of copied blobs", async (signal) => {
  git(root, "switch", "-q", "-c", "feat");
  await writeFile(join(root, "src/a.ts"), "export const a = 5;\n");
  git(root, "add", "-A");
  commitUnhooked("feat");
  git(root, "update-index", "--skip-worktree", "src/a.ts");
  await rm(join(root, "src/a.ts"));
  const marker = join(scratch, "copied");
  const { bin } = await countingGit(`case "$*" in *checkout-index*) touch '${marker}'; sleep 1;; esac`);
  const temp = join(scratch, "tmp");
  await mkdir(temp, { recursive: true });
  const child = spawn("node", [main, "check", "--base", "main"], { cwd: root, env: { ...process.env, WARDEN_HOME: home, HOME: userHome, CLAUDE_CONFIG_DIR: claude, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temp }, stdio: "ignore" });
  const exited = new Promise<NodeJS.Signals | null>((done) => child.on("exit", (_code, signal) => done(signal)));
  await until("the blobs are copied", () => existsSync(marker));
  child.kill(signal);
  expect(await exited).toBe(signal);
  expect(readdirSync(temp).filter((f) => f.startsWith("warden-blobs-"))).toEqual([]);
});

it("a check that a passing run's stamp already covers does not refuse for that commit before the daemon rescans", async () => {
  const s = await start();
  git(root, "switch", "-q", "-c", "feat");
  await writeFile(join(root, "src/b.ts"), "export const b = 2;\n");
  git(root, "add", "-A");
  commitUnhooked("skipped the hook");
  const skipped = git(root, "rev-parse", "HEAD").trim();
  await until("the unchecked commit is flagged", () => unchecked(s).includes(skipped));
  await s.close();
  served = undefined;
  await beat({});
  expect(openAlerts(root).map((d) => d.file)).toEqual([skipped]);
  expect(warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", "main").code).toBe(0);
  await writeFile(join(root, "src/c.ts"), "export const c = 3;\n");
  git(root, "add", "-A");
  expect(warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", "main").code).toBe(0);
});

it("a repository registered while the daemon runs is watched without waiting for the next tick", async () => {
  served = await serve(wardenRoot, 0, { intervalMs: 60_000, debounceMs: 20 });
  await served.daemon.settled();
  const other = join(scratch, "late");
  await mkdir(join(other, "src"), { recursive: true });
  await writeFile(join(other, "src/a.ts"), "export const a = 1;\n");
  git(scratch, "init", "-q", "-b", "main", other);
  git(other, "add", "-A");
  git(other, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "seed");
  expect(warden(other, {}, "init").code).toBe(0);
  await until("the late repository is watched", () => served?.daemon.projects.has(other) === true);
});

it("a commit-tier check judges a skip-worktree or assume-unchanged blob, not the file on disk", async () => {
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: "// bad comment\nexport const a = 1;\n", encoding: "utf8" }).trim();
  git(root, "update-index", "--cacheinfo", `100644,${blob},src/a.ts`);
  git(root, "update-index", "--skip-worktree", "src/a.ts");
  const hidden = warden(root, {}, "check", "--base", "main");
  expect(hidden.code).toBe(1);
  expect(hidden.out).toContain("Next action: run git update-index --no-skip-worktree -- 'src/a.ts', then git update-index --no-assume-unchanged -- 'src/a.ts', then run warden check --base main.");
  git(root, "update-index", "--no-skip-worktree", "--", "src/a.ts");
  git(root, "update-index", "--assume-unchanged", "--", "src/a.ts");
  expect(warden(root, {}, "check", "--base", "main").out).toContain("--no-assume-unchanged -- 'src/a.ts'");
  git(root, "update-index", "--no-skip-worktree", "--", "src/a.ts");
  git(root, "update-index", "--no-assume-unchanged", "--", "src/a.ts");
  const shown = warden(root, {}, "check", "--base", "main");
  expect(shown.code).toBe(1);
  expect(shown.out).toContain("Next action: run git add -- 'src/a.ts'");
  git(root, "add", "--", "src/a.ts");
  expect(warden(root, {}, "check", "--base", "main").code).toBe(0);
});

const withRemote = (): string => {
  const remote = join(scratch, "pushed.git");
  git(scratch, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "remote", "add", "origin", remote);
  return remote;
};

it("a flagged commit stays flagged after it is pushed, its branch is deleted, and the remote is fetched", async () => {
  withRemote();
  const s = await start();
  git(root, "switch", "-q", "-c", "feat");
  await writeFile(join(root, "src/feat.ts"), "export const feat = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("feat");
  const feat = git(root, "rev-parse", "HEAD").trim();
  await until("the feature commit is flagged", () => unchecked(s).includes(feat));
  git(root, "push", "-q", "origin", "feat", "feat:main");
  git(root, "switch", "-q", "main");
  git(root, "branch", "-q", "-D", "feat");
  git(root, "fetch", "-q", "origin");
  await s.daemon.rescan();
  expect(unchecked(s)).toEqual([feat]);
});

it("a pushed or update-ref'd remote-tracking ref grants no exemption", async () => {
  withRemote();
  await start();
  await stop();
  await writeFile(join(root, "src/push.ts"), "export const push = 1;\n");
  git(root, "add", "-A");
  commitUnhooked("pushed at once");
  const pushed = git(root, "rev-parse", "HEAD").trim();
  git(root, "push", "-q", "origin", "main");
  const hidden = git(root, "commit-tree", await treeWith("src/hide.ts"), "-p", pushed, "-m", "hidden").trim();
  git(root, "update-ref", "refs/remotes/zz/hide", hidden);
  git(root, "update-ref", "refs/heads/main", hidden);
  git(root, "reset", "-q", "--hard");
  const s = await start();
  expect(unchecked(s).sort()).toEqual([pushed, hidden].sort());
});

it("seeds the tips of a repository discovered after the daemon started", async () => {
  const s = await start();
  const other = join(scratch, "later");
  await mkdir(join(other, "src"), { recursive: true });
  await writeFile(join(other, "src/a.ts"), "export const a = 1;\n");
  git(scratch, "init", "-q", "-b", "main", other);
  git(other, "add", "-A");
  git(other, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "seed");
  expect(warden(other, {}, "init").code).toBe(0);
  git(other, "add", "-A");
  git(other, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "warden");
  await writeFile(join(other, "src/b.ts"), "export const b = 1;\n");
  git(other, "add", "-A");
  git(other, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "after the lock, before discovery");
  await until("the later repository is watched", () => s.daemon.projects.has(other));
  await s.daemon.rescan();
  expect(unchecked(s)).toEqual([]);
});

it("every check tier fails with the alert's next action while an alert is open, and passes once it is fixed", async () => {
  const s = await start();
  git(root, "config", "core.hooksPath", "elsewhere");
  await until("the hook alert is open", () => openOf(s).some((d) => d.detail === "hook-unwired"));
  const edit = warden(root, { WARDEN_DAEMON: undefined }, "check", "--tier", "edit", "--base", "main", "src/a.ts");
  expect(edit).toMatchObject({ code: 1, err: expect.stringContaining("hook-unwired .warden/generated/hooks/pre-commit") });
  expect(edit.err).toContain("Next action: make elsewhere/pre-commit an executable script");
  expect(readEvidence(PROJECT).filter((e) => e.guardrail === "run").at(-1)).toMatchObject({ exit: 1, alert: "hook-unwired", result: "pass" });
  git(root, "config", "core.hooksPath", ".warden/generated/hooks");
  await until("the hook alert closes", () => openOf(s).length === 0);
  expect(warden(root, { WARDEN_DAEMON: undefined }, "check", "--tier", "edit", "--base", "main", "src/a.ts").code).toBe(0);
});

it("audits beside a missing hook and unchecked commit without changing either alert", async () => {
  const s = await start();
  git(root, "config", "core.hooksPath", "elsewhere");
  await writeFile(join(root, "src/b.ts"), "export const b = 2;\n");
  git(root, "add", "src/b.ts");
  commitUnhooked("unchecked change");
  const commit = git(root, "rev-parse", "HEAD").trim();
  await until("both commit enforcement alerts are open", () =>
    unchecked(s).includes(commit) && openOf(s).some((d) => d.detail === "hook-unwired"));

  const edit = warden(root, {}, "audit", "--format", "json", "src/a.ts");
  expect(edit).toMatchObject({ code: 0, err: "" });
  expect(JSON.parse(edit.out)).toMatchObject({ failures: [], tampered: [] });

  await writeFile(join(root, "src/a.ts"), "// An advisory finding.\nexport const a = 1;\n");
  const findings = warden(root, {}, "audit", "--format", "json", "src/a.ts");
  expect(findings).toMatchObject({ code: 0, err: "" });
  expect(JSON.parse(findings.out).failures).toEqual([expect.objectContaining({ guardrail: "warden-no-comments" })]);
  expect(warden(root, {}, "audit", "--tier", "commit")).toMatchObject({ code: 2, err: expect.stringContaining("edit, boundary") });
  expect(readEvidence(PROJECT).filter((e) => e.guardrail === "run" && e.trigger === "audit")).toEqual([
    expect.objectContaining({ result: "pass", tier: "edit", exit: 0 }),
    expect.objectContaining({ result: "fail", tier: "edit", exit: 0 }),
  ]);
  expect(openOf(s)).toEqual(expect.arrayContaining([
    expect.objectContaining({ detail: "hook-unwired" }),
    expect.objectContaining({ detail: "unchecked-commit", file: commit }),
  ]));
});

it("records a refused audit as failed when a policy alert is open", async () => {
  const alert = {
    project: PROJECT,
    root,
    repo: realpathSync(join(root, ".git")),
    file: ".claude/settings.local.json",
    detail: "plugin-disabled",
    next: 'set enabledPlugins "warden@warden" to true',
  };
  await mkdir(join(home, "daemon"), { recursive: true });
  await writeFile(stateFile(), JSON.stringify({ roots: { [root]: { open: [alert] } } }));

  const audit = warden(root, {}, "audit", "--format", "json", "src/a.ts");
  expect(audit).toMatchObject({ code: 1, err: expect.stringContaining("plugin-disabled") });
  const evidence = readEvidence(PROJECT);
  const summary = evidence.filter((e) => e.guardrail === "run").at(-1);
  expect(summary).toMatchObject({
    trigger: "audit", outcome: "refused", exit: 1, result: "fail", alert: "plugin-disabled",
  });
  expect(evidence.filter((e) => e.kind === "step" && e.step === "verdict" && e.run === summary?.run).at(-1)).toMatchObject({ state: "fail" });
});

it("a boundary audit leaves the baseline and index intact and rejects policy drift", async () => {
  const baselinePath = ".warden/baseline.json";
  const baseline = '{ "warden-no-comments": { "src/deleted.ts": 1 } }\n';
  await writeFile(join(root, baselinePath), baseline);
  git(root, "add", baselinePath);
  commitUnhooked("existing baseline");
  const s = await start();
  git(root, "config", "core.hooksPath", "elsewhere");
  await until("the hook alert is open", () => openOf(s).some((d) => d.detail === "hook-unwired"));

  const args = ["--tier", "boundary", "--format", "json", "src/a.ts"];
  const before = git(root, "write-tree");
  const boundary = warden(root, {}, "audit", ...args);
  expect(boundary).toMatchObject({ code: 0, err: "" });
  expect(JSON.parse(boundary.out)).toMatchObject({ failures: [], tampered: [] });
  expect(readFileSync(join(root, baselinePath), "utf8")).toBe(baseline);
  expect(git(root, "write-tree")).toBe(before);

  const mismatched = warden(root, {}, "audit", "--rule", "warden-no-comments", ...args);
  expect(mismatched).toMatchObject({ code: 2, err: expect.stringContaining("warden audit --tier edit --rule warden-no-comments") });

  await writeFile(join(root, ".warden/generated/hooks/pre-commit"), "#!/bin/sh\nexit 0\n");
  const drift = warden(root, {}, "audit", ...args);
  expect(drift.code).toBe(1);
  expect(JSON.parse(drift.out).tampered).toEqual([
    expect.objectContaining({ file: ".warden/generated/hooks/pre-commit", detail: "generated-drift" }),
  ]);
});

it("an invalid Claude settings file is not recorded as tampering", async () => {
  const s = await start();
  await mkdir(claude, { recursive: true });
  await writeFile(join(claude, "settings.json"), "{");
  await s.daemon.rescan();
  git(root, "config", "core.hooksPath", "elsewhere");
  await until("scans continue past the invalid file", () => openOf(s).some((d) => d.detail === "hook-unwired"));
  expect(tampered().map((e) => e.detail)).toEqual(["hook-unwired"]);
});

it("a startup failure after the port binds exits 2 with one next action", async () => {
  await rm(join(home, "evidence"), { recursive: true, force: true });
  await writeFile(join(home, "evidence"), "not a folder");
  const r = warden(root, {}, "daemon", "--port", "0");
  expect(r.code).toBe(2);
  expect(r.err).toMatch(/^the daemon could not start: .*\. Next action: fix what that names under .*, then run warden daemon\n$/);
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
  expect(check()).toMatchObject({ code: 1, err: expect.stringContaining(`names process ${dead}, which is not a running daemon. Next action: start the daemon`) });
  await mkdir(join(home, "daemon"), { recursive: true });
  await writeFile(heartbeatFile(), "null");
  expect(check()).toMatchObject({ code: 1, err: `${heartbeatFile()} does not hold a heartbeat. Next action: start the daemon: warden daemon install\n` });
  await beat({ pid: 1 });
  expect(check()).toMatchObject({ code: 1, err: expect.stringContaining("names process 1, which is not a running daemon") });
  expect(readEvidence(PROJECT).filter((e) => e.outcome === "refused").map((e) => [e.exit, e.next])).toEqual(Array(6).fill([1, "start the daemon: warden daemon install"]));
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
  const blocked = warden(root, { WARDEN_DAEMON: undefined }, "check", "--base", "main");
  expect(blocked).toMatchObject({ code: 1, err: expect.stringContaining(`gate-off run `) });
  await until("the gated check closes the alert", () => [...(s.daemon.projects.get(root)?.open.values() ?? [])].every((d) => d.detail !== "gate-off"));
  await until("the closed alert reaches state.json", () => openAlerts(root).length === 0);
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
