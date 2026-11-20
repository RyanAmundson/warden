import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmod, readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "../../dist/src/cli/main.js");
let temp: string;
let root: string;
let home: string;
let base: string;
let head: string;

const git = (...args: string[]): string => execFileSync("git", [
  "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args,
], { cwd: root, encoding: "utf8" }).trim();

const run = (cwd: string, ...args: string[]) => new Promise<{ code: number; out: string; err: string }>((done, reject) => {
  execFile(process.execPath, [cli, "review", ...args], { cwd, env: { ...process.env, WARDEN_HOME: home, HOME: home } }, (error, out, err) => {
    if (error === null) done({ code: 0, out, err });
    else if (typeof error.code === "number") done({ code: error.code, out, err });
    else reject(error);
  });
});

const seriesFlags = (series: string): string[] => ["--series", series, "--target", "Counter", "--capability", "gate"];
const reviewFlags = (file = "requirements.md", at = head): string[] => ["--base", base, "--head", at, "--requirements", file];
const record = (series: string, report: string, ...extra: string[]) =>
  run(root, "record", ...seriesFlags(series), ...reviewFlags(), "--report", report, ...extra);
const history = (series: string, ...extra: string[]) => run(root, "history", ...seriesFlags(series), ...extra);

async function writeReport(name: string, finding = "", at = head): Promise<string> {
  const file = join(temp, name);
  await writeFile(file, `Verdict: ${finding === "" ? "PASS" : "FAIL"}\nReviewed head: ${at}\n\n${finding}`);
  return file;
}

const finding = (n: number, extra = "- Spec: yes", location = "counter.ts:1") =>
  `### Minor ${n}. Counter behavior\n- Where: ${location}\n- Reproduces on: head\n${extra}\n- Correction condition: match the requirement.\n`;

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), "warden-review-record-"));
  root = join(temp, "repo");
  home = join(temp, "home");
  await mkdir(join(root, ".warden/packs/local"), { recursive: true });
  await mkdir(home);
  await writeFile(join(root, ".warden/config.yaml"), 'warden: "0.1.14"\nproject: counter\nbase: main\npacks: [{ id: local, paths: ["**/*.ts"] }]\ntierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }\nloopBreakerRepeats: 3\n');
  await writeFile(join(root, ".warden/packs/local/pack.yaml"), [
    "id: local", "layer: 1", "terms: []", "practices: []", "capabilities:",
    "  - id: gate", "    kind: skill", "    serves: review", "    purpose: Review the change.", "    when: Before landing.",
    "    upholds: []", "    commands: [warden review]", "    replaces: []",
    "    review: { adapter: superpowers-review, model: opus, roundLimit: 4 }", "",
  ].join("\n"));
  git("init", "-q", "-b", "main");
  await writeFile(join(root, "requirements.md"), "Export the expected counter.\n");
  await writeFile(join(root, "counter.ts"), "export const counter = 0;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  base = git("rev-parse", "HEAD");
  await writeFile(join(root, "counter.ts"), "export const counter = 1;\n");
  git("commit", "-qam", "change");
  head = git("rev-parse", "HEAD");
});

afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe("record a completed review", () => {
  it("deduplicates concurrent retries, preserves the native report, and rejects changed immutable inputs", async () => {
    const report = await writeReport("race.txt", finding(1));
    const [a, b] = await Promise.all([record("race", report), record("race", report)]);
    expect(a.err).toBe("");
    expect(a.code).toBe(1);
    expect(b).toEqual(a);

    const { id } = JSON.parse(a.out);
    const exact = await history("race", "--round", id);
    expect(exact.code).toBe(0);
    expect(JSON.parse(exact.out)).toMatchObject({
      id, number: 1, input: {
        base, head, previous: null, warden: "0.1.14",
        settings: { adapter: "superpowers-review", model: "opus", roundLimit: 4 },
        requirements: [{ path: "requirements.md", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
        report: { text: await readFile(report, "utf8") },
      }, result: { verdict: "fail", findings: [{ n: 1, kind: "spec-unmet", blocks: true }] },
    });
    const newRequirement = join(root, "alternate-requirements.md");
    await writeFile(newRequirement, "Changed requirement.\n");
    const conflict = await record("race", report, "--requirements", newRequirement);
    expect(conflict.code).toBe(2);
    expect(conflict.err).toContain("already has a different round 1");

    const replay = await record("race", report, "--previous-round", id);
    expect(replay.code).toBe(2);
    expect(replay.err).toContain("already belongs to round");
    expect(JSON.parse((await history("race")).out)).toHaveLength(1);
  });

  it("records repeated kinds and escalates only an unresolved configured round", async () => {
    for (const series of ["fixed", "unresolved"]) {
      let previous: string[] = [];
      for (let number = 1; number <= 4; number++) {
        const passes = series === "fixed" && number === 4;
        const report = await writeReport(`${series}-${number}.txt`, passes ? "" : finding(number));
        const result = await record(series, report, ...previous);
        expect(result.err).toBe("");
        expect(result.code).toBe(passes ? 0 : 1);
        const round = JSON.parse(result.out);
        expect(round).toMatchObject({
          number, previous: previous[1] ?? null,
          signals: {
            repeated: number === 1 || passes ? [] : [{ kind: "spec-unmet", previous: [number - 1], current: [number] }],
            escalation: number === 4 && !passes ? { limit: 4, blocking: [4] } : null,
          },
        });
        previous = ["--previous-round", round.id];
      }
    }
    const unrelatedId = JSON.parse((await history("fixed")).out)[0].id;
    const report = await writeReport("unknown-previous.txt");
    const wrongSeries = await record("independent", report, "--previous-round", unrelatedId);
    expect(wrongSeries.code).toBe(2);
    expect(wrongSeries.err).toContain("No completed round");
    expect(JSON.parse((await history("independent")).out)).toEqual([]);
  });

  it("leaves stale, operational, malformed and stateless review attempts outside history", async () => {
    const stale = await writeReport("stale.txt", "", base);
    const env = await writeReport("env.txt", finding(1).replace("### Minor", "### Environment"));
    const malformed = await writeReport("duplicate.txt", finding(1) + finding(1));
    const pass = await writeReport("good.txt");
    const flags = ["--capability", "gate", ...reviewFlags()];
    expect((await run(root, "brief", ...flags)).code).toBe(0);
    expect((await run(root, "triage", ...flags, "--report", pass)).code).toBe(0);
    for (const report of [stale, env, malformed]) {
      expect((await record("attempts", report)).code).toBe(2);
    }
    expect(JSON.parse((await history("attempts")).out)).toEqual([]);
    const saved = await record("attempts", pass);
    expect(saved.code).toBe(0);
    expect(JSON.parse(saved.out).number).toBe(1);
  });

  it("names the Git prerequisite when recording on an older Git", async () => {
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = join(temp, "older-git");
    await mkdir(bin);
    const shim = join(bin, "git");
    await writeFile(shim, [
      "#!/bin/sh",
      'case "$1" in',
      '  --attr-source=*) printf "unknown option: %s\\n" "$1" >&2; exit 129 ;;',
      "esac",
      'exec "$REAL_GIT" "$@"',
      "",
    ].join("\n"));
    await chmod(shim, 0o700);
    const report = await writeReport("git-version.txt");
    const older = spawnSync(process.execPath, [cli, "review", "record", ...seriesFlags("git-version"), ...reviewFlags(), "--report", report], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, WARDEN_HOME: home, HOME: home, REAL_GIT: realGit, PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
    expect(older.status).toBe(2);
    expect(older.stderr).toContain("Recording a review needs Git 2.41 or later.");
    expect(JSON.parse((await history("git-version")).out)).toEqual([]);
  });

  it("shares history across linked worktrees and excludes untracked files from the verdict", async () => {
    const peer = join(temp, "linked");
    git("worktree", "add", "-q", "--detach", peer, head);
    await writeFile(join(peer, "scratch.ts"), "export const counter = 2;\n");
    await writeFile(join(peer, ".gitattributes"), "counter.ts -diff\n");
    const report = await writeReport("same-commits.txt", finding(1, "- Spec: no", "scratch.ts:1"));
    const saved = await record("worktree", report);
    expect(saved.err).toBe("");
    expect(saved.code).toBe(0);
    const retry = await run(peer, "record", ...seriesFlags("worktree"), ...reviewFlags(), "--report", report);
    expect(retry).toEqual(saved);
    expect(JSON.parse(retry.out).findings).toMatchObject([{ kind: "untouched", blocks: false }]);

    const committed = await writeReport("committed-lines.txt", finding(1, "- Spec: no"));
    const original = await record("commit-attributes", committed);
    expect(original.code).toBe(1);
    expect(JSON.parse(original.out).findings).toMatchObject([{ kind: "touched", blocks: true }]);
    const fromPeer = await run(peer, "record", ...seriesFlags("commit-attributes"), ...reviewFlags(), "--report", committed);
    expect(fromPeer).toEqual(original);
  });
});
