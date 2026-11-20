import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { expect, it } from "vitest";
import { eslintAdapter } from "../src/adapters/eslint.js";
import { loadRecords } from "../src/records/load.js";
import { runGuardrails } from "../src/runner/run.js";

const repo = resolve(import.meta.dirname, "..");
const config = [
  "warden: 0.1.0",
  "project: warden",
  "base: main",
  "packs:",
  "  - id: core",
  "    paths: [\"**/*.ts\"]",
  "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }",
  "loopBreakerRepeats: 3",
  "",
].join("\n");

const holdsDeliberateViolations = (file: string): boolean =>
  file.startsWith("test/fixtures/") || /^packs\/[^/]+\/fixtures\//.test(file);

const sourceFiles = async (): Promise<string[]> => {
  const files: string[] = [];
  for (const dir of ["src", "eslint-plugin", "test"]) {
    for (const entry of await readdir(join(repo, dir), { recursive: true })) {
      const file = join(dir, entry);
      if (file.endsWith(".ts") && !holdsDeliberateViolations(file)) files.push(file);
    }
  }
  return files;
};

it("Warden source passes its own core pack", async () => {
  const project = await mkdtemp(join(tmpdir(), "warden-self-"));
  try {
    await mkdir(join(project, ".warden/generated"), { recursive: true });
    await writeFile(join(project, ".warden/config.yaml"), config);
    const set = await loadRecords(project, repo);
    const guardrails = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.filter((g) => g.implementation.startsWith("eslint:"))));
    for (const [file, content] of Object.entries(eslintAdapter.emit(guardrails, set))) {
      await writeFile(join(project, file), content);
    }
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(10);
    const results = await runGuardrails(set, guardrails, files, {
      root: repo,
      generatedDir: join(project, ".warden/generated"),
    });
    expect(results.map((r) => r.guardrail)).toEqual(guardrails.map((g) => g.id));
    expect(results.map((r) => r.status)).toEqual(guardrails.map(() => "pass"));
    const violations = results.flatMap((r) => r.violations.map((v) => `${relative(repo, join(repo, v.file))}:${v.line} ${v.message}`));
    expect(violations).toEqual([]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
