import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parse } from "yaml";

const cli = resolve(import.meta.dirname, "../../bin/warden.js");
const exec = promisify(execFile);
const manifest = ".warden/packs/local/pack.yaml";
let home: string;
let root: string;

const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
  cwd: root, encoding: "utf8", env: { ...process.env, WARDEN_HOME: home },
});
const command = (kind: "skill" | "tool", id: string, term: string, tool = "warden report") => [
  "new", kind, id, "--pack", "local", "--serves", term, "--purpose", `Find ${term}.`,
  "--when", "looking up project records", "--command", tool,
];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "warden-new-capability-"));
  root = join(home, "repo");
  await mkdir(join(root, ".warden/packs/local"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await writeFile(join(root, ".warden/config.yaml"), [
    "project: capability-fixture", "base: main", "packs: [{ id: local, paths: [] }]",
    "tierBudgetMs: { edit: 1000, commit: 10000, boundary: 120000 }", "loopBreakerRepeats: 3", "",
  ].join("\n"));
  await writeFile(join(root, manifest), [
    "# The project owns this pack.", "id: local", "layer: 100", "terms:",
    "  - { id: Review, definition: A review., bans: [] }",
    "  - { id: Report, definition: A report., bans: [] }", "practices: []", "",
  ].join("\n"));
});

afterEach(() => rm(home, { recursive: true, force: true }));

it("registers a skill and a tool and uses the existing compiler to emit only the skill", async () => {
  for (const [kind, id, term] of [["skill", "project-review", "Review"], ["tool", "project-report", "Report"]] as const) {
    const result = run(...command(kind, id, term));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`${id}\t${manifest}`);
    expect(run("where", "--capability", term).stdout.trim()).toBe(`${id}\t${kind}\tFind ${term}.`);
  }
  const amended = await readFile(join(root, manifest), "utf8");
  expect(amended).toContain("# The project owns this pack.");
  expect(parse(amended).capabilities).toMatchObject([
    { id: "project-review", kind: "skill", commands: ["warden report"] },
    { id: "project-report", kind: "tool", commands: ["warden report"] },
  ]);
  const compile = run("compile");
  expect(compile.status, compile.stderr + compile.stdout).toBe(0);
  expect(await readdir(join(root, ".warden/generated/skills"))).toEqual(["project-review"]);
});

it("keeps the manifest unchanged after rejected IDs, Terms or commands", async () => {
  expect(run(...command("tool", "report", "Report")).status).toBe(0);
  const before = await readFile(join(root, manifest), "utf8");
  const cases = [
    command("tool", "report", "Review"),
    command("tool", "other-report", "Report"),
    command("tool", "missing", "Unknown"),
    command("skill", "Upper Case", "Review"),
    command("skill", "unknown-command", "Review", "warden no-such-command"),
    [...command("skill", "missing-practice", "Review"), "--upholds", "missing"],
    [...command("tool", "bundled", "Review"), "--pack", "core"],
  ];
  for (const args of cases) {
    const result = run(...args);
    expect(result.status, args.join(" ")).toBe(2);
    expect(result.stderr.match(/Next action:/g)).toHaveLength(1);
    expect(await readFile(join(root, manifest), "utf8")).toBe(before);
  }
  expect(run(...command("skill", "another-review", "Review")).status).toBe(0);
});

it("serializes concurrent registrations so one purpose is declared only once", async () => {
  const results = await Promise.all(["review-one", "review-two"].map(async (id) => {
    try {
      await exec(process.execPath, [cli, ...command("skill", id, "Review")], { cwd: root });
      return 0;
    } catch (error) {
      return (error as { code?: number }).code;
    }
  }));
  expect(results.sort()).toEqual([0, 2]);
  const loaded = parse(await readFile(join(root, manifest), "utf8"));
  expect(loaded.capabilities).toHaveLength(1);
  expect(loaded.capabilities[0].serves).toBe("Review");
  expect(await readdir(join(root, ".warden"))).not.toContain("capability-scaffold.lock");
});

it.each([
  "practices: &empty []\ncapabilities: *empty",
  "capabilities: &empty []\npractices: *empty",
])("extends an aliased Capability list while preserving the other collection", async (lists) => {
  const path = join(root, manifest);
  await writeFile(path, (await readFile(path, "utf8")).replace("practices: []", lists));
  expect(run("compile").status).toBe(0);
  const result = run(...command("skill", "independent-review", "Review"));
  expect(result.status, result.stderr).toBe(0);
  const loaded = parse(await readFile(path, "utf8"));
  expect(loaded.practices).toEqual([]);
  expect(loaded.capabilities).toMatchObject([{ id: "independent-review" }]);
  expect(run("compile").status).toBe(0);
});

it("refuses another occurrence of an existing duplicate Capability ID", async () => {
  const path = join(root, manifest);
  const capability = '  - { id: repeated, kind: tool, serves: Report, purpose: Report, when: Review, commands: ["warden report"], upholds: [], replaces: [] }';
  const before = `${await readFile(path, "utf8")}capabilities:\n${capability}\n${capability}\n`;
  await writeFile(path, before);
  const result = run(...command("tool", "repeated", "Review"));
  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).toContain("duplicate-capability");
  expect(await readFile(path, "utf8")).toBe(before);
});
