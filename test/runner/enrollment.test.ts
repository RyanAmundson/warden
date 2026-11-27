import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { serve } from "../../src/cli/daemon.js";
import { type Evidence, appendEvidence } from "../../src/runner/evidence.js";
import { auditEnrollment, checkCandidate, compileEnrollment, enrollmentTampering, migrateEnrollment, readEnrollments, signEnrollment } from "../../src/runner/enrollment.js";

const wardenRoot = resolve(import.meta.dirname, "../..");
const ref = "refs/remotes/origin/main";
const config = `project: sample
base: origin/main
packs: []
tierBudgetMs: { edit: 2000, commit: 10000, boundary: 120000 }
loopBreakerRepeats: 3
`;
const baseline = { "warden-a": { "src/a.ts": 3, "src/b.ts": 2 }, "warden-b": { "src/a.ts": 4 } };

let scratch: string;
let home: string | undefined;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "warden-enrollment-test-")));
  home = process.env.WARDEN_HOME;
  process.env.WARDEN_HOME = join(scratch, "home");
});
afterEach(() => {
  if (home === undefined) delete process.env.WARDEN_HOME;
  else process.env.WARDEN_HOME = home;
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(format = "sha1") {
  const root = join(scratch, "repo");
  mkdirSync(join(root, ".warden"), { recursive: true });
  mkdirSync(join(root, "plugin"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet", "--object-format", format, "-b", "main");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Fixture");
  git("config", "core.hooksPath", join(scratch, "no-hooks"));
  writeFileSync(join(root, ".warden", "config.yaml"), config);
  writeFileSync(join(root, ".warden", "baseline.json"), JSON.stringify(baseline));
  writeFileSync(join(root, "plugin", "contracts.lock.json"), '{"from":"repo"}');
  const source = join(root, "example.txt");
  const commit = (content: string) => {
    writeFileSync(source, content);
    git("add", ".");
    git("commit", "--quiet", "-m", content);
    return git("rev-parse", "HEAD");
  };
  const key = join(scratch, "owner");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "owner", "-f", key]);
  const signers = join(scratch, "signers");
  writeFileSync(signers, `owner ${readFileSync(`${key}.pub`, "utf8")}`);
  const state = () => [git("status", "--porcelain", "--ignored"), git("for-each-ref"), readdirSync(root).sort().join(",")];
  return { root, git, commit, key, signers, source, state };
}

const fakeAudit = (scratchDir: string) => {
  const executable = join(scratchDir, "audit.mjs");
  writeFileSync(executable, `import { chmodSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [, , command, , tier, , base] = process.argv;
if (command !== "audit") process.exit(23);
if (process.env.WARDEN_TEST_FAILED_TIER === tier) {
  process.stderr.write("fixture refused");
  process.exit(17);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--untracked-files=no")) process.exit(24);
if (git("rev-parse", "HEAD^") !== base) process.exit(25);
const evidence = process.env.WARDEN_HOME + "/evidence";
mkdirSync(evidence, { recursive: true });
writeFileSync(evidence + "/sample.jsonl", JSON.stringify({
  kind: "cost", guardrail: "run", at: new Date().toISOString(), tier, base, outcome: "ran", exit: 0,
  detail: readFileSync("example.txt", "utf8"),
  policy: readFileSync(".warden/config.yaml", "utf8"),
  data: readFileSync("plugin/contracts.lock.json", "utf8"),
  leaked: [".warden/extra.txt", "plugin/other.lock.json"].filter((file) => existsSync(file)),
}));
`);
  return executable;
};

const enroll = async (f: ReturnType<typeof fixture>) => {
  f.git("update-ref", ref, "HEAD");
  const migrated = await migrateEnrollment(f.root, ref, "main", wardenRoot, ["plugin/*.lock.json"], []);
  const enrolled = readEnrollments().get("sample");
  if (enrolled === undefined) throw new Error("not enrolled");
  return { migrated, enrolled };
};

const receipts = () => readFileSync(join(process.env.WARDEN_HOME as string, "evidence", "sample.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

test("migrates an in-repo enrollment into WARDEN_HOME with the same baseline counts and leaves the repository as it was", { timeout: 120_000 }, async () => {
  const f = fixture();
  f.commit("enrolled");
  f.git("update-ref", ref, "HEAD");
  const before = f.state();
  const { migrated, enrolled } = await enroll(f);
  expect(migrated).toMatchObject({ project: "sample", gaps: 9, sourceGaps: 9 });
  expect(JSON.parse(readFileSync(join(enrolled.dir, "policy", "baseline.json"), "utf8"))).toEqual(baseline);
  expect(readFileSync(join(enrolled.dir, "data", "plugin", "contracts.lock.json"), "utf8")).toBe('{"from":"repo"}');
  expect(JSON.parse(readFileSync(join(enrolled.dir, "policy", "lock.json"), "utf8"))).toMatchObject({ config: { project: "sample" } });
  expect(enrolled).toMatchObject({ project: "sample", root: f.root, ref, data: ["plugin/*.lock.json"], links: [] });
  expect(f.state()).toEqual(before);
});

test("audits the enrolled ref in a temporary checkout that holds only the enrolled policy and data, and writes nothing to the repository", { timeout: 120_000 }, async () => {
  const f = fixture();
  f.commit("enrolled");
  const { enrolled } = await enroll(f);
  writeFileSync(join(enrolled.dir, "policy", "config.yaml"), `${config}# enrolled\n`);
  writeFileSync(join(enrolled.dir, "data", "plugin", "contracts.lock.json"), '{"from":"warden home"}');
  signEnrollment(enrolled.dir, f.key);
  const base = f.commit("base");
  writeFileSync(join(f.root, ".warden", "config.yaml"), "project: repo-policy\n");
  writeFileSync(join(f.root, "plugin", "contracts.lock.json"), '{"from":"repo edit"}');
  const first = f.commit("published");
  f.git("update-ref", ref, first);
  const next = f.commit("next");
  writeFileSync(f.source, "dirty");
  const before = f.state();
  const opts = { wardenRoot, executable: fakeAudit(scratch), signers: f.signers, once: true };
  expect(await auditEnrollment(enrolled, opts)).toBe(true);
  const common = { root: f.root, ref, packs: [], trigger: "main audit", exit: 0, policy: `${config}# enrolled\n`, data: '{"from":"warden home"}' };
  expect(receipts()).toMatchObject([
    { ...common, tier: "edit", detail: "published", commit: first, base },
    { ...common, tier: "boundary", detail: "published", commit: first, base },
  ]);
  f.git("update-ref", ref, next);
  const moved = f.state();
  expect(await auditEnrollment(enrolled, opts)).toBe(true);
  expect(receipts().slice(2)).toMatchObject([
    { ...common, tier: "edit", detail: "next", commit: next, base: first },
    { ...common, tier: "boundary", detail: "next", commit: next, base: first },
  ]);
  expect(f.state()).toEqual(moved);
  expect(before[0]).toBe(moved[0]);
  expect(readFileSync(f.source, "utf8")).toBe("dirty");
  f.git("update-ref", ref, base);
  await expect(auditEnrollment(enrolled, opts)).rejects.toThrow("no longer descends from");
  expect(receipts()).toHaveLength(4);
});

test("runs the real warden audit against a migrated, signed enrollment", { timeout: 120_000 }, async () => {
  const f = fixture();
  f.commit("enrolled");
  const { enrolled } = await enroll(f);
  signEnrollment(enrolled.dir, f.key);
  f.git("update-ref", ref, f.commit("published"));
  const before = f.state();
  expect(await auditEnrollment(enrolled, { wardenRoot, signers: f.signers, once: true })).toBe(true);
  expect(receipts().filter((r) => r.kind === "cost")).toMatchObject([
    { tier: "edit", exit: 0, root: f.root, ref, trigger: "main audit" },
    { tier: "boundary", exit: 0, root: f.root, ref, trigger: "main audit" },
  ]);
  expect(receipts().every((r) => r.outcome !== "error" && r.outcome !== "tampered")).toBe(true);
  expect(f.state()).toEqual(before);
});

test.each(["sha1", "sha256"])("checks a contributed rule on exact %s commits without enrolling a linked checkout", { timeout: 120_000 }, async (format) => {
  const f = fixture(format);
  const base = f.commit("enrolled");
  const { enrolled } = await enroll(f);
  const policy = join(enrolled.dir, "policy");
  const pack = join(policy, "packs", "fixture-pack");
  mkdirSync(pack, { recursive: true });
  writeFileSync(join(policy, "config.yaml"), config.replace("packs: []", "packs: [{ id: fixture-pack, paths: [\"**/*\"] }]"));
  writeFileSync(join(pack, "pack.yaml"), `id: fixture-pack
layer: 10
terms: []
practices:
  - id: fixture-layout
    statement: Tracked files must stay out of unclassified folders.
    terms: []
    paths: []
    conflictsWith: []
    guardrails:
      - id: fixture-source-layout
        kind: lint
        runs: [boundary]
        budgetMs: 5000
        version: 1
        implementation: "fs:fixture-pack/layout"
        scope: project
        mustPass: { "src/ok.js": "export {}" }
        mustFail: { "unexpected/bad.js": "export {}" }
`);
  writeFileSync(join(pack, "fs.js"), `export default {
    layout({ files }) {
      return files.filter((file) => file.startsWith("unexpected/")).map((file) => ({ file, message: "Unclassified source." }));
    }
  };`);
  await compileEnrollment(enrolled.dir, wardenRoot);
  signEnrollment(enrolled.dir, f.key);
  const good = f.commit("valid");
  mkdirSync(join(f.root, "unexpected"));
  writeFileSync(join(f.root, "unexpected", "bad.js"), "export {}");
  const bad = f.commit("invalid");
  const linked = join(scratch, "linked");
  f.git("worktree", "add", "--detach", linked, good);
  writeFileSync(join(linked, "example.txt"), "dirty linked checkout");
  const opts = { wardenRoot, signers: f.signers };
  const run = (candidate: string, rule = "fixture-source-layout") =>
    checkCandidate("sample", linked, ref, base, candidate, rule, opts);
  const unrelated = join(enrolled.dir, "..", "unrelated");
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, "enrollment.json"), '{"project":"unrelated"}');
  expect(await run(good)).toMatchObject({ version: 1, base, candidate: good, result: "pass" });
  expect(await checkCandidate("unrelated", linked, ref, base, good, "fixture-source-layout", opts)).toMatchObject({ result: "error" });
  expect(await run(bad)).toMatchObject({ base, candidate: bad, result: "fail", findings: [{ file: "unexpected/bad.js" }] });
  expect(await run(bad, "unknown-rule")).toMatchObject({ result: "error" });
  expect(await run("HEAD")).toMatchObject({ result: "error" });
  expect(await checkCandidate("sample", scratch, ref, base, good, "fixture-source-layout", opts)).toMatchObject({ result: "error" });
  expect(await checkCandidate("sample", linked, ref, base, good, "fixture-source-layout", { ...opts, executable: "/missing-warden" })).toMatchObject({ result: "error" });
  expect(existsSync(join(enrolled.dir, "checkpoint.json"))).toBe(false);
  expect(existsSync(join(process.env.WARDEN_HOME as string, "evidence"))).toBe(false);
  expect(readFileSync(join(linked, "example.txt"), "utf8")).toBe("dirty linked checkout");
  expect(f.git("rev-parse", ref)).toBe(base);
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  const keygen = execFileSync("sh", ["-c", "command -v ssh-keygen"], { encoding: "utf8" }).trim();
  const path = process.env.PATH;
  const mutation = join(bin, "ssh-keygen");
  writeFileSync(mutation, `#!/bin/sh
"${keygen}" "$@" || exit $?
if [ "$1 $2" = "-Y verify" ]; then
  printf '%s\n' 'export default { layout: () => [] };' > "${join(pack, "fs.js")}"
fi
`);
  chmodSync(mutation, 0o755);
  process.env.PATH = `${bin}:${path}`;
  try {
    expect(await run(bad)).toMatchObject({ result: "fail", findings: [{ file: "unexpected/bad.js" }] });
  } finally {
    process.env.PATH = path;
  }
  writeFileSync(join(pack, "fs.js"), "export default { layout: () => [] };");
  expect(await run(bad)).toMatchObject({ result: "error", message: expect.stringContaining("Invalid enrollment") });
  const externalPolicy = join(scratch, "external-policy");
  renameSync(policy, externalPolicy);
  symlinkSync(externalPolicy, policy);
  expect(await run(bad)).toMatchObject({ result: "error", message: expect.stringContaining("regular files and directories") });
});

test("reports a tampered enrollment instead of auditing it, and accepts a lowered baseline without a new signature", { timeout: 120_000 }, async () => {
  const f = fixture();
  f.commit("enrolled");
  const { enrolled } = await enroll(f);
  const { dir } = enrolled;
  const executable = fakeAudit(scratch);
  const opts = { wardenRoot, executable, signers: f.signers, once: true };
  f.git("update-ref", ref, f.commit("published"));
  expect(enrollmentTampering(dir, f.signers)).toMatchObject([{ detail: "unsigned" }]);
  expect(await auditEnrollment(enrolled, opts)).toBe(false);
  expect(receipts()).toMatchObject([
    { kind: "tampered", detail: "unsigned", ref },
    { kind: "cost", tier: "edit", outcome: "tampered", exit: 0, next: expect.stringContaining("warden enroll sign") },
    { kind: "cost", tier: "boundary", outcome: "tampered", exit: 0 },
  ]);
  expect(await auditEnrollment(enrolled, opts)).toBe(false);
  expect(receipts()).toHaveLength(3);

  const stranger = join(scratch, "stranger");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "stranger", "-f", stranger]);
  signEnrollment(dir, stranger);
  expect(enrollmentTampering(dir, f.signers)).toMatchObject([{ detail: "untrusted-signature" }]);

  signEnrollment(dir, f.key);
  expect(enrollmentTampering(dir, f.signers)).toEqual([]);
  const file = join(dir, "policy", "baseline.json");
  writeFileSync(file, JSON.stringify({ "warden-a": { "src/a.ts": 1 }, "warden-b": { "src/a.ts": 4 } }));
  expect(enrollmentTampering(dir, f.signers)).toEqual([]);
  expect(await auditEnrollment(enrolled, opts)).toBe(true);
  expect(receipts().slice(3)).toMatchObject([{ tier: "edit", outcome: "ran" }, { tier: "boundary", outcome: "ran" }]);
  f.git("update-ref", ref, f.commit("after the lowered baseline"));
  writeFileSync(file, JSON.stringify({ ...baseline, "warden-b": { "src/a.ts": 5 } }));
  expect(enrollmentTampering(dir, f.signers)).toEqual([{ file, detail: "loosened", guardrail: "warden-b" }]);
  writeFileSync(file, JSON.stringify({ ...baseline, "warden-c": { "src/c.ts": 1 } }));
  expect(enrollmentTampering(dir, f.signers)).toEqual([{ file, detail: "loosened", guardrail: "warden-c" }]);
  writeFileSync(file, JSON.stringify(baseline));
  writeFileSync(join(dir, "policy", "config.yaml"), config.replace("packs: []", "packs: []\nmode: audit"));
  writeFileSync(join(dir, "data", "plugin", "extra.lock.json"), "{}");
  rmSync(join(dir, "data", "plugin", "contracts.lock.json"));
  expect(enrollmentTampering(dir, f.signers).map((t) => [t.file.slice(dir.length + 1), t.detail])).toEqual([
    ["data/plugin/contracts.lock.json", "removed"],
    ["data/plugin/extra.lock.json", "added"],
    ["policy/config.yaml", "changed"],
  ]);
  const enrollmentFile = join(dir, "enrollment.json");
  writeFileSync(enrollmentFile, JSON.stringify({ ...JSON.parse(readFileSync(enrollmentFile, "utf8")), data: [] }));
  expect(enrollmentTampering(dir, f.signers)[0]).toEqual({ file: enrollmentFile, detail: "changed" });
  expect(await auditEnrollment(readEnrollments().get("sample")!, opts)).toBe(false);
  expect(receipts().slice(5)[0]).toMatchObject({ kind: "tampered", detail: "changed", file: enrollmentFile });
  expect(receipts().filter((r) => r.outcome === "ran")).toHaveLength(2);
});

