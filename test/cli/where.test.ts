import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "../../bin/warden.js");
let root: string;

const write = async (file: string, content = ""): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

const where = (query: string, cwd = root) => spawnSync(process.execPath, [cli, "where", query], { cwd, encoding: "utf8" });

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

it("asks for a path when a Term or group name matches more than one Unit", async () => {
  await write("src/tools/[services]/git-service/git-service.ts", "export type Name = string;\n");
  const result = where("Git");
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("src/[services]/git-service, src/tools/[services]/git-service");
  expect(result.stderr.match(/Next action:/g)).toHaveLength(1);
  expect(where("src/tools/[services]/git-service/git-service.ts").stdout).toBe("git-service\tsrc/tools/[services]/git-service/CONTRACT.md\n");
});
