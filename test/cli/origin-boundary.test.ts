import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../../scripts/check-origin-boundary.sh");
let fixture: string;
let project: string;
let base: string;
let env: NodeJS.ProcessEnv;

const git = (...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=Warden Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: project, env, encoding: "utf8" }).trim();

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "warden-origin-"));
  project = join(fixture, "project");
  mkdirSync(project);
  const bin = join(fixture, "bin");
  mkdirSync(bin);
  env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, WARDEN_CALLS: join(fixture, "calls") };
  writeFileSync(join(bin, "warden"), `#!/bin/sh
set -eu
if [ "$1" = daemon ]; then
  mkdir -p "$WARDEN_HOME/daemon"
  printf 'ready\\n' > "$WARDEN_HOME/daemon/heartbeat.json"
  while :; do sleep 1; done
fi
printf '%s\\n' "$*" >> "$WARDEN_CALLS"
`, { mode: 0o755 });
  git("init", "-qb", "main");
  git("config", "core.hooksPath", join(fixture, "no-hooks"));
  git("commit", "--allow-empty", "-qm", "Seed fixture");
  base = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "Update fixture");
});

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

it("runs both check tiers with the same exact base", () => {
  const result = spawnSync("sh", [script, base, git("rev-parse", "HEAD")], { cwd: project, env, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(env.WARDEN_CALLS!, "utf8").trim().split("\n")).toEqual([
    `check --tier commit --base ${base}`,
    `check --tier boundary --base ${base}`,
  ]);
});

it("rejects a candidate that is not ahead of the base", () => {
  const head = git("rev-parse", "HEAD");
  const result = spawnSync("sh", [script, head, head], { cwd: project, env, encoding: "utf8" });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("must be ahead of the current main commit");
});

it("rejects a clean checkout of a different candidate", () => {
  const expected = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "Add a separate fixture commit");
  const result = spawnSync("sh", [script, base, expected], { cwd: project, env, encoding: "utf8" });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("HEAD differs from the candidate commit");
});