test("keeps repository files that differ from the enrolled paths only in case out of the checkout", { timeout: 120_000 }, async () => {
  const f = fixture();
  f.commit("enrolled");
  const { enrolled } = await enroll(f);
  signEnrollment(enrolled.dir, f.key);
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: f.root, input: "planted", encoding: "utf8" }).trim();
  for (const path of [".WARDEN/extra.txt", "Plugin/other.lock.json"]) f.git("update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
  f.git("commit", "--quiet", "-m", "case collisions");
  f.git("update-ref", ref, f.git("rev-parse", "HEAD"));
  expect(await auditEnrollment(enrolled, { wardenRoot, executable: fakeAudit(scratch), signers: f.signers, once: true })).toBe(true);
  expect(receipts()).toMatchObject([{ tier: "edit", leaked: [] }, { tier: "boundary", leaked: [] }]);
});

test("makes an executable failure visible for both tiers and keeps missed changes in a tier's comparison", { timeout: 120_000 }, async () => {
  const f = fixture();
  f.commit("enrolled");
  const { enrolled } = await enroll(f);
  signEnrollment(enrolled.dir, f.key);
  const base = f.commit("base");
  const missed = f.commit("missed boundary");
  f.git("update-ref", ref, missed);
  const opts = { wardenRoot, executable: fakeAudit(scratch), signers: f.signers, once: true };
  process.env.WARDEN_TEST_FAILED_TIER = "boundary";
  try {
    expect(await auditEnrollment(enrolled, opts)).toBe(false);
  } finally {
    delete process.env.WARDEN_TEST_FAILED_TIER;
  }
  expect(receipts()).toMatchObject([
    { tier: "edit", exit: 0, outcome: "ran", base, commit: missed },
    { tier: "boundary", exit: 17, outcome: "error", next: "fixture refused", base, commit: missed },
  ]);
  const latest = f.commit("latest");
  f.git("update-ref", ref, latest);
  expect(await auditEnrollment(enrolled, opts)).toBe(true);
  expect(receipts().slice(2)).toMatchObject([
    { tier: "edit", exit: 0, base: missed, commit: latest },
    { tier: "boundary", exit: 0, base, commit: latest },
  ]);
});

