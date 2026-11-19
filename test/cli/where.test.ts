import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "../../bin/warden.js");
let root: string;

const write = async (file: string, content = ""): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

const warden = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
const where = (query: string, cwd = root) => spawnSync(process.execPath, [cli, "where", query], { cwd, encoding: "utf8" });

const configPath = ".warden/config.yaml";
const declarations = `
unitKinds:
  contract:
    document: CONTRACT.md
    sections: [Purpose, Owns, Interfaces, Invariants]
  feature:
    document: FEATURE.md
    sections: [Purpose, Behavior]
`;

const withUnits = async (units: string): Promise<void> => {
  const before = await readFile(join(root, configPath), "utf8");
  await write(configPath, `${before}${declarations}units: ${units}\n`);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-where-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await write(".warden/config.yaml", `project: where-fixture
base: main
packs:
  - id: architecture
    paths: ["src/**/*.ts"]
    settings:
      groupCollections:
        - collection: "[services]"
          suffix: "-service"
        - collection: "[plugins]"
  - id: project
    paths: []
tierBudgetMs: { edit: 2000, commit: 10000, boundary: 120000 }
loopBreakerRepeats: 3
`);
  await write(".warden/packs/project/pack.yaml", `id: project
layer: 100
terms:
  - id: Git
    definition: A version control system.
    bans: []
practices: []
`);
  await write("src/[services]/git-service/git-service.ts", "export type Name = string;\n");
  await write("src/[services]/git-service/[plugins]/nested/CONTRACT.md", "# Nested\n");
});

afterEach(() => rm(root, { recursive: true, force: true }));

it("uses architecture group names, Terms, and the nearest enclosing Unit", () => {
  const outer = "git-service\tsrc/[services]/git-service/CONTRACT.md\n";
  expect(where("Git").stdout).toBe(outer);
  expect(where("git-service").stdout).toBe(outer);
  expect(where("src/[services]/git-service").stdout).toBe(outer);
  const subdirectory = join(root, "src/[services]/git-service");
  const nested = where("[plugins]/nested/future.ts", subdirectory);
  expect(nested.status, nested.stderr).toBe(0);
  expect(nested.stdout).toBe("nested\tsrc/[services]/git-service/[plugins]/nested/CONTRACT.md\n");
  expect(where("src/[services]/git-service-other/future.ts").stdout).toMatch(/^No Unit /);
});

it("finds an inner Unit nested in the same declared collection", async () => {
  const folder = "src/[services]/git-service/[services]/inner-service";
  await write(`${folder}/inner-service.ts`, "export type Name = string;\n");
  expect(where(`${folder}/future.ts`).stdout).toBe(`inner-service\t${folder}/CONTRACT.md\n`);
  expect(where("inner-service").stdout).toBe(`inner-service\t${folder}/CONTRACT.md\n`);
});

