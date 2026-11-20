import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmod, readFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

async function reviewDirectory(series: string): Promise<string> {
  const reviewHome = join(home, "review");
  for (const name of await readdir(reviewHome)) {
    const directory = join(reviewHome, name);
    const data = JSON.parse(await readFile(join(directory, "round-1.json"), "utf8"));
    if (data.input.series === series) return directory;
  }
  throw new Error(`No review directory found for ${series}`);
}


async function writeReport(name: string, finding = "", at = head): Promise<string> {
  const file = join(temp, name);
  await writeFile(file, `Verdict: ${finding === "" ? "PASS" : "FAIL"}\nReviewed head: ${at}\n\n${finding}`);
  return file;
}

const finding = (n: number, extra = "- Spec: yes", location = "counter.ts:1") =>
  `### Minor ${n}. Counter behavior\n- Where: ${location}\n- Reproduces on: head\n${extra}\n- Correction condition: match the requirement.\n`;

const confirmIn = async (cwd: string, series: string, target: string) => {
  const scope = [...seriesFlags(series), "--target", target];
  const report = await writeReport(`${series}.txt`, finding(1));
  const saved = await run(cwd, "record", ...scope, ...reviewFlags(), "--report", report);
  expect(saved.code, saved.err).toBe(1);
  const { id } = JSON.parse(saved.out);
  const attribution = [...scope, "--round", id, "--finding", "1", "--role", "independent-reviewer",
    "--actor", "Reviewer", "--reason", "The counter missed its requirement.", "--evidence", "counter.ts:1"];
  const confirm = () => run(cwd, "confirm", ...attribution, "--practice", "counter-behavior");
  const first = await confirm();
  expect(first.code, first.err).toBe(0);
  return { attribution, escape: JSON.parse(first.out), confirm, first };
};

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
    const directory = await reviewDirectory(series);
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

  it("groups repository proposals across series and keeps each confirmation attributable", async () => {
    const proposals = () => run(root, "proposals");
    expect(await proposals()).toMatchObject({ code: 0, out: "[]\n" });
    const incomplete = await run(root, "proposals", "--series", "series-one");
    expect(incomplete.code).toBe(2);
    expect(incomplete.err).toContain("supply --series, --target and --capability");

    const [first, second] = await Promise.all([
      confirmIn(root, "series-one", "Counter"),
      confirmIn(root, "series-two", "Other target"),
    ]);
    const legacyDirectory = await reviewDirectory("series-two");
    await rm(join(legacyDirectory, "owner.json"));
    const fromWorktree = join(temp, "proposal-worktree");
    git("worktree", "add", "-q", "--detach", fromWorktree, head);
    const aggregate = await proposals();
    expect(aggregate.code, aggregate.err).toBe(0);
    expect(await run(fromWorktree, "proposals")).toEqual(aggregate);
    expect(JSON.parse(aggregate.out)).toEqual([{ action: "add", practice: "counter-behavior", evidence: expect.arrayContaining([
      { ...first.escape, series: "series-one", target: "Counter", capability: "gate" },
      { ...second.escape, series: "series-two", target: "Other target", capability: "gate" },
    ]) }]);
    expect(JSON.parse(aggregate.out)[0].evidence).toHaveLength(2);
    const config = join(root, ".warden/config.yaml");
    const original = await readFile(config);
    await writeFile(config, "project: [");
    const incompleteConfig = await proposals();
    expect(incompleteConfig).toMatchObject({ code: 0, out: aggregate.out });
    expect(incompleteConfig.err).toContain("Edit proposals are unavailable.");
    expect(incompleteConfig.err).toContain(".warden/config.yaml");
    expect(incompleteConfig.err).toContain("fix the reported Warden input");
    await writeFile(config, original);
    expect(await readdir(legacyDirectory)).not.toContain("owner.json");
    expect(await second.confirm()).toEqual(second.first);
    expect(await readdir(legacyDirectory)).toContain("owner.json");
    expect(JSON.parse((await run(root, "proposals", ...seriesFlags("series-one"))).out)[0].evidence).toEqual([first.escape]);

    const ruled = await run(root, "rule", ...first.attribution, "--reason", "Expected behavior.");
    expect(ruled.code, ruled.err).toBe(0);
    expect(JSON.parse((await proposals()).out)[0].evidence).toEqual([
      { ...second.escape, series: "series-two", target: "Other target", capability: "gate" },
    ]);

  });

  it("isolates foreign round damage and reports damage to a local round", async () => {
    const proposals = () => run(root, "proposals");
    await confirmIn(root, "local-damage", "Counter");
    const firstDirectory = await reviewDirectory("local-damage");
    const baseline = await proposals();
    expect(baseline.code, baseline.err).toBe(0);
    const clone = join(temp, "proposal-clone");
    git("clone", "-q", "--shared", root, clone);
    const unrelated = await confirmIn(clone, "unrelated-series", "Counter");
    const fromClone = await run(clone, "proposals");
    expect(fromClone.code, fromClone.err).toBe(0);
    expect(JSON.parse(fromClone.out)[0].evidence).toEqual([
      { ...unrelated.escape, series: "unrelated-series", target: "Counter", capability: "gate" },
    ]);

    const foreignDirectory = await reviewDirectory("unrelated-series");
    const foreignOwner = join(foreignDirectory, "owner.json");
    const originalForeignOwner = await readFile(foreignOwner);
    await writeFile(foreignOwner, "{");
    expect(await proposals()).toEqual(baseline);
    await writeFile(foreignOwner, originalForeignOwner);
    const foreignEscapes = join(foreignDirectory, "escape-1");
    const [foreignRecord] = await readdir(foreignEscapes);
    await writeFile(join(foreignEscapes, foreignRecord!), "{");
    await writeFile(join(foreignDirectory, "round-1.json"), "{");

    expect(await proposals()).toEqual(baseline);
    const localOwner = join(firstDirectory, "owner.json");
    const originalLocalOwner = await readFile(localOwner);
    await writeFile(localOwner, "{");
    const damagedOwner = await proposals();
    expect(damagedOwner.code).toBe(2);
    expect(damagedOwner.err).toContain("restore the series owner from backup");
    await writeFile(localOwner, originalLocalOwner);
    const firstRound = join(firstDirectory, "round-1.json");
    const original = await readFile(firstRound);
    await writeFile(firstRound, "{");
    const damaged = await proposals();
    expect(damaged.code).toBe(2);
    expect(damaged.err).toContain("restore the recorded round from backup");
    await writeFile(firstRound, original);
    await rm(foreignDirectory, { recursive: true });
  });

  it("records one escape for concurrent confirmations and excludes a later reviewer error", async () => {
    const series = "confirmed-escape";
    const proposals = (id = series) => run(root, "proposals", ...seriesFlags(id));
    expect(JSON.parse((await proposals()).out)).toEqual([]);
    const report = await writeReport("escape.txt", finding(1) + finding(2));
    const saved = await record(series, report);
    const { id } = JSON.parse(saved.out);
    const [roundBefore, empty] = await Promise.all([history(series, "--round", id), proposals()]);
    expect(JSON.parse(empty.out)).toEqual([]);
    const flags = [...seriesFlags(series), "--round", id, "--finding", "1", "--role", "independent-reviewer",
      "--reason", "The published interface accepts the wrong value.", "--evidence", "counter.ts:1"];
    const confirm = (actor: string, ...options: string[]) =>
      run(root, "confirm", ...flags, "--actor", actor, "--practice", "counter-behavior", ...options);

    const [unknown, absent] = await Promise.all([
      confirm("Reviewer A", "--practice", "missing-practice"),
      confirm("Reviewer A", "--finding", "99"),
    ]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("missing-practice");
    expect(absent.code).toBe(2);

    const [first, second] = await Promise.all([confirm("Reviewer A"), confirm("Reviewer B")]);
    expect(first.code, first.err).toBe(0);
    expect(second).toEqual(first);
    expect(await confirm("Reviewer B")).toEqual(first);
    const escape = JSON.parse(first.out);
    expect(escape).toMatchObject({ kind: "escaped", round: id, head, finding: 1, practice: "counter-behavior",
      actor: expect.stringMatching(/^Reviewer [AB]$/), role: "independent-reviewer", evidence: "counter.ts:1",
    });
    const [otherFinding, existingId] = await Promise.all([
      confirm("Reviewer A", "--finding", "2"),
      confirm("Reviewer A", "--finding", "2", "--practice", " "),
    ]);
    expect(otherFinding.code).toBe(0);
    expect(existingId.code, existingId.err).toBe(0);
    expect(await confirm("Reviewer A", "--finding", "2", "--practice", " ")).toEqual(existingId);
    expect(JSON.parse((await history(series)).out)[0].signals.escapes).toEqual(expect.arrayContaining([
      escape, expect.objectContaining({ finding: 2, practice: "counter-behavior" }), JSON.parse(existingId.out),
    ]));

    const supported = await proposals();
    expect(supported.code, supported.err).toBe(0);
    const recordsBeforeRuling = JSON.parse(supported.out);
    expect(recordsBeforeRuling).toHaveLength(2);
    expect(recordsBeforeRuling).toEqual(expect.arrayContaining([
      { action: "add", practice: "counter-behavior", evidence: expect.arrayContaining([escape, expect.objectContaining({ finding: 2, round: id, head })]) },
      { action: "add", practice: " ", evidence: [JSON.parse(existingId.out)] },
    ]));
    expect(recordsBeforeRuling.find((record: { practice: string }) => record.practice === "counter-behavior").evidence).toHaveLength(2);
    const [unchanged, unrelated] = await Promise.all([proposals(), proposals("other-change")]);
    expect(unchanged).toEqual(supported);
    expect(JSON.parse(unrelated.out)).toEqual([]);

    const ruled = await run(root, "rule", ...flags, "--actor", "Independent reviewer", "--reason", "The finding was erroneous.");
    expect(ruled.code, ruled.err).toBe(0);
    expect(JSON.parse((await history(series)).out)[0].signals.escapes.map((item: { finding: number }) => item.finding)).toEqual([2, 2]);
    const [rejected, roundAfter] = await Promise.all([confirm("Reviewer B"), history(series, "--round", id)]);
    expect(rejected.code).toBe(2);
    expect(roundAfter).toEqual(roundBefore);
    expect(JSON.parse((await proposals()).out)).toEqual(expect.arrayContaining([
      { action: "add", practice: "counter-behavior", evidence: [expect.objectContaining({ finding: 2, round: id, head })] },
      { action: "add", practice: " ", evidence: [JSON.parse(existingId.out)] },
    ]));

    const escapeDirectory = join(await reviewDirectory(series), "escape-1");
    expect(await readdir(escapeDirectory)).toHaveLength(3);
  });

  it("reports an unreadable confirmation while preserving round replay and recording", async () => {
    const series = "unreadable-confirmation";
    const report = await writeReport("unreadable-escape.txt", finding(1));
    const saved = await record(series, report);
    expect(saved.code, saved.err).toBe(1);
    const { id } = JSON.parse(saved.out);
    const flags = [...seriesFlags(series), "--round", id, "--finding", "1", "--role", "independent-reviewer",
      "--actor", "Reviewer", "--reason", "The counter missed its requirement.", "--evidence", "counter.ts:1"];
    const confirmed = await run(root, "confirm", ...flags, "--practice", "counter-behavior");
    expect(confirmed.code, confirmed.err).toBe(0);
    const ruled = await run(root, "rule", ...flags, "--reason", "Expected behavior.");
    expect(ruled.code, ruled.err).toBe(0);

    const escapeDirectory = join(await reviewDirectory(series), "escape-1");
    const [confirmation] = await readdir(escapeDirectory);
    await writeFile(join(escapeDirectory, confirmation!), "{");
    const [unreadable, replay] = await Promise.all([history(series), record(series, report)]);
    expect(unreadable.code).toBe(2);
    expect(unreadable.err).toContain("restore the confirmation from backup");
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
