import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "../../bin/warden.js");
let root: string;

const write = async (file: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

const config = `project: unit-fixture
base: main
packs:
  - id: core
    paths: ["**/*.ts"]
  - id: unit-layout
    paths: ["**/*"]
tierBudgetMs: { edit: 5000, commit: 10000, boundary: 120000 }
loopBreakerRepeats: 3
bench: { baseFiles: 1, maxFiles: 8, minMarginalMs: 1000 }
unitKinds:
  service:
    document: CONTRACT.md
    sections: [Purpose, Interfaces]
    layout: ["src/**/*.ts"]
  nested:
    document: UNIT.md
    sections: [Purpose]
    layout: ["handler.ts"]
units:
  - { id: api, kind: service, folder: api }
  - { id: monitor, kind: nested, folder: api/monitor }
  - { id: docs, kind: service, folder: docs }
  - { id: templates, kind: nested, folder: .claude/templates }
`;

const doc = "# Unit\n\nPurpose\n-------\n\n<!--\n## Commented\n-->\n\n<div>\n## Inside HTML\n</div>\n\n```md\n## Ignored\n```\n\n## Interfaces\n";
const git = (...args: string[]): void => {
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root });
};
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-unit-layout-"));
  git("init", "-q", "-b", "main");
  await write(".warden/config.yaml", config);
  await write("api/CONTRACT.md", doc);
  await write("api/src/port.ts", "export const ready = true;\n");
  await write("api/monitor/UNIT.md", "# Monitor\n\n## Purpose\n");
  await write("api/monitor/handler.ts", "export const handler = true;\n");
  await write("docs/CONTRACT.md", doc);
  await write(".claude/templates/UNIT.md", "# Templates\n\n## Purpose\n");
  await write(".claude/settings.json", "{}\n");
  await write("README.md", "# Fixture\n");
  await write("AGENTS.md", "# Project commands\n");
  await write("package.json", "{}\n");
  await symlink("port.ts", join(root, "api/src/alias.ts"));
  git("add", "-A");
  git("commit", "-qm", "Declare Units");
  const compile = run("compile");
  expect(compile.status, compile.stderr + compile.stdout).toBe(0);
  git("add", "-A");
  git("commit", "-qm", "Compile pack");
}, 20_000);

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

const check = () => run("check", "--rule", "warden-unit-layout", "--tier", "boundary", "--base", "main", "--format", "json");

it("checks the whole opted-in project, reports document and layout failures and accepts their corrections", async () => {
  const before = check();
  expect(before.status, before.stderr + before.stdout).toBe(0);
  const invalid = ["docs/extra.md", "api/image.svg", "unowned/assets/data.json", "NOTES.md"];
  try {
    await write("docs/extra.md", "# Repeated documentation\n");
    await write("api/image.svg", "<svg/>\n");
    await write("unowned/assets/data.json", "{}\n");
    await write("NOTES.md", "# Root notes\n");
    const child = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    git("update-index", "--add", "--cacheinfo", `160000,${child},unowned-module`);
    await write("api/CONTRACT.md", "# Unit\n\n## Interfaces\n\n## Purpose\n");
    await rm(join(root, "docs/CONTRACT.md"));
    await symlink("../api/CONTRACT.md", join(root, "docs/CONTRACT.md"));
    const failed = check();
    expect(failed.status, failed.stderr + failed.stdout).toBe(1);
    expect(JSON.parse(failed.stdout).failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "docs/CONTRACT.md", message: expect.stringContaining("needs a regular Markdown document") }),
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("sections in order: Purpose, Interfaces") }),
      expect.objectContaining({ file: "docs/extra.md", message: expect.stringContaining("already has a document") }),
      expect.objectContaining({ file: "api/image.svg", message: expect.stringContaining("outside the layout") }),
      expect.objectContaining({ file: "unowned/assets/data.json", message: expect.stringContaining("has no owning Unit") }),
      expect.objectContaining({ file: "NOTES.md", message: expect.stringContaining("has no owning Unit") }),
      expect.objectContaining({ file: "unowned-module", message: expect.stringContaining("has no owning Unit") }),
    ]));
  } finally {
    git("update-index", "--force-remove", "--", "unowned-module");
    await Promise.all(invalid.map((file) => rm(join(root, file))));
    await write("api/CONTRACT.md", doc);
    await rm(join(root, "docs/CONTRACT.md"), { force: true });
    const missing = check();
    expect(missing.status, missing.stderr + missing.stdout).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      failures: [expect.objectContaining({ file: "", message: expect.stringContaining("missing its document at docs/CONTRACT.md") })],
      next: "Create docs/CONTRACT.md with the required level-two headings: Purpose, Interfaces.",
    });
    await write("docs/CONTRACT.md", doc);
  }
  const after = check();
  expect(after.status, after.stderr + after.stdout).toBe(0);
});
