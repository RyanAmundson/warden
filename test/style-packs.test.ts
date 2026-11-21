import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runCheck } from "../src/cli/check.js";
import { expectedOutputs, practicesElsewhere } from "../src/compiler/compile.js";
import { LOCK_PATH } from "../src/compiler/lock.js";
import { checkConsistency } from "../src/compiler/consistency.js";
import { examplePrefix, runExamples } from "../src/compiler/examples.js";
import { loadRecords } from "../src/records/load.js";
import { pathGroups } from "../src/records/paths.js";
import type { Guardrail, RecordSet } from "../src/records/types.js";
import { readEvidence } from "../src/runner/evidence.js";

const wardenRoot = resolve(import.meta.dirname, "..");
const NEW_PACKS = ["typescript", "rxjs-declarative", "signals", "declarative-ui"];
const CODE = '["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"]';
const PACK_PATHS: [string, string][] = [
  ["core", CODE],
  ["typescript", CODE],
  ["rxjs-declarative", '["src/rx/**"]'],
  ["signals", '["src/sig/**"]'],
  ["declarative-ui", '["src/ui/**"]'],
];

let root: string;
let home: string;

const withPacks = (initConfig: string): string =>
  initConfig.replace(/^packs:\n(?: {2}.*\n)+/m, ["packs:", ...PACK_PATHS.flatMap(([id, paths]) => [`  - id: ${id}`, `    paths: ${paths}`]), ""].join("\n"));

const write = async (file: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

const git = (...args: string[]): string =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const o = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const e = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    return await fn();
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
};

const newGuardrails = (set: RecordSet): { g: Guardrail; file: string }[] =>
  set.packs
    .filter((p) => NEW_PACKS.includes(p.id))
    .flatMap((p) => {
      const scope = set.config.packs.find((c) => c.id === p.id)?.paths ?? [];
      return p.practices.flatMap((x) =>
        x.guardrails.filter((g) => g.kind !== "instruction").map((g) => ({ g, file: `${examplePrefix(pathGroups(x.paths, scope)[0])}${g.id}.ts` })),
      );
    });

const listed = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), "warden-style-packs-list-"));
  try {
    await mkdir(join(dir, ".warden"), { recursive: true });
    await writeFile(join(dir, ".warden/config.yaml"), withPacks("project: list\nbase: main\npacks:\n  - id: core\ntierBudgetMs: { edit: 2000, commit: 10000, boundary: 120000 }\nloopBreakerRepeats: 3\n"));
    return newGuardrails(await loadRecords(dir, wardenRoot));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "warden-style-packs-")));
  home = await mkdtemp(join(tmpdir(), "warden-home-"));
  vi.stubEnv("WARDEN_HOME", home);
  await write("package.json", "{}\n");
  await write("tsconfig.json", `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: true }, include: ["**/*.ts"] })}\n`);
  await write(".gitignore", "node_modules\n");
  git("init", "-q", "-b", "main");
  await write(".warden/config.yaml", withPacks("project: style-packs\nbase: main\npacks:\n  - id: core\ntierBudgetMs: { edit: 2000, commit: 10000, boundary: 120000 }\nloopBreakerRepeats: 3\n"));
  const { files, lock } = await expectedOutputs(await loadRecords(root, wardenRoot), root, wardenRoot);
  for (const [path, content] of Object.entries(files)) await write(path, content);
  await write(LOCK_PATH, JSON.stringify(lock));
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "feature");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("the four style and typescript packs together", () => {
  it("the four packs are consistent and every mustPass passes every other Guardrail on its path", async () => {
    const set = await loadRecords(root, wardenRoot);
    expect(set.packs.map((p) => p.id).filter((id) => NEW_PACKS.includes(id)).sort()).toEqual([...NEW_PACKS].sort());
    expect(newGuardrails(set).map(({ g }) => g.id)).toEqual(listed.map(({ g }) => g.id));
    expect(checkConsistency(set, await practicesElsewhere(set, wardenRoot))).toEqual([]);
    expect(await runExamples(set)).toEqual([]);
  });
});

describe("every new Guardrail records fired and cost Evidence", () => {
  it("the list comes from the loaded records of the four packs", () => {
    expect(new Set(listed.map(({ g }) => g.id)).size).toBe(listed.length);
    expect(listed.length).toBeGreaterThan(NEW_PACKS.length);
  });

  it.each(listed.map(({ g, file }) => [g.id, g, file] as const))("%s fires on its mustFail", async (id, g, file) => {
    expect(typeof g.mustFail).toBe("string");
    await write(file, g.mustFail as string);
    git("add", "-A");
    const project = (await loadRecords(root, wardenRoot)).config.project;
    const before = readEvidence(project).length;
    try {
      expect(await quiet(() => runCheck({ root, wardenRoot, format: "json", base: "main", tier: "commit", rule: id }))).toBe(1);
    } finally {
      git("rm", "-q", "-f", file);
    }
    const rows = readEvidence(project).slice(before);
    expect(rows.filter((r) => r.kind === "fired" && r.guardrail === id).map((r) => ({ file: r.file, status: r.status }))).toEqual([{ file, status: "fail" }]);
    const costs = rows.filter((r) => r.kind === "cost" && (r.guardrail === id || r.members?.includes(id) === true));
    expect(costs).toHaveLength(1);
    const cost = costs[0];
    expect(cost?.ms).toBeGreaterThan(0);
    if (cost?.guardrail !== id) expect(cost?.rules?.[id]).toBeGreaterThan(0);
  });
});