test("the daemon audits each enrolled ref on its own", { timeout: 120_000 }, async () => {
  const f = fixture();
  f.commit("enrolled");
  await enroll(f);
  f.git("update-ref", ref, f.commit("published"));
  const dashboard = await serve(wardenRoot, 0, { intervalMs: 60_000 });
  try {
    const evidence = join(process.env.WARDEN_HOME as string, "evidence", "sample.jsonl");
    for (let i = 0; i < 200 && !existsSync(evidence); i++) await new Promise((r) => setTimeout(r, 50));
    expect(receipts()).toMatchObject([{ kind: "tampered", detail: "unsigned", ref, root: f.root }, { tier: "edit", outcome: "tampered" }, { tier: "boundary", outcome: "tampered" }]);
    const projects = await (await fetch(`http://127.0.0.1:${dashboard.port}/api/projects`)).json() as { projects: unknown[] };
    expect(projects.projects).toMatchObject([{ project: "sample", roots: [], mode: "audit", lastMainAudit: { root: f.root, ref } }]);
  } finally {
    await dashboard.close();
  }
});

test("the daemon records an audit that cannot start as one error receipt per tier", { timeout: 120_000 }, async () => {
  const f = fixture();
  f.commit("enrolled");
  await enroll(f);
  f.git("update-ref", "-d", ref);
  const dashboard = await serve(wardenRoot, 0, { intervalMs: 100 });
  try {
    const evidence = join(process.env.WARDEN_HOME as string, "evidence", "sample.jsonl");
    for (let i = 0; i < 200 && !existsSync(evidence); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 500));
    expect(receipts()).toMatchObject([
      { tier: "edit", outcome: "error", ref, root: f.root, next: expect.stringContaining(ref) },
      { tier: "boundary", outcome: "error", ref },
    ]);
  } finally {
    await dashboard.close();
  }
});

