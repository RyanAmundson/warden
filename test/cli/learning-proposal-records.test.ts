import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { sha256 } from "../../src/compiler/lock.js";
import { recordRound, reviewRepository } from "../../src/review/history.js";

const cli = resolve(import.meta.dirname, "../../bin/warden.js");

it("only records requested proposals and reuses immutable records for the same evidence", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "warden-proposal-records-")));
  const root = join(temp, "repo");
  const home = join(temp, "warden-home");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "review", "proposals", ...args], { cwd: root, encoding: "utf8" });
  vi.stubEnv("WARDEN_HOME", home);
  try {
    const pack = join(root, ".warden/packs/local");
    await mkdir(pack, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: root });
    const config = `project: proposal-record-fixture
base: main
packs: [{ id: local, paths: [] }]
tierBudgetMs: { edit: 1000, commit: 2000, boundary: 3000 }
loopBreakerRepeats: 3
learning: { repeatFindings: 2 }
`;
    await writeFile(join(root, ".warden/config.yaml"), config);
    await writeFile(join(pack, "pack.yaml"), `id: local
layer: 100
terms: []
practices:
  - id: name-unit
    statement: Each report names its unit.
    terms: []
    paths: []
    conflictsWith: []
    guardrails: []
`);
    const repository = reviewRepository(root);
    for (const part of ["b", "c"]) {
      const text = `Report for ${part}`;
      recordRound({
        input: {
          repository, series: `report-${part}`, target: "report", capability: "review-report", previous: null,
          base: "a".repeat(40), head: part.repeat(40), warden: "0.1.14",
          settings: { adapter: "superpowers-review", model: "opus" },
          upholds: [{ id: "name-unit", statement: "Each report names its unit." }], requirements: [],
          report: { sha256: sha256(text), text },
        },
        result: {
          verdict: "fail", findings: [{
            n: 1, severity: "important", title: "Missing unit", file: "report.txt", line: 1, reproducesOn: ["head"],
            spec: true, flaky: false, correction: "Name the unit.", kind: "spec-unmet", action: "back-to-builder", blocks: true,
          }],
        },
      }, undefined);
    }
    const unsaved = run();
    expect(unsaved.status, unsaved.stderr).toBe(0);
    const records = join(home, "review/proposals", sha256(repository));
    await expect(readFile(records)).rejects.toMatchObject({ code: "ENOENT" });

    const saved = run("--record");
    expect(saved.status, saved.stderr).toBe(0);
    const output = JSON.parse(saved.stdout);
    expect(output).toMatchObject([{
      schema: 1, id: expect.stringMatching(/^[a-f0-9]{64}$/), recordedAt: expect.any(String),
      scope: { repository }, proposal: JSON.parse(unsaved.stdout)[0],
    }]);
    const file = join(records, `${output[0].id}.json`);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(output[0]);
    expect(run("--record").stdout).toBe(saved.stdout);
    expect(run().stdout).toBe(unsaved.stdout);
    expect(await readFile(join(root, ".warden/config.yaml"), "utf8")).toBe(config);

    await writeFile(file, "{\n");
    const corrupt = run("--record");
    expect(corrupt.status).toBe(2);
    expect(corrupt.stderr).toContain("Invalid proposal record");
    expect(await readFile(file, "utf8")).toBe("{\n");
  } finally {
    vi.unstubAllEnvs();
    await rm(temp, { recursive: true, force: true });
  }
});
