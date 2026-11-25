import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parse } from "yaml";
import { withVerdict } from "../verdict.js";

const cli = resolve(import.meta.dirname, "../../bin/warden.js");
const typescriptPack = resolve(import.meta.dirname, "../../packs/typescript/pack.yaml");
let escapeHatch: { id: string; definition: string; bans: string[] };
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
  - id: project-terms
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
  - { id: api, kind: service, folder: api, publicEntry: src/port.ts }
  - { id: monitor, kind: nested, folder: api/monitor }
  - { id: docs, kind: service, folder: docs }
  - { id: templates, kind: nested, folder: .claude/templates }
`;

const doc = "# Unit\n\nPurpose\n-------\n\n<!--\n## Commented\n-->\n\n<div>\n## Inside HTML\n</div>\n\n```md\n## Ignored\n```\n\n## Interfaces\n";
const git = (...args: string[]): void => {
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root });
};
const run = (...args: string[]) => withVerdict(args, spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" }));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-unit-layout-"));
  git("init", "-q", "-b", "main");
  await write(".warden/config.yaml", config);
  const typeScriptTerms = parse(await readFile(typescriptPack, "utf8")).terms as (typeof escapeHatch)[];
  escapeHatch = typeScriptTerms.find(({ id }) => id === "escape-hatch")!;
  await write(".warden/packs/project-terms/pack.yaml",
    'id: project-terms\nlayer: 11\nterms:\n'
    + '  - { id: "Data Source/Δ", definition: "An origin for records.", bans: [] }\n'
    + '  - { id: transport-policy, definition: "The endpoint sends records. The recipient acknowledges them.", bans: [] }\n'
    + '  - { id: signal-start, definition: "`pkg.run` starts the service.", bans: [] }\n'
    + `  - ${JSON.stringify(escapeHatch)}\n`
    + 'practices: []\n');
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
  const invalid = ["docs/extra.markdown", "api/image.svg", "unowned/assets/data.json", "NOTES.md"];
  try {
    await write("docs/extra.markdown", "# Repeated documentation\n");
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
      expect.objectContaining({ file: "docs/extra.markdown", message: expect.stringContaining("already has a document") }),
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

it("checks local rendered links from declared documents and the permitted root docs", async () => {
  const links = () => run("check", "--rule", "warden-unit-document-links", "--tier", "boundary", "--base", "main", "--format", "json");
  const valid = [
    "[Port][port]",
    "[port]: src/port.ts?plain=1#L1",
    "[Monitor](/api/monitor/)",
    "[Query and answer](src/q&amp;a.ts)",
    "[Contract](../docs/CONTRACT.md)",
    "[This section](#interfaces)",
    "[Formatted heading](../docs/CONTRACT.md#run-the-%CE%B8-tool)",
    "[Second heading](../docs/CONTRACT.md#run-the-%CE%B8-tool-1)",
    "[Custom anchor](../docs/CONTRACT.md#custom%26anchor)",
    "[Top](../docs/CONTRACT.md#)",
    "[Alternate extension](../docs/reference.markdown#present)",
    "[Rendered after filtered HTML](../docs/reference.markdown#later-heading)",
    "[External](https://example.org/a)",
    "`[Code](missing-in-code.md)`",
    "<!-- [Hidden](missing-in-comment.md) -->",
  ].join("\n\n");
  const ampersandFile = "api/src/q&a.ts";
  const dangling = "api/src/dangling.ts";
  const reference = "docs/reference.markdown";
  try {
    await write(ampersandFile, "export const answer = 42;\n");
    await symlink("missing.ts", join(root, dangling));
    await write("docs/CONTRACT.md", `${doc}\n### Run the *Θ* \`tool\`!\n\n### Run the *Θ* \`tool\`!\n\n<a name="custom&amp;anchor"></a>\n`);
    await write(reference, "# Present\n\n<div id=\"id-only\"></div>\n\n<style id=\"filtered-anchor\"></style>\n\n<plaintext>\n\n## Later heading\n");
    await write("api/CONTRACT.md", `${doc}\n${valid}\n`);
    expect(links().status).toBe(0);
    const broken = [
      "[Bad](src/missing.ts)",
      "[Outside](../../outside.md)",
      "[Directory required](src/port.ts/)",
      "[Dangling symlink](src/dangling.ts)",
      "[Missing section](#missing-heading)",
      "[Commented heading](#commented)",
      "[Fenced heading](#ignored)",
      "[Missing heading in another document](../docs/CONTRACT.md#run-the-%CE%B8-tool-2)",
      "[Malformed fragment](../docs/CONTRACT.md#%ZZ)",
      "[Missing alternate heading](../docs/reference.markdown#missing-alt)",
      "[Stripped ID](../docs/reference.markdown#id-only)",
      "[Filtered HTML](../docs/reference.markdown#filtered-anchor)",
    ].join("\n\n");
    await write("api/CONTRACT.md", `${doc}\n${valid}\n\n${broken}\n`);
    await write("README.md", "# Fixture\n\n[Incorrect root link](/modules/missing)\n");
    const failed = links();
    expect(failed.status, failed.stderr + failed.stdout).toBe(1);
    expect(JSON.parse(failed.stdout).failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("src/missing.ts") }),
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("../../outside.md") }),
      expect.objectContaining({ file: "README.md", message: expect.stringContaining("/modules/missing") }),
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("src/port.ts/") }),
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("src/dangling.ts") }),
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("#missing-heading") }),
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("#commented") }),
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("#ignored") }),
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("#run-the-%CE%B8-tool-2") }),
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("#%ZZ") }),
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("#missing-alt") }),
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("#id-only") }),
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("#filtered-anchor") }),
    ]));
  } finally {
    await write("api/CONTRACT.md", doc);
    await write("README.md", "# Fixture\n");
    await write("docs/CONTRACT.md", doc);
    await Promise.all([ampersandFile, dangling, reference].map((file) => rm(join(root, file), { force: true })));
  }
  expect(links().status).toBe(0);
});


