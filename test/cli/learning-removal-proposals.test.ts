import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { withVerdict } from "../verdict.js";

const cli = resolve(import.meta.dirname, "../../bin/warden.js");

it("suggests removing an equivalent project rule only after distinct clean boundary runs", async () => {
  const temp = await mkdtemp(join(tmpdir(), "warden-removal-"));
  const root = join(temp, "repo");
  const env = { ...process.env, WARDEN_HOME: join(temp, "warden-home"), GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
  const check = (...args: string[]) => run("check", "--tier", "boundary", "--base", "main", ...args);
  const proposals = () => JSON.parse(run("review", "proposals"));
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", message);
    return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
  };
  const setReport = (text: string) => writeFile(join(root, "report.txt"), text);

  try {
    const pack = join(root, ".warden/packs/local");
    await mkdir(pack, { recursive: true });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Warden fixture");
    git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(root, ".warden/config.yaml"), `project: removal-fixture
base: main
packs: [{ id: local, paths: [] }]
tierBudgetMs: { edit: 1000, commit: 2000, boundary: 3000 }
loopBreakerRepeats: 3
bench: { baseFiles: 1, maxFiles: 8, minMarginalMs: 1000 }
learning: { removalRuns: 2 }
`);
    await writeFile(join(pack, "fs.js"), `export default {
  "report-units": ({ files, read }) => files.includes("report.txt") && !read("report.txt").startsWith("Units:")
    ? [{ file: "report.txt", message: "Declare the unit on the first line." }] : [],
};
`);
    const rules = ["primary-check", "duplicate-check"].map((id) => `      - id: ${id}
        kind: lint
        scope: project
        runs: [boundary]
        budgetMs: 750
        version: 1
        implementation: "fs:local/report-units"
        mustPass: { report.txt: "Units: meters" }
        mustFail: { report.txt: "meters" }
`);
    await writeFile(join(pack, "pack.yaml"), `id: local
layer: 100
terms: []
practices:
  - id: declare-units
    statement: Declare the unit on the first line.
    terms: []
    paths: []
    conflictsWith: []
    guardrails:
${rules.join("")}`);
    await setReport("Units: meters");
    run("compile");
    const first = commit("Add the project");
    check();
    check();
    expect(commit("Repeat the same project tree").tree).toBe(first.tree);
    check();
    expect(proposals()).toEqual([]);

    await setReport("Units: seconds");
    check();
    expect(proposals()).toEqual([]);
    const second = commit("Update the report");
    check("--rule", "primary-check");
    expect(proposals()).toEqual([]);

    check();
    const policyLock = join(root, ".warden/lock.json");
    const policyBefore = await readFile(policyLock, "utf8");
    const suggestion = proposals();
    expect(suggestion).toMatchObject([{
      action: "remove", pack: "local", practice: "declare-units", guardrail: "duplicate-check",
      replacement: "primary-check", approval: "policy-signer",
      evidence: [{ kind: "equivalent-coverage", policy: expect.stringMatching(/^[a-f0-9]{64}$/), runs: [
        expect.objectContaining({ tree: first.tree, run: expect.any(String) }),
        expect.objectContaining({ ...second, run: expect.any(String) }),
      ] }],
    }]);
    expect(await readFile(policyLock, "utf8")).toBe(policyBefore);
    expect(git("status", "--porcelain")).toBe("");

    await setReport("seconds");
    const blocked = withVerdict(["check"], spawnSync(process.execPath, [cli, "check", "--tier", "boundary", "--base", "main", "--format", "json"], { cwd: root, env, encoding: "utf8" }));
    expect(blocked.status, blocked.stderr + blocked.stdout).toBe(1);
    expect(JSON.parse(blocked.stdout).failures).toHaveLength(2);
    expect(proposals()).toEqual([]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 15000);
