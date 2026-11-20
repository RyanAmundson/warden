import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "../../bin/warden.js");
const kind = '{ document: CONTRACT.md, sections: [Purpose], layout: ["src/**/*.ts"] }';
const config = `project: local-unit-fixture
base: main
packs: [{ id: local, paths: ["src/**/*.ts"] }]
tierBudgetMs: { edit: 5000, commit: 10000, boundary: 120000 }
loopBreakerRepeats: 3
bench: { baseFiles: 1, maxFiles: 4, minMarginalMs: 1000 }
unitKinds: { service: ${kind} }
units: [{ id: api, kind: service, folder: api }]
`;
const pack = String.raw`id: local
layer: 1
terms: []
practices:
  - id: unit-purpose
    statement: Unit documents declare their purpose.
    terms: []
    paths: []
    conflictsWith: []
    guardrails:
      - id: local-unit-purpose
        kind: lint
        runs: [boundary]
        budgetMs: 5000
        version: 1
        implementation: "fs:local/unit-purpose"
        scope: project
        unitExample: { folder: sample, kind: ${kind} }
        mustPass: { "sample/CONTRACT.md": "## Purpose\n" }
        mustFail: { "sample/CONTRACT.md": "## Interfaces\n" }
      - id: local-overview
        kind: lint
        runs: [boundary]
        budgetMs: 5000
        version: 1
        implementation: "fs:local/overview"
        scope: project
        mustPass: { "OVERVIEW.md": "# Project\n" }
        mustFail: { "src/readme.ts": "export const ready = true;\n" }
      - id: local-no-debugger
        kind: lint
        runs: [edit]
        budgetMs: 5000
        version: 1
        implementation: "eslint:no-debugger"
        mustPass: "export const ready = true;\n"
        mustFail: "debugger;\n"
`;
const implementation = `export default {
  overview: ({ files }) => files.includes("OVERVIEW.md") ? [] : [{ file: "", message: "Add OVERVIEW.md" }],
  "unit-purpose": ({ files, nonRegular = [], read, markdownSections, unitStructure }) =>
    unitStructure.units.flatMap(({ id, document }) => {
      if (!files.includes(document)) return [{ file: "", message: "Missing " + document }];
      if (unitStructure.owners[document] !== id) throw new Error("Unexpected owner for " + document);
      if (nonRegular.includes(document)) return [{ file: document, message: "Use a regular document" }];
      return markdownSections(read(document)).includes("Purpose") ? [] : [{ file: document, message: "Add Purpose" }];
    }),
};
`;

it("compiles and runs a local project-scoped FS rule with declared Units", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-unit-project-"));
  const write = async (file: string, content: string): Promise<void> => {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  };
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root });
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
  const check = () => run("check", "--rule", "local-unit-purpose", "--tier", "boundary", "--base", "main", "--format", "json");

  try {
    git("init", "-q", "-b", "main");
    await write(".warden/config.yaml", config);
    await write(".warden/packs/local/pack.yaml", pack);
    await write(".warden/packs/local/fs.js", implementation);
    git("add", "-A");
    git("commit", "-qm", "Declare local project scope");
    const compiled = run("compile");
    expect(compiled.status, compiled.stderr + compiled.stdout).toBe(0);
    git("add", "-A");
    git("commit", "-qm", "Compile local pack");

    const missing = check();
    expect(missing.status, missing.stderr + missing.stdout).toBe(1);
    expect(JSON.parse(missing.stdout).failures).toMatchObject([{ file: "", message: "Missing api/CONTRACT.md" }]);

    await write("api/CONTRACT.md", "<!--\n## Purpose\n-->\n\n```md\n## Purpose\n```\n");
    const invalid = check();
    expect(invalid.status, invalid.stderr + invalid.stdout).toBe(1);
    expect(JSON.parse(invalid.stdout).failures).toMatchObject([{ file: "api/CONTRACT.md", message: "Add Purpose" }]);

    await write("api/CONTRACT.md", "# API\n\nPurpose\n-------\n");
    const corrected = check();
    expect(corrected.status, corrected.stderr + corrected.stdout).toBe(0);

    const modulePath = "api/CONTRACT.md";
    await rm(join(root, modulePath));
    git("-c", "protocol.file.allow=always", "submodule", "add", "-q", root, modulePath);
    const directory = check();
    expect(directory.status, directory.stderr + directory.stdout).toBe(1);
    expect(JSON.parse(directory.stdout).failures).toMatchObject([{ file: modulePath, message: "Use a regular document" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it("retains Unit lookup for control folders without a project-scoped rule", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-unit-lookup-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    await mkdir(join(root, ".warden"));
    await writeFile(join(root, ".warden/config.yaml"), config
      .replace('packs: [{ id: local, paths: ["src/**/*.ts"] }]', "packs: []")
      .replace("folder: api", "folder: .claude/templates"));
    const result = spawnSync(process.execPath, [cli, "where", "api"], { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("api\t.claude/templates/CONTRACT.md\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
