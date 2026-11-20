import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "../../bin/warden.js");
const model = {
  initial: "draft",
  states: ["draft", "ready", "done"],
  transitions: [
    { from: "draft", event: "prepare", to: "ready" },
    { from: "ready", event: "finish", to: "done" },
    { from: "ready", event: "edit", to: "draft" },
  ],
};
const trace = {
  initial: "draft",
  steps: [{ event: "prepare", state: "ready" }, { event: "finish", state: "done" }],
};

it("checks a declared workflow and its recorded transitions at the boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "warden-machines-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "pipe" });
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
  const modelFile = "workflows/publish.machine.json";
  const traceFile = "workflows/publish.trace.json";
  const write = (file: string, value: unknown) => writeFileSync(join(root, file), JSON.stringify(value));
  const check = (rule: string) => run("check", "--tier", "boundary", "--base", "main", "--rule", rule, "--format", "json");
  try {
    git("init", "-q", "-b", "main");
    mkdirSync(join(root, ".warden"));
    mkdirSync(join(root, "workflows"));
    writeFileSync(join(root, ".warden/config.yaml"), `project: machine-fixture
base: main
packs: [{ id: machines, paths: [] }]
tierBudgetMs: { edit: 2000, commit: 10000, boundary: 120000 }
loopBreakerRepeats: 3
bench: { baseFiles: 1, maxFiles: 4, minMarginalMs: 1000 }
`);
    write(modelFile, model);
    write(traceFile, trace);
    write("workflows/timing.trace.json", { traceEvents: [] });
    const compiled = run("compile");
    expect(compiled.status, compiled.stderr + compiled.stdout).toBe(0);
    git("add", ".");
    git("commit", "-qm", "Configure the publishing workflow");
    git("checkout", "-qb", "verify-publishing");

    for (const rule of ["warden-machine-tables", "warden-machine-traces"]) {
      const passed = check(rule);
      expect(passed.status, passed.stderr + passed.stdout).toBe(0);
      expect(JSON.parse(passed.stdout).failures).toEqual([]);
    }

    write(traceFile, { ...trace, steps: [...trace.steps.slice(0, 1), { event: "finish", state: "draft" }] });
    const mismatchedTrace = check("warden-machine-traces");
    expect(mismatchedTrace.status, mismatchedTrace.stderr + mismatchedTrace.stdout).toBe(1);
    expect(JSON.parse(mismatchedTrace.stdout).failures).toMatchObject([{ file: traceFile, doThis: expect.stringContaining('step 2 from state "ready"') }]);

    write(modelFile, { ...model, transitions: [...model.transitions, { from: "draft", event: "prepare", to: "done" }] });
    const ambiguousModel = check("warden-machine-tables");
    expect(ambiguousModel.status, ambiguousModel.stderr + ambiguousModel.stdout).toBe(1);
    expect(JSON.parse(ambiguousModel.stdout).failures).toMatchObject([{ file: modelFile, doThis: expect.stringContaining('one destination for event "prepare"') }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