test("publishes validated ESLint evidence to the existing project and notifies its subscribers", async () => {
  const publisher = new URL("../../dist/src/cli/publish.js", import.meta.url).href;
  const { publishESLint } = await import(publisher) as {
    publishESLint: (project: string, report: string, snapshot: string, wardenRoot: string) => Evidence;
  };
  const f = fixture();
  const oldCommit = f.commit("enrolled");
  const { enrolled } = await enroll(f);
  signEnrollment(enrolled.dir, f.key);
  const linked = join(scratch, "linked");
  f.git("worktree", "add", "--detach", linked, oldCommit);
  const report = join(scratch, "eslint.json");
  const entry = {
    filePath: join(linked, "example.txt"), errorCount: 1, warningCount: 0,
    messages: [{ severity: 2, ruleId: "checker/rule", line: 1, message: "Fix this." }],
  };
  const ignored = {
    filePath: join(linked, "plugin", "contracts.lock.json"), errorCount: 0, warningCount: 1,
    messages: [{ severity: 1, ruleId: null, message: "File ignored because no matching configuration was supplied." }],
  };
  writeFileSync(report, JSON.stringify([entry, ignored]));
  const signersRoot = join(scratch, "warden");
  mkdirSync(signersRoot);
  writeFileSync(join(signersRoot, "trust_signers"), readFileSync(f.signers));
  const served = await serve(wardenRoot, 0, { enrolledAudits: false });
  try {
    const base = `http://127.0.0.1:${served.port}`;
    const projects = async () => (await (await fetch(`${base}/api/projects`)).json()).projects;
    const watches = await projects();
    const before = f.state();
    const stream = await fetch(`${base}/api/events`, { signal: AbortSignal.timeout(4000) });
    const reader = stream.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (reader === undefined) throw new Error("No event stream");
    try {
      const receipt = publishESLint("sample", report, linked, signersRoot);
      expect(receipt).toMatchObject({ commit: oldCommit, ref, result: "fail", scope: "partial", exit: 0, files: 1, report: { adapter: "eslint", warnings: 0 } });
      let events = "";
      while (!events.includes('data: {"project":"sample"}')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Evidence stream closed early");
        events += chunk.value;
      }
      const detail = await (await fetch(`${base}/api/runs?project=sample&run=${receipt.run}`)).json();
      expect(detail.findings).toEqual([{ file: "example.txt", line: 1, guardrail: "checker/rule", practice: "eslint", doThis: "Fix this." }]);
      expect(await projects()).toMatchObject([{ ...watches[0], lastRun: { run: receipt.run }, mainReports: [{ run: receipt.run }] }]);
      expect(f.state()).toEqual(before);
      expect(publishESLint("sample", report, linked, signersRoot).run).toBe(receipt.run);
      expect(receipts()).toHaveLength(1);

      writeFileSync(report, JSON.stringify([ignored]));
      expect(() => publishESLint("sample", report, linked, signersRoot)).toThrow("did not check any tracked files");
      writeFileSync(report, JSON.stringify([{ ...entry, errorCount: 0 }]));
      expect(() => publishESLint("sample", report, linked, signersRoot)).toThrow("counts disagree");
      writeFileSync(report, JSON.stringify([{ ...entry, filePath: join(linked, "..", "elsewhere") }]));
      expect(() => publishESLint("sample", report, linked, signersRoot)).toThrow("outside the checked commit");
      writeFileSync(report, JSON.stringify([entry]));
      const tip = f.commit("advanced");
      f.git("update-ref", ref, tip);
      expect(() => publishESLint("sample", report, linked, signersRoot)).toThrow("does not match");
      expect(receipts()).toHaveLength(1);
      appendEvidence("sample", { ...receipt, at: new Date().toISOString() });
      const runs = await (await fetch(`${base}/api/runs?project=sample`)).json();
      expect(runs.runs.map((run: Evidence) => run.run)).toEqual([receipt.run]);
    } finally {
      await reader.cancel();
    }
  } finally {
    await served.close();
  }
}, 120_000);