it("resolves explicit Markdown Term links against configured pack records", async () => {
  const links = () => run("check", "--rule", "warden-unit-document-links", "--tier", "boundary", "--base", "main", "--format", "json");
  try {
    await write("api/CONTRACT.md", `${doc}\n[Guardrail][rule] and [data source](term:Data%20Source%2F%CE%94).\n\n[rule]: term:guardrail\n`);
    await write("README.md", "# Fixture\n\n[Guardrail](term:guardrail) and `[literal](term:sample)`.\n");
    const valid = links();
    expect(valid.status, valid.stderr + valid.stdout).toBe(0);

    await write("api/CONTRACT.md", `${doc}\n[Unknown](term:made-up) and [Wrong case](term:Guardrail).\n`);
    await write("README.md", "# Fixture\n\n[Malformed](term:%ZZ) and [Empty](term:).\n");
    const invalid = links();
    expect(invalid.status, invalid.stderr + invalid.stdout).toBe(1);
    expect(JSON.parse(invalid.stdout).failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("term:made-up") }),
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("term:Guardrail") }),
      expect.objectContaining({ file: "README.md", message: expect.stringContaining("term:%ZZ") }),
      expect.objectContaining({ file: "README.md", message: expect.stringContaining("term: does not") }),
    ]));
  } finally {
    await write("api/CONTRACT.md", doc);
    await write("README.md", "# Fixture\n");
  }
});

it("reports copied Term definitions in Unit and root Markdown prose", async () => {
  const definitions = () => run("check", "--rule", "warden-unit-term-definitions", "--tier", "boundary", "--base", "main", "--format", "json");
  try {
    await write("api/CONTRACT.md", `${doc}\n[Data Source](term:Data%20Source%2F%CE%94) supplies records.\n\n`
      + "\x60\x60\x60md\nAn origin for records.\n\x60\x60\x60\n\n<!-- An origin for records. -->\n"
      + escapeHatch.definition.replace("<T>", "") + "\n");
    const valid = definitions();
    expect(valid.status, valid.stderr + valid.stdout).toBe(0);

    await write("api/CONTRACT.md", `${doc}\n- **Data Source/Δ**: An *origin* for\n  records.\n`);
    await write("docs/CONTRACT.md", `${doc}\n- An **origin** for\n  records.\n`);
    await write("README.md", '# Fixture\n\n| Term | Explanation |\n| --- | --- |\n| Data | An origin for records |\n\n'
      + 'A local note begins here. the endpoint sends records. the recipient acknowledges them. additional details follow.\n\n'
      + '`pkg.run` starts the service.\n\n'
      + escapeHatch.definition.replace("<T>x", "`<T>x`") + '\n');
    const invalid = definitions();
    expect(invalid.status, invalid.stderr + invalid.stdout).toBe(1);
    expect(JSON.parse(invalid.stdout).failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining("duplicates the definition of Term Data Source/Δ") }),
      expect.objectContaining({ file: "README.md", message: expect.stringContaining("duplicates the definition of Term Data Source/Δ") }),
      expect.objectContaining({ file: "README.md", message: expect.stringContaining("duplicates the definition of Term transport-policy") }),
      expect.objectContaining({ file: "README.md", message: expect.stringContaining("duplicates the definition of Term signal-start") }),
      expect.objectContaining({ file: "README.md", message: expect.stringContaining("duplicates the definition of Term escape-hatch") }),
      expect.objectContaining({ file: "docs/CONTRACT.md", message: expect.stringContaining("duplicates the definition of Term Data Source/Δ") }),
    ]));
  } finally {
    await write("api/CONTRACT.md", doc);
    await write("docs/CONTRACT.md", doc);
    await write("README.md", "# Fixture\n");
  }
});

