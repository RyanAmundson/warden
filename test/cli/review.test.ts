import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const wardenRoot = resolve(import.meta.dirname, "../..");
const main = join(wardenRoot, "dist/src/cli/main.js");

let root: string;
let home: string;
let base: string;
let head: string;
let remoteOnly: string;

const git = (...args: string[]): string =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" }).trim();

const run = (...args: string[]): { code: number | null; out: string; err: string } => {
  const r = spawnSync("node", [main, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, WARDEN_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const REQ = "requirements.md";
const flags = (h: string): string[] => ["--capability", "gate", "--base", base, "--head", h];
const report = (h: string, ...findings: string[]): string => [`Verdict: ${findings.length === 0 ? "PASS" : "FAIL"}`, `Reviewed head: ${h}`, "", ...findings].join("\n");
const finding = (kind: string, n: number, where: string, extra = "- Spec: no"): string =>
  [`### ${kind} ${n}. Title ${n}`, ...(where === "" ? [] : [`- Where: ${where}`]), "- Reproduces on: head", extra, "- Flaky: no", "- Correction condition: it works.", ""].join("\n");
const printedBrief = (next: string): string[] => {
  const m = /warden (review brief \S.*?)(?: on the new head)?\.$/.exec(next);
  expect(m).not.toBeNull();
  return m![1]!.split(" ");
};
const nextActionOf = (text: string): string => {
  const parts = text.split("Next action: ");
  expect(parts).toHaveLength(2);
  return parts[1]!.trim();
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-review-"));
  home = await mkdtemp(join(tmpdir(), "warden-home-"));
  await mkdir(join(root, ".warden/packs/local"), { recursive: true });
  await writeFile(join(root, ".warden/config.yaml"), 'warden: "0.1.0"\nproject: p\nbase: main\npacks:\n  - id: local\n    paths: ["**/*.ts"]\ntierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }\nloopBreakerRepeats: 3\n');
  await writeFile(
    join(root, ".warden/packs/local/pack.yaml"),
    [
      "id: local", "layer: 1", "terms:", "  - id: review", "    definition: An independent look at a change.", "    bans: []",
      "practices:", "  - id: small", "    statement: Keep every change small.", "    terms: []", "    paths: []", "    conflictsWith: []", "    guardrails: []",
      "capabilities:",
      "  - id: gate", "    kind: skill", "    serves: review", "    purpose: Review a change.", "    when: Before landing.", "    upholds: [small]", "    commands: [warden review]", "    replaces: []",
      "    review: { adapter: superpowers-review, model: opus }",
      "  - id: simplify", "    kind: skill", "    serves: review", "    purpose: Find removable complexity.", "    when: Before landing.", "    upholds: [small]", "    commands: [warden review]", "    replaces: []",
      "    review: { adapter: ponytail-review, model: opus }",
      "  - id: visual-gate", "    kind: skill", "    serves: review", "    purpose: Verify the rendered interface.", "    when: Before landing UI changes.", "    upholds: [small]", "    commands: [warden review]", "    replaces: []",
      "    review: { adapter: ui-qa, model: opus }",
      "  - id: plain", "    kind: tool", "    serves: other", "    purpose: Nothing.", "    when: Never.", "    upholds: []", "    commands: [warden review]", "    replaces: []", "",
    ].join("\n"),
  );
  await writeFile(join(root, REQ), "The change adds a.\n");
  git("init", "-q", "-b", "main");
  await writeFile(join(root, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  base = git("rev-parse", "HEAD");
  await writeFile(join(root, "a.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  git("commit", "-q", "-am", "change");
  head = git("rev-parse", "HEAD");
  const origin = join(root, "..", `${root.split("/").pop()}-origin`);
  const other = join(root, "..", `${root.split("/").pop()}-other`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, other]);
  await writeFile(join(other, "z.ts"), "export const z = 1;\n");
  execFileSync("git", ["-C", other, "add", "-A"]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", other, "commit", "-q", "-m", "remote only"]);
  remoteOnly = execFileSync("git", ["-C", other, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", other, "push", "-q", "origin", "HEAD:refs/heads/other"]);
  await rm(other, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(`${root}-origin`, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const triageRun = async (name: string, text: string, ...more: string[]): Promise<ReturnType<typeof run>> => {
  await writeFile(join(root, name), text);
  return run("review", "triage", ...flags(head), "--requirements", REQ, "--report", name, ...more);
};

describe("warden review", () => {
  it("tells the reader how to recover when Git is unavailable", () => {
    const r = spawnSync(process.execPath, [main, "review", "brief", ...flags("HEAD"), "--requirements", REQ], {
      cwd: root,
      env: { ...process.env, WARDEN_HOME: home, PATH: home },
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(nextActionOf(r.stderr)).toBe("install git and put it on PATH, then run the command again");
  });

  it("brief prints the Agent invocation for the resolved head", () => {
    const r = run("review", "brief", ...flags("HEAD"), "--requirements", REQ);
    expect(r.code).toBe(0);
    const call = JSON.parse(r.out) as { tool: string; input: { model: string; prompt: string } };
    expect(call.tool).toBe("Agent");
    expect(call.input.model).toBe("opus");
    expect(call.input.prompt).toContain(head);
    expect(call.input.prompt).toContain("Keep every change small.");
  });

  it("routes a Ponytail capability through brief and records an unfixed finding in triage", async () => {
    const flags = ["--capability", "simplify", "--base", base, "--head", head, "--requirements", REQ];
    const first = "a.ts:L2-3: shrink: Manual expansion. Use an array mapping function.";
    const previous = "ponytail-first.txt";
    const current = "ponytail-followup.txt";
    await writeFile(join(root, previous), `Reviewed head: ${base}\n${first}\nnet: -4 lines possible.\n`);
    await writeFile(join(root, current), `Reviewed head: ${head}\n${first} [earlier 1]\nnet: -4 lines possible.\n`);
    const round = ["--previous-head", base, "--previous-report", previous];
    const brief = run("review", "brief", ...flags, ...round);
    expect(brief.code, brief.err).toBe(0);
    const prompt = (JSON.parse(brief.out) as { input: { prompt: string } }).input.prompt;
    expect(prompt).toContain("Use the ponytail:ponytail-review skill");
    expect(prompt).toContain("1. shrink: Manual expansion (a.ts:2)");
    expect(run("review", "triage", ...flags, ...round, "--report", current)).toMatchObject({
      code: 1,
      out: expect.stringContaining("BLOCK 1 unfixed a.ts:2  shrink: Manual expansion"),
    });

    await writeFile(join(root, previous), `Reviewed head: ${base}\nTruncated output.\n`);
    for (const args of [["brief"], ["triage", "--report", current]]) {
      expect(run("review", ...args, ...flags, ...round)).toMatchObject({
        code: 2,
        err: expect.stringContaining("does not contain a completed review"),
      });
    }
  });

  it("routes the visual gate checklist through the packaged CLI", async () => {
    const scope = ["--capability", "visual-gate", "--base", base, "--head", head, "--requirements", REQ];
    const brief = run("review", "brief", ...scope);
    expect(brief.code, brief.err).toBe(0);
    const prompt = (JSON.parse(brief.out) as { input: { prompt: string } }).input.prompt;
    expect(prompt).toContain("Use the ui-qa skill");
    expect(prompt).toContain(head);
    const checklist = readFileSync(new URL("../fixtures/review/ui-qa/report.txt", import.meta.url), "utf8")
      .replace(/^Reviewed head: .*$/m, `Reviewed head: ${head}`);
    const filename = "visual-gate.txt";
    await writeFile(join(root, filename), checklist);
    const result = run("review", "triage", ...scope, "--report", filename, "--format", "json");
    expect(result.code, result.err).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      verdict: "fail",
      findings: [{ kind: "spec-unmet", blocks: true, title: "Runs · Overflow and clipping", evidence: ["shots/runs-narrow.png"] }],
    });
  });

  it("triage of a passing report exits 0 with no next action", async () => {
    const r = await triageRun("pass.md", report(head));
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("Next action");
  });

  it("triage of a blocking report exits 1, and its printed brief lists the previous findings", async () => {
    const r = await triageRun("fail.md", report(head, finding("Important", 1, "a.ts:2", "- Spec: yes")));
    expect(r.code).toBe(1);
    expect(r.out).toContain("BLOCK 1 spec-unmet a.ts:2  Title 1");
    const next = nextActionOf(r.out);
    expect(next).toContain(`--head HEAD --previous-head ${head} --previous-report fail.md --requirements ${REQ} on the new head.`);
    const printed = printedBrief(next);
    const brief = run(...printed);
    expect(brief.code).toBe(0);
    const prompt = (JSON.parse(brief.out) as { input: { prompt: string } }).input.prompt;
    expect(prompt).toContain("This is a later round");
    expect(prompt).toContain("1. Title 1 (a.ts:2)");
  });

  it("triage of an unfixed finding from an earlier round blocks", async () => {
    const r = await triageRun("unfixed.md", report(head, finding("Important", 1, "a.ts:2", "- Earlier: 1")));
    expect(r.code).toBe(1);
    expect(r.out).toContain("BLOCK 1 unfixed a.ts:2  Title 1");
  });

  it("triage of a failing report without --requirements exits 2 and its next action runs", async () => {
    await writeFile(join(root, "norequirements.md"), report(head, finding("Important", 1, "a.ts:2", "- Spec: yes")));
    const r = run("review", "triage", ...flags(head), "--report", "norequirements.md");
    expect(r.code).toBe(2);
    expect(nextActionOf(r.err)).toBe("run warden review triage again with --requirements <paths...>");
    expect(run("review", "triage", ...flags(head), "--report", "norequirements.md", "--requirements", REQ).code).toBe(1);
  });

  it("triage of an environment report exits 2, and its printed rerun stays in round 1 over the whole change", async () => {
    const r = await triageRun("env.md", report(head, finding("Environment", 1, "")));
    expect(r.code).toBe(2);
    expect(r.out).toContain("ENV 1 env -  Title 1");
    const next = nextActionOf(r.out);
    expect(next).toContain(`--head ${head} --requirements ${REQ}.`);
    expect(next).not.toContain("--previous-head");
    const brief = run(...printedBrief(next));
    expect(brief.code).toBe(0);
    const prompt = (JSON.parse(brief.out) as { input: { prompt: string } }).input.prompt;
    expect(prompt).toContain("This is round 1");
    expect(prompt).toContain(`${base}..${head}`);
  });

  it.each([
    ["environment", finding("Environment", 2, "")],
    ["flake", finding("Minor", 2, "").replace("- Flaky: no", "- Flaky: yes")],
  ])("a mixed blocking and %s report reruns the original review scope", async (kind, operational) => {
    const r = await triageRun(`mixed-${kind}.md`, report(head, finding("Important", 1, "a.ts:2"), operational));
    expect(r.code).toBe(2);
    expect(r.out).toContain("BLOCK 1 touched");
    const brief = run(...printedBrief(nextActionOf(r.out)));
    expect(brief.code).toBe(0);
    const prompt = (JSON.parse(brief.out) as { input: { prompt: string } }).input.prompt;
    expect(prompt).toContain("This is round 1");
    expect(prompt).toContain(`${base}..${head}`);
  });

  it("a later-round environment report prints a rerun with the same previous head and report", async () => {
    await writeFile(join(root, "round1.md"), report(base, finding("Important", 1, "a.ts:2")));
    const r = await triageRun("env2.md", report(head, finding("Environment", 1, "")), "--previous-head", base, "--previous-report", "round1.md");
    expect(r.code).toBe(2);
    const next = nextActionOf(r.out);
    expect(next).toContain(`--head ${head} --previous-head ${base} --previous-report round1.md --requirements ${REQ}.`);
    const brief = run(...printedBrief(next));
    expect(brief.code).toBe(0);
    const prompt = (JSON.parse(brief.out) as { input: { prompt: string } }).input.prompt;
    expect(prompt).toContain(`${base}..${head}`);
    expect(prompt).toContain("1. Title 1 (a.ts:2)");
  });

  it("triage with --previous-head and no --previous-report exits 2, and its next action runs", async () => {
    await writeFile(join(root, "round1.md"), report(base, finding("Important", 1, "a.ts:2")));
    await writeFile(join(root, "pass.md"), report(head));
    const r = run("review", "triage", ...flags(head), "--report", "pass.md", "--previous-head", base);
    expect(r.code).toBe(2);
    expect(nextActionOf(r.err)).toBe("run the command again with --previous-report <file>, the previous round's report");
    expect(run("review", "triage", ...flags(head), "--report", "pass.md", "--previous-head", base, "--previous-report", "round1.md").code).toBe(0);
  });

  it("triage json feeds the next brief as --previous", async () => {
    const r = await triageRun("json.md", report(head, finding("Important", 1, "a.ts:2", "- Spec: yes")), "--format", "json");
    expect(r.code).toBe(1);
    await writeFile(join(root, "triage.json"), r.out);
    const next = run("review", "brief", ...flags("HEAD"), "--requirements", REQ, "--previous-head", base, "--previous", "triage.json");
    expect(next.code).toBe(0);
    expect((JSON.parse(next.out) as { input: { prompt: string } }).input.prompt).toContain("1. Title 1 (a.ts:2)");
  });

  it("brief refuses --previous without --previous-head, and its next action runs", () => {
    const r = run("review", "brief", ...flags("HEAD"), "--requirements", REQ, "--previous", "triage.json");
    expect(r.code).toBe(2);
    expect(nextActionOf(r.err)).toContain("--previous-head <ref>");
    expect(run("review", "brief", ...flags("HEAD"), "--requirements", REQ, "--previous-head", base, "--previous", "triage.json").code).toBe(0);
  });

  it("brief refuses --previous-report without --previous-head, and a previous file of the wrong shape, and each next action runs", async () => {
    const noHead = run("review", "brief", ...flags("HEAD"), "--requirements", REQ, "--previous-report", "round1.md");
    expect(noHead.code).toBe(2);
    expect(nextActionOf(noHead.err)).toContain("--previous-head <ref>");
    expect(run("review", "brief", ...flags("HEAD"), "--requirements", REQ, "--previous-head", base, "--previous-report", "round1.md").code).toBe(0);
    await writeFile(join(root, "bad.json"), '{"findings":[{}]}');
    const bad = run("review", "brief", ...flags("HEAD"), "--requirements", REQ, "--previous-head", base, "--previous", "bad.json");
    expect(bad.code).toBe(2);
    expect(nextActionOf(bad.err)).toBe("save the reviewer's triage --format json output to bad.json, then run the command again");
    await writeFile(join(root, "bad.json"), readFileSync(join(root, "triage.json")));
    expect(run("review", "brief", ...flags("HEAD"), "--requirements", REQ, "--previous-head", base, "--previous", "bad.json").code).toBe(0);
    const both = run("review", "brief", ...flags("HEAD"), "--requirements", REQ, "--previous-head", base, "--previous", "bad.json", "--previous-report", "round1.md");
    expect(both.code).toBe(2);
    expect(nextActionOf(both.err)).toBe("run the command again with only one of them");
  });

  it("an unknown capability exits 2, and the printed command exits 0", () => {
    for (const capability of ["nope", "plain"]) {
      const r = run("review", "brief", "--capability", capability, "--base", base, "--head", head, "--requirements", REQ);
      expect(r.code).toBe(2);
      const printed = /Next action: run warden (review brief .*)$/m.exec(r.err);
      expect(printed).not.toBeNull();
      expect(run(...printed![1]!.split(" ")).code).toBe(0);
    }
  });

  it("an unknown capability without --requirements exits 2, and its next action runs", () => {
    const r = run("review", "triage", "--capability", "nope", "--base", base, "--head", head, "--report", "pass.md");
    expect(r.code).toBe(2);
    expect(nextActionOf(r.err)).toBe("run the command again with --capability gate and --requirements <paths...>");
    expect(run("review", "triage", "--capability", "gate", "--base", base, "--head", head, "--report", "pass.md", "--requirements", REQ).code).toBe(0);
  });

  it("a head that is not a commit exits 2, and the fetch action makes it resolve", () => {
    const r = run("review", "brief", ...flags(remoteOnly), "--requirements", REQ);
    expect(r.code).toBe(2);
    const action = nextActionOf(r.err);
    expect(action).toBe(`run git fetch origin ${remoteOnly}, then run the command again`);
    git("fetch", "origin", remoteOnly);
    expect(run("review", "brief", ...flags(remoteOnly), "--requirements", REQ).code).toBe(0);
  });

  it("an unreadable report exits 2, and saving it makes the command run", async () => {
    const r = run("review", "triage", ...flags(head), "--report", "late.md");
    expect(r.code).toBe(2);
    expect(nextActionOf(r.err)).toBe("save the reviewer's report to late.md, then run the command again");
    await writeFile(join(root, "late.md"), report(head));
    expect(run("review", "triage", ...flags(head), "--report", "late.md").code).toBe(0);
  });

  it("a missing flag exits 2, and the named flags make the command run", () => {
    const r = run("review", "triage", "--capability", "gate");
    expect(r.code).toBe(2);
    expect(nextActionOf(r.err)).toBe("run warden review triage again with --base <ref>, --head <ref>, --report <file>");
    expect(run("review", "triage", "--capability", "gate", "--base", base, "--head", head, "--report", "pass.md").code).toBe(0);
  });
});
