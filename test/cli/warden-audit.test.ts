import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Served, serve } from "../../src/cli/daemon.js";
import { stateFile } from "../../src/runner/daemon.js";
import { LOCK_PATH, type Lock, sha256 } from "../../src/compiler/lock.js";
import { type Evidence, appendEvidence, readEvidence } from "../../src/runner/evidence.js";
import { verdictOf } from "../verdict.js";

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
  return verdictOf(args, spawnSync("node", [main, ...args], { cwd, encoding: "utf8", env: { ...process.env, WARDEN_HOME: home, HOME: userHome, CLAUDE_CONFIG_DIR: claude, ...env } }));
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

const start = async (port = 0): Promise<Served> => {
  served = await serve(wardenRoot, port, { intervalMs: 200, debounceMs: 20 });
  await served.daemon.settled();
  return served;
};

const openOf = (s: Served): { detail: string; file: string }[] => [...s.daemon.projects.values()].flatMap((w) => [...w.open.values()]);

const unchecked = (s: Served): string[] => openOf(s).filter((d) => d.detail === "unchecked-commit").map((d) => d.file);

it("reconciles an older committed lock while still flagging generated and lock changes", async () => {
  const file = ".warden/generated/hooks/pre-commit";
  const lockFile = join(root, LOCK_PATH);
  const generated = `${readFileSync(join(root, file), "utf8")}\n`;
  const lock = JSON.parse(readFileSync(lockFile, "utf8")) as Lock;
  lock.warden = "0.1.13";
  lock.generated[file] = sha256(generated);
  const committed = `${JSON.stringify(lock, null, 2)}\n`;
  await writeFile(lockFile, committed);
  await writeFile(join(root, file), generated);
  git(root, "add", "-A");
  commitUnhooked("older compiler snapshot");
  const s = await start();
  expect(openOf(s)).toEqual([]);
  expect(warden(root, {}, "check", "--tier", "edit", "--base", "main", "src/a.ts")).toMatchObject({ code: 2, err: expect.stringContaining("an older release") });

  await writeFile(join(root, file), `${generated}\n`);
  await until("the older generated file change is flagged", () => openOf(s).some((d) => d.detail === "generated-drift"));
  await writeFile(join(root, file), generated);
  await writeFile(lockFile, `${committed}\n`);
  await until("the older lock change is flagged", () => openOf(s).some((d) => d.detail === "lock-drift"));
  await s.daemon.rescan();
  expect(openOf(s)).toEqual([expect.objectContaining({ file: LOCK_PATH, detail: "lock-drift" })]);

  await writeFile(lockFile, committed);
  await until("the restored older snapshot clears the alert", () => openOf(s).length === 0);
  expect(tampered()).toEqual(expect.arrayContaining([expect.objectContaining({ file, detail: "generated-drift" }), expect.objectContaining({ file: LOCK_PATH, detail: "lock-drift" })]));
});

it("separates same-name repositories in the project and tamper API", async () => {
  const clone = join(scratch, "same-name-clone");
  git(scratch, "clone", "-q", root, clone);
  appendEvidence(PROJECT, { at: new Date().toISOString(), kind: "registered", root: clone });
  git(clone, "config", "core.hooksPath", ".warden/generated/hooks");
  const s = await start();
  await writeFile(join(clone, "src/a.ts"), "export const a = 2;\n");
  git(clone, "add", "src/a.ts");
  git(clone, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "unchecked clone change");
  const sha = git(clone, "rev-parse", "HEAD").trim();
  await until("the clone commit is flagged", () => unchecked(s).includes(sha));
  const primaryRepo = join(root, ".git");
  const cloneRepo = join(clone, ".git");
  expect((await get("/api/projects")).body).toMatchObject({ projects: [{ project: PROJECT, openAlerts: 1, repositories: expect.arrayContaining([
    { repo: primaryRepo, roots: [root], openAlerts: 0 },
    { repo: cloneRepo, roots: [clone], openAlerts: 1 },
  ]) }] });
  const endpoint = `/api/tamper?project=${PROJECT}&repo=`;
  expect(await get(`${endpoint}${encodeURIComponent(primaryRepo)}`)).toEqual({ status: 200, body: { open: [], recent: [] } });
  expect((await get(`${endpoint}${encodeURIComponent(cloneRepo)}`)).body).toMatchObject({
    open: [{ root: clone, repo: cloneRepo, detail: "unchecked-commit", file: sha }],
    recent: [{ root: clone, repo: cloneRepo, detail: "unchecked-commit", file: sha }],
  });
  expect((await get(`${endpoint}unknown`)).status).toBe(404);
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
  expect(readEvidence(PROJECT).filter((e) => e.guardrail === "run" && String(e.trigger) === "audit")).toEqual([
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


it("keeps main-audit scope available after a later manual run", async () => {
  await start();
  const base = { at: new Date().toISOString(), kind: "cost", guardrail: "run", outcome: "ran", tier: "boundary", root } as const;
  const main = { ...base, trigger: "main audit", ref: "refs/remotes/origin/main", commit: "main-revision", packs: ["core"] } as const;
  const edit = { ...main, tier: "edit", result: "fail" } as unknown as Evidence;
  const boundary = { ...main, result: "pass" } as unknown as Evidence;
  appendEvidence(PROJECT, { ...boundary, commit: "previous-revision" });
  appendEvidence(PROJECT, edit);
  appendEvidence(PROJECT, boundary);
  appendEvidence(PROJECT, { ...boundary, root: join(scratch, "removed"), commit: "other-revision" });
  appendEvidence(PROJECT, { ...base, trigger: "manual", commit: "manual-revision" });
  expect((await get("/api/projects")).body).toMatchObject({
    projects: [{ project: PROJECT, lastRun: { trigger: "manual", commit: "manual-revision" }, lastMainAudit: boundary, mainAuditRuns: [edit, boundary] }],
  });
});
