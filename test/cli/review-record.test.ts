import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmod, readFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
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
    "id: local", "layer: 1", "terms: []", "practices:",
    "  - id: counter-behavior", "    statement: Counter behavior matches its contract.", "    terms: []", "    paths: []", "    conflictsWith: []", "    guardrails: []",
    '  - id: " "', "    statement: An existing Practice ID is preserved.", "    terms: []", "    paths: []", "    conflictsWith: []", "    guardrails: []",
    "capabilities:",
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
      if (series === "unresolved") {
        const ruling = await run(root, "rule", ...seriesFlags(series), "--round", previous[1] as string,
          "--finding", "4", "--role", "repository-owner", "--actor", "Project owner",
          "--reason", "The requirement was already met.", "--evidence", "requirements.md:1");
        expect(ruling.code, ruling.err).toBe(0);
        expect(JSON.parse((await history(series)).out)[3]).toMatchObject({
          verdict: "fail", signals: { escalation: null, reviewerErrors: [{ finding: 4, role: "repository-owner" }] },
        });
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

  it("records an identified reviewer error without rewriting the round or other findings", async () => {
    const series = "reviewer-error";
    const first = await record(series, await writeReport("error-first.txt", finding(1) + finding(2, "- Spec: no")));
    expect(first.code).toBe(1);
    const { id } = JSON.parse(first.out);
    const before = JSON.parse((await history(series, "--round", id)).out);
    const next = await record(series, await writeReport("error-second.txt", finding(3)), "--previous-round", id);
    expect(JSON.parse(next.out).signals.repeated).toEqual([{ kind: "spec-unmet", previous: [1], current: [3] }]);

    const flags = ["rule", ...seriesFlags(series), "--round", id, "--finding", "1", "--role", "independent-reviewer",
      "--actor", "Independent reviewer", "--reason", "The requirement permits both return values.", "--evidence", "requirements.md:1"];
    const [ruling, retry] = await Promise.all([run(root, ...flags), run(root, ...flags)]);
    expect(ruling.code, ruling.err).toBe(0);
    expect(retry).toEqual(ruling);
    expect(JSON.parse(ruling.out)).toMatchObject({
      finding: 1, round: id, actor: "Independent reviewer", role: "independent-reviewer",
      reason: "The requirement permits both return values.", evidence: "requirements.md:1",
    });
    const conflict = await run(root, ...flags, "--reason", "A different ruling");
    expect(conflict.code).toBe(2);
    const absent = await run(root, ...flags, "--finding", "99");
    expect(absent.code).toBe(2);
    expect((await run(root, ...flags, "--role", "author")).code).toBe(2);
    expect((await run(root, ...flags, "--actor", " ")).code).toBe(2);

    const rounds = JSON.parse((await history(series)).out);
    expect(rounds[0]).toMatchObject({
      verdict: "fail", findings: [{ n: 1, blocks: true }, { n: 2, blocks: true }],
      signals: { reviewerErrors: [{ finding: 1 }] },
    });
    expect(rounds[1]).toMatchObject({
      verdict: "fail", findings: [{ n: 3, blocks: true }], signals: { repeated: [] },
    });
    expect(JSON.parse((await history(series, "--round", id)).out)).toEqual(before);
    expect((await record(series, await writeReport("error-first.txt", finding(1) + finding(2, "- Spec: no")))).code).toBe(1);
  });

  it("keeps the next round available when a prior ruling is unreadable", async () => {
    const series = "damaged-ruling";
    const first = await record(series, await writeReport("damaged-first.txt", finding(1)));
    expect(first.code).toBe(1);
    const { id } = JSON.parse(first.out);
    const ruled = await run(root, "rule", ...seriesFlags(series), "--round", id, "--finding", "1",
      "--role", "repository-owner", "--actor", "Project owner", "--reason", "That is expected.", "--evidence", "requirements.md:1");
    expect(ruled.code, ruled.err).toBe(0);
    const reviewHome = join(home, "review");
    const paths = (await readdir(reviewHome)).map((dir) => join(reviewHome, dir));
    const records = await Promise.all(paths.map((dir) => readFile(join(dir, "round-1.json"), "utf8")));
    const index = records.findIndex((entry) => JSON.parse(entry).input.series === series);
    expect(index).toBeGreaterThanOrEqual(0);
    const directory = paths[index] as string;
    const damaged = join(directory, "error-1-1.json");
    const original = await readFile(damaged);
    await writeFile(damaged, "{");

    const nextReport = await writeReport("damaged-second.txt");
    const refused = await record(series, nextReport, "--previous-round", id);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("Invalid review ruling");
    expect(await readdir(directory)).not.toContain("round-2.json");

    await writeFile(damaged, original);
    const recovered = await record(series, nextReport, "--previous-round", id);
    expect(recovered.code, recovered.err).toBe(0);
    expect(JSON.parse(recovered.out)).toMatchObject({ number: 2, previous: id });
  });

  it("records one escape for concurrent confirmations and excludes a later reviewer error", async () => {
    const series = "confirmed-escape";
    const report = await writeReport("escape.txt", finding(1) + finding(2));
    const saved = await record(series, report);
    const { id } = JSON.parse(saved.out);
    const roundBefore = await history(series, "--round", id);
    const flags = [...seriesFlags(series), "--round", id, "--finding", "1", "--role", "independent-reviewer",
      "--reason", "The published interface accepts the wrong value.", "--evidence", "counter.ts:1"];
    const confirm = (actor: string, ...options: string[]) =>
      run(root, "confirm", ...flags, "--actor", actor, "--practice", "counter-behavior", ...options);

    const unknown = await confirm("Reviewer A", "--practice", "missing-practice");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("missing-practice");
    expect((await confirm("Reviewer A", "--finding", "99")).code).toBe(2);

    const [first, second] = await Promise.all([confirm("Reviewer A"), confirm("Reviewer B")]);
    expect(first.code, first.err).toBe(0);
    expect(second).toEqual(first);
    expect(await confirm("Reviewer B")).toEqual(first);
    const escape = JSON.parse(first.out);
    expect(escape).toMatchObject({ kind: "escaped", round: id, head, finding: 1, practice: "counter-behavior",
      actor: expect.stringMatching(/^Reviewer [AB]$/), role: "independent-reviewer", evidence: "counter.ts:1",
    });
    expect((await confirm("Reviewer A", "--finding", "2")).code).toBe(0);
    const existingId = await confirm("Reviewer A", "--finding", "2", "--practice", " ");
    expect(existingId.code, existingId.err).toBe(0);
    expect(await confirm("Reviewer A", "--finding", "2", "--practice", " ")).toEqual(existingId);
    expect(JSON.parse((await history(series)).out)[0].signals.escapes).toEqual(expect.arrayContaining([
      escape, expect.objectContaining({ finding: 2, practice: "counter-behavior" }), JSON.parse(existingId.out),
    ]));

    const ruled = await run(root, "rule", ...flags, "--actor", "Independent reviewer", "--reason", "The finding was erroneous.");
    expect(ruled.code, ruled.err).toBe(0);
    expect(JSON.parse((await history(series)).out)[0].signals.escapes.map((item: { finding: number }) => item.finding)).toEqual([2, 2]);
    expect((await confirm("Reviewer B")).code).toBe(2);
    expect(await history(series, "--round", id)).toEqual(roundBefore);

    const reviewHome = join(home, "review");
    const records = await readdir(reviewHome, { recursive: true });
    const confirmations = records.filter((path) => path.split(sep).includes("escape-1") && path.endsWith(".json"));
    expect(confirmations).toHaveLength(3);
    const corrupt = join(reviewHome, confirmations[0]!);
    await writeFile(corrupt, "{");
    const unreadable = await history(series);
    expect(unreadable.code).toBe(2);
    expect(unreadable.err).toContain("restore the confirmation from backup");
    const replay = await record(series, report);
    expect(replay.code, replay.err).toBe(saved.code);
    expect(JSON.parse(replay.out)).toMatchObject({ id, verdict: "fail", signals: { reviewerErrors: [expect.objectContaining({ finding: 1 })] } });
    const successor = await record(series, await writeReport("escape-next.txt"), "--previous-round", id);
    expect(successor.code, successor.err).toBe(0);
    expect(JSON.parse(successor.out)).toMatchObject({ number: 2, previous: id });
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