const interfaces = () => run("check", "--rule", "warden-unit-public-interfaces", "--tier", "boundary", "--base", "main", "--format", "json");
const listing = (exports: string[]) => exports.map((name) => '- `' + name + '`').join("\n");
const interfaceSources = ["api/src/a.ts", "api/src/b.ts", "api/src/missing.ts"] as const;
const restorePublicFixture = async () => {
  await rm(join(root, "api/src/port.ts"), { force: true });
  await write("api/src/port.ts", "export const ready = true;\n");
  await write("api/CONTRACT.md", doc);
  await Promise.all(interfaceSources.map((file) => rm(join(root, file), { force: true })));
};

it("checks public names through aliases, type exports, and local wildcard cycles", async () => {
  const names = ["alias", "default", "RecordPort", "star", "nested", "GET", "remote", "namespace"];
  const [a, b] = interfaceSources;
  try {
    await write("api/src/port.ts", [
      'const local = 1;',
      'export { local as alias };',
      'export default function () {}',
      'export type { RecordPort } from "./a.js";',
      'export * from "./a.js";',
      'export * as namespace from "./b.js";',
      'export { remote } from "external";',
    ].join("\n"));
    await write(a, 'export default 7; export const star = 2; export type RecordPort = string; export * from "./b";');
    await write(b, 'export const nested = 3, GET = 4; export * from "./a";');
    await write("api/CONTRACT.md", `${doc}\n${listing(names)}\n`);
    const valid = interfaces();
    expect(valid.status, valid.stderr + valid.stdout).toBe(0);

    await write("api/CONTRACT.md", `${doc}\n${listing(names.slice(0, -3))}\n\nA mention of \`GET\`.\n\n- See \`remote\`.\n\n# Other\n\n- \`namespace\`\n`);
    const invalid = interfaces();
    expect(invalid.status, invalid.stderr + invalid.stdout).toBe(1);
    expect(JSON.parse(invalid.stdout).failures).toEqual(names.slice(-3).sort().map((name) =>
      expect.objectContaining({ file: "api/CONTRACT.md", message: expect.stringContaining(`exports "${name}"`) }),
    ));
  } finally {
    await restorePublicFixture();
  }
});

it("requires disambiguation only for wildcard exports from distinct bindings", async () => {
  const [a, b] = interfaceSources;
  try {
    await write("api/src/port.ts", 'export * from "./a"; export * from "./b";');
    await write(a, 'export const ready = 1;');
    await write(b, 'export const ready = 2;');
    await write("api/CONTRACT.md", `${doc}\n${listing(["ready"])}\n`);
    const conflict = interfaces();
    expect(conflict.status, conflict.stderr + conflict.stdout).toBe(1);
    expect(JSON.parse(conflict.stdout).failures).toEqual([
      expect.objectContaining({ file: "api/src/port.ts", message: expect.stringContaining("ambiguous wildcard exports") }),
    ]);
    await write("api/src/port.ts", 'export * from "./a"; export * from "./b"; export { ready } from "./a";');
    const disambiguated = interfaces();
    expect(disambiguated.status, disambiguated.stderr + disambiguated.stdout).toBe(0);
    await write("api/src/port.ts", 'export * from "./a"; export * from "./b";');
    await write(b, 'export { ready } from "./a";');
    const shared = interfaces();
    expect(shared.status, shared.stderr + shared.stdout).toBe(0);
  } finally {
    await restorePublicFixture();
  }
});

it("reports unresolved wildcard and non-regular entry files", async () => {
  const [a, b, missing] = interfaceSources;
  try {
    await write("api/src/port.ts", 'export * from "./b";');
    await write(a, 'export const nested = 3;');
    await symlink("a.ts", join(root, missing));
    await write(b, 'export * from "./missing";');
    const unresolved = interfaces();
    expect(unresolved.status, unresolved.stderr + unresolved.stdout).toBe(1);
    expect(JSON.parse(unresolved.stdout).failures).toEqual([
      expect.objectContaining({ file: "api/src/port.ts", message: expect.stringContaining('cannot resolve wildcard export "./missing"') }),
    ]);

    await rm(join(root, "api/src/port.ts"));
    await symlink("../monitor/handler.ts", join(root, "api/src/port.ts"));
    const nonRegular = interfaces();
    expect(nonRegular.status, nonRegular.stderr + nonRegular.stdout).toBe(1);
    expect(JSON.parse(nonRegular.stdout).failures).toEqual([
      expect.objectContaining({ message: expect.stringContaining("needs a regular public entry it owns") }),
    ]);
  } finally {
    await restorePublicFixture();
  }
});
