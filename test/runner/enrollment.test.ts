import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { serve } from "../../src/cli/daemon.js";
import { auditEnrollment, enrollmentTampering, migrateEnrollment, readEnrollments, signEnrollment } from "../../src/runner/enrollment.js";

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

function fixture() {
  const root = join(scratch, "repo");
  mkdirSync(join(root, ".warden"), { recursive: true });
  mkdirSync(join(root, "plugin"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet", "-b", "main");
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
  writeFileSync(executable, `import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
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
  expect(receipts().slice(3)[0]).toMatchObject({ kind: "tampered", detail: "changed", file: enrollmentFile });
  expect(receipts().some((r) => r.outcome === "ran")).toBe(false);
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
