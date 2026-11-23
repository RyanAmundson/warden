import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

let scratch: string | undefined;
afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

const watch = resolve("scripts/watch-main.mjs");
const ref = "refs/remotes/origin/main";
const config = `warden: "0.1.0"
project: sample
base: origin/main
packs:
  - id: core
    paths: ["**/*"]
tierBudgetMs: { edit: 2000, commit: 10000, boundary: 120000 }
loopBreakerRepeats: 3
`;
const lock = '{"config":{"base":"origin/main"}}';
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

function fixture() {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "warden-watch-test-")));
  const root = join(scratch, "repo");
  const home = join(scratch, "home");
  const executable = join(scratch, "audit.mjs");
  const env = { ...process.env, WARDEN_HOME: home };
  mkdirSync(join(root, ".warden"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env }).trim();
  git("init", "--quiet", "-b", "topic");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Fixture");
  git("config", "core.hooksPath", join(scratch, "empty-hooks"));
  writeFileSync(join(root, ".warden", "config.yaml"), config);
  writeFileSync(join(root, ".warden", "lock.json"), lock);
  const source = join(root, "example.txt");
  function commit(content: string) {
    writeFileSync(source, content);
    git("add", ".");
    git("commit", "--quiet", "-m", content);
    return git("rev-parse", "HEAD");
  }
  writeFileSync(executable, `#!${process.execPath}
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [, , command, , tier, , base] = process.argv;
if (command !== "audit") process.exit(23);
if (process.env.WARDEN_TEST_FAILED_TIER === tier) {
  process.stderr.write("fixture refused");
  process.exit(17);
}
const evidence = process.env.WARDEN_HOME + "/evidence";
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) process.exit(24);
mkdirSync(evidence, { recursive: true });
writeFileSync(evidence + "/sample.jsonl", JSON.stringify({
  kind: "cost", guardrail: "run", at: new Date().toISOString(), tier, base, outcome: "ran", exit: 0,
  detail: readFileSync("example.txt", "utf8"),
}));
`, { mode: 0o700 });
  const run = (args: string[] = [], failedTier?: string) => execFileSync(process.execPath,
    [watch, root, "sample", ref, executable, ...args, "--once"],
    { env: { ...env, WARDEN_TEST_FAILED_TIER: failedTier }, stdio: "pipe" });
  const path = join(home, "evidence", "sample.jsonl");
  const receipts = () => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { commit, executable, git, path, receipts, root, run, source };
}

test("audits only the published ref using clean snapshots and remembers each tier across restarts", () => {
  const { commit, git, receipts, root, run, source } = fixture();
  const base = commit("base");
  const first = commit("published");
  git("update-ref", ref, first);
  const next = commit("next");
  writeFileSync(source, "dirty");
  run();
  run();
  const common = { root, ref, packs: ["core"], trigger: "main audit", exit: 0 };
  expect(receipts()).toMatchObject([
    { ...common, tier: "edit", detail: "published", commit: first, base },
    { ...common, tier: "boundary", detail: "published", commit: first, base },
  ]);
  git("update-ref", ref, next);
  run();
  run();
  expect(receipts().slice(2)).toMatchObject([
    { ...common, tier: "edit", detail: "next", commit: next, base: first },
    { ...common, tier: "boundary", detail: "next", commit: next, base: first },
  ]);
  expect(readFileSync(source, "utf8")).toBe("dirty");
  git("update-ref", ref, base);
  expect(() => run()).toThrow("no longer descends from");
  expect(receipts()).toHaveLength(4);
});

test("requires the approved policy pair before launching checks", () => {
  const { commit, git, path, root, run, receipts } = fixture();
  commit("base");
  git("update-ref", ref, commit("published"));
  const allowlist = join(root, "policies.json");
  writeFileSync(allowlist, JSON.stringify([{ config: sha256(config), lock: sha256(lock + "\n") }]));
  expect(() => run([allowlist])).toThrow("outside the approved policy list");
  expect(existsSync(path)).toBe(false);
  writeFileSync(allowlist, JSON.stringify([{ config: sha256(config), lock: sha256(lock) }]));
  run([allowlist]);
  expect(receipts()).toHaveLength(2);
});

test("makes an executable failure visible for both tiers", () => {
  const { commit, executable, git, receipts, run } = fixture();
  const base = commit("base");
  const published = commit("published");
  git("update-ref", ref, published);
  const original = readFileSync(executable);
  writeFileSync(executable, "#!/bin/sh\nprintf 'fixture refused\\n' >&2\nexit 17\n");
  expect(() => run()).toThrow();
  expect(receipts()).toMatchObject([
    { tier: "edit", exit: 17, outcome: "error", next: "fixture refused", base, commit: published },
    { tier: "boundary", exit: 17, outcome: "error", next: "fixture refused", base, commit: published },
  ]);
  writeFileSync(executable, original);
  run();
  expect(receipts().slice(2)).toMatchObject([
    { tier: "edit", exit: 0, outcome: "ran", base, commit: published },
    { tier: "boundary", exit: 0, outcome: "ran", base, commit: published },
  ]);
});

test("keeps missed changes in a tier's comparison when main advances after a failure", () => {
  const { commit, git, receipts, run } = fixture();
  const base = commit("base");
  const missed = commit("missed boundary");
  git("update-ref", ref, missed);
  expect(() => run([], "boundary")).toThrow();
  const latest = commit("latest");
  git("update-ref", ref, latest);
  run();
  expect(receipts().slice(2)).toMatchObject([
    { tier: "edit", exit: 0, base: missed, commit: latest },
    { tier: "boundary", exit: 0, base, commit: latest },
  ]);
});

test("keeps the audited range when old project receipts rotate out", () => {
  const { commit, git, path, receipts, run } = fixture();
  commit("base");
  const first = commit("first published");
  git("update-ref", ref, first);
  run();
  writeFileSync(path, JSON.stringify({ kind: "change", detail: "x".repeat(1_200_000) }) + "\n");
  run();
  expect(receipts()).toHaveLength(1);
  commit("intermediate published");
  const latest = commit("latest published");
  git("update-ref", ref, latest);
  run();
  expect(receipts().slice(1)).toMatchObject([
    { tier: "edit", exit: 0, base: first, commit: latest },
    { tier: "boundary", exit: 0, base: first, commit: latest },
  ]);
});