it("finds a future file through an absolute alias of the checkout", async () => {
  const alias = `${root}-alias`;
  const folder = "src/[services]/git-service";
  await symlink(root, alias, "dir");
  try {
    const result = where(join(alias, folder, "future/deeper/file.ts"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`git-service\t${folder}/CONTRACT.md\n`);
  } finally {
    await rm(alias);
  }
});

it("asks for a path when a Term or group name matches more than one Unit", async () => {
  await write("src/tools/[services]/git-service/git-service.ts", "export type Name = string;\n");
  const result = where("Git");
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("src/[services]/git-service, src/tools/[services]/git-service");
  expect(result.stderr.match(/Next action:/g)).toHaveLength(1);
  expect(where("src/tools/[services]/git-service/git-service.ts").stdout).toBe("git-service\tsrc/tools/[services]/git-service/CONTRACT.md\n");
});


it("resolves declared Units by Term, folder and id, with exactly one document per kind", async () => {
  await withUnits(`# Unit ownership
  - { id: project, kind: contract, folder: "." }
  - { id: vcs, kind: feature, folder: "src/[services]/git-service", term: Git }
`);
  const vcs = "vcs\tsrc/[services]/git-service/FEATURE.md\n";
  expect(where("Git").stdout).toBe(vcs);
  expect(where("vcs").stdout).toBe(vcs);
  expect(where("src/[services]/git-service/[plugins]/nested/future.ts").stdout).toBe(vcs);
  expect(where("src/future.ts").stdout).toBe("project\tCONTRACT.md\n");
  expect(where("../outside.ts").stdout).toMatch(/^No Unit /);
});

it.each([
  ['[{ id: x, kind: contract, folder: src }, { id: x, kind: feature, folder: ui }]', "Unit x is declared more than once"],
  ['[{ id: x, kind: contract, folder: src }, { id: y, kind: feature, folder: src }]', "Folder src already has a Unit"],
  ['[{ id: x, kind: contract, folder: src/../outside }]', "Use a project-relative folder"],
  ['[{ id: x, kind: missing, folder: src }]', "Define Unit kind missing"],
  ['[{ id: x, kind: contract, folder: src, term: Unknown }]', "names undeclared Term Unknown"],
])("rejects an invalid Unit declaration %s", async (units, message) => {
  await withUnits(units);
  const result = where("x");
  expect(result.status).toBe(2);
  expect(result.stderr).toContain(message);
});

it("uses one owner for case aliases when Git ignores path case", async () => {
  execFileSync("git", ["config", "core.ignorecase", "true"], { cwd: root });
  await withUnits("[]");
  const create = warden("new", "unit", "metrics", "src/metrics", "--kind", "contract");
  expect(create.status, create.stderr).toBe(0);
  expect(where("src/METRICS/next.ts").stdout).toBe("metrics\tsrc/metrics/CONTRACT.md\n");
  const duplicate = warden("new", "unit", "other", "src/METRICS", "--kind", "feature");
  expect(duplicate).toMatchObject({ status: 2, stderr: expect.stringContaining("already has a Unit") });
});

it("describes how to recover an interrupted scaffold lock without taking it from its owner", async () => {
  await withUnits("[]");
  await write(".warden/unit-scaffold.lock", "12345\n");
  const result = warden("new", "unit", "metrics", "src/metrics", "--kind", "contract");
  expect(result).toMatchObject({ status: 2, stderr: expect.stringContaining("wait for process 12345 to exit") });
  expect(await readFile(join(root, ".warden/unit-scaffold.lock"), "utf8")).toBe("12345\n");
});

it("scaffolds the ordered document and retains the existing record comments", async () => {
  await withUnits("[] # Explicit Unit ownership");
  const folder = "src/parent/new-unit";
  const result = warden("new", "unit", "vcs", folder, "--kind", "contract", "--term", "Git");
  expect(result.status, result.stderr).toBe(0);
  const expected = `vcs\t${folder}/CONTRACT.md\n`;
  expect(result.stdout).toBe(expected);
  expect(where("Git").stdout).toBe(expected);
  expect(await readFile(join(root, configPath), "utf8")).toContain("# Explicit Unit ownership");
  expect(await readFile(join(root, folder, "CONTRACT.md"), "utf8")).toBe(
    "# vcs\n\n## Purpose\n\n## Owns\n\n## Interfaces\n\n## Invariants\n\n",
  );
  expect(await readdir(join(root, ".warden"))).toEqual(["config.yaml", "packs"]);
});

it("leaves the config and existing document intact when scaffolding cannot create the document", async () => {
  await withUnits("[]");
  const before = await readFile(join(root, configPath), "utf8");
  const folder = "src/occupied";
  const document = `${folder}/CONTRACT.md`;
  await write(document, "# Keep this document\n");
  const result = warden("new", "unit", "occupied", folder, "--kind", "contract");
  expect(result).toMatchObject({ status: 2, stderr: expect.stringContaining("declare this Unit in .warden/config.yaml") });
  expect(await readFile(join(root, document), "utf8")).toBe("# Keep this document\n");
  expect(await readFile(join(root, configPath), "utf8")).toBe(before);
  expect(await readdir(join(root, ".warden"))).toEqual(["config.yaml", "packs"]);
});

it("preserves architecture lookup until the project opts into declared Units", () => {
  const result = warden("new", "unit", "vcs", "src/new", "--kind", "contract");
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Declare the project Units");
  expect(where("Git").stdout).toBe("git-service\tsrc/[services]/git-service/CONTRACT.md\n");
});