test("accepts only registered project adapters using the versioned report format", async () => {
  const { publishReport } = await import("../../src/cli/publish.js");
  const f = fixture();
  const commit = f.commit("enrolled");
  const { enrolled } = await enroll(f);
  const manifest = join(enrolled.dir, "enrollment.json");
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), reportAdapters: ["project-check"] }));
  signEnrollment(enrolled.dir, f.key);
  const signersRoot = join(scratch, "warden");
  mkdirSync(signersRoot);
  writeFileSync(join(signersRoot, "trust_signers"), readFileSync(f.signers));
  const report = join(scratch, "project-report.json");
  const output = { version: 1, commit, files: ["example.txt"], warnings: 0, findings: [
    { file: "example.txt", line: 1, rule: "project-rule", message: "Fix this." },
  ] };
  writeFileSync(report, JSON.stringify(output));
  const publish = (adapter: string) => publishReport("json", adapter, "sample", report, f.root, signersRoot);
  expect(() => publish(" unregistered ")).toThrow("not registered");
  expect(publish("project-check")).toMatchObject({ commit, result: "fail", report: { adapter: "project-check", warnings: 0 } });
  writeFileSync(report, JSON.stringify({ ...output, files: ["plugin/contracts.lock.json"] }));
  expect(() => publish("project-check")).toThrow("Each finding needs a checked file");
  writeFileSync(report, JSON.stringify({ ...output, commit: "0".repeat(40) }));
  expect(() => publish("project-check")).toThrow("does not match the checked snapshot");
  writeFileSync(report, JSON.stringify({ ...output, files: [] }));
  expect(() => publish("project-check")).toThrow("version 1 Warden report");
});
