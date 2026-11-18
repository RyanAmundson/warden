import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const wardenRoot = resolve(import.meta.dirname, "../..");
const main = join(wardenRoot, "dist/src/cli/main.js");

let root: string;
let home: string;

const git = (...args: string[]): void => {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: root,
    stdio: "ignore",
  });
};

const warden = (...args: string[]): { code: number | null; out: string; err: string } => wardenIn(root, "", ...args);

const wardenIn = (cwd: string, input: string, ...args: string[]): { code: number | null; out: string; err: string } => {
  const r = spawnSync("node", [main, ...args], { cwd, input, encoding: "utf8", env: { ...process.env, WARDEN_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

beforeAll(() => {
  execFileSync("npx", ["tsc"], { cwd: wardenRoot, stdio: "ignore" });
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-cli-"));
  home = await mkdtemp(join(tmpdir(), "warden-home-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/a.ts"), "// old comment\nexport const a = 1;\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const init = (): void => {
  expect(warden("init").code).toBe(0);
};

describe("warden CLI", () => {
  it("init creates config, lock, and baseline in a repo with existing comments and exits 0", async () => {
    const r = warden("init");
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(root, ".warden/config.yaml"))).toBe(true);
    expect(existsSync(join(root, ".warden/lock.json"))).toBe(true);
    const baseline = JSON.parse(await readFile(join(root, ".warden/baseline.json"), "utf8")) as Record<string, Record<string, number>>;
    expect(baseline["warden-no-comments"]).toEqual({ "src/a.ts": 1 });
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    expect(warden("check", "--base", "main").code).toBe(0);
  });

  it("init refuses when .warden exists", () => {
    init();
    const r = warden("init");
    expect(r.code).toBe(2);
    expect(r.err).toContain("already exists");
  });

  it("explain no-comments prints its compliant example source", () => {
    init();
    const r = warden("explain", "no-comments");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Compliant example (mustPass)");
    expect(r.out).toContain("export const sumOfPrices");
    expect(r.out).toContain("warden-no-comments");
  });

  it("Do this shows the agent's own line rewritten, never the record example", async () => {
    init();
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    await writeFile(join(root, "src/add.ts"), "// eslint-disable-next-line\nexport const add = (a: number, b: number) => a + b;\n");
    const r = warden("check", "--base", "main");
    expect(r.code, r.err).toBe(1);
    expect(r.out).toContain("Do this:  export const add = (a: number, b: number) => a + b;\n            Put any meaning in a name.");
    expect(r.out).toContain("Do this:  export const add = (a: number, b: number) => a + b;\n            Fix the rule it hid.");
    expect(r.out).not.toContain("const a = 1");
  });

  it("explain unknown exits 2", () => {
    init();
    const r = warden("explain", "nope");
    expect(r.code).toBe(2);
    expect(r.err).toContain("nope");
  });

  it("report --json lists warden-no-comments as proven", () => {
    init();
    const r = warden("report", "--json");
    expect(r.code, r.err).toBe(0);
    const report = JSON.parse(r.out) as { guardrails: { guardrail: string; strength: string; baselineRemaining: number }[]; tiers: unknown[] };
    expect(report.guardrails.find((g) => g.guardrail === "warden-no-comments")).toMatchObject({ strength: "proven", baselineRemaining: 1 });
    expect(report.tiers).toHaveLength(3);
  });

  it("check in a never-compiled project says to run warden compile", async () => {
    await mkdir(join(root, ".warden"));
    await writeFile(
      join(root, ".warden/config.yaml"),
      'warden: "0.1.0"\nproject: p\nbase: main\npacks:\n  - id: core\n    paths: ["**/*.ts"]\ntierBudgetMs: { edit: 1, commit: 1, boundary: 1 }\nloopBreakerRepeats: 3\n',
    );
    const r = warden("check", "--base", "main");
    expect(r.code).toBe(2);
    expect(r.err).toContain("warden compile");
  });

  it("check outside any project says to run warden init", () => {
    const r = warden("check", "--base", "main");
    expect(r.code).toBe(2);
    expect(r.err).toContain("warden init");
  });

  it("an invalid flag value is a usage error, exit 2", () => {
    init();
    expect(warden("check", "--base", "main", "--tier", "bogus").code).toBe(2);
    expect(warden("bogus").code).toBe(2);
  });

  it("check exits 1 when a Guardrail fails", async () => {
    init();
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    await writeFile(join(root, "src/b.ts"), "// new\nexport const b = 1;\n");
    expect(warden("check", "--base", "main").code).toBe(1);
  });

  it("a failed init leaves nothing behind, so the retry after the fix succeeds", async () => {
    await writeFile(join(root, "src/broken.ts"), "export const = ;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "broken");
    const r = warden("init");
    expect(r.code).toBe(2);
    expect(r.err).toContain("src/broken.ts");
    expect(r.err).toContain("Next action");
    expect(existsSync(join(root, ".warden"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    await writeFile(join(root, "src/broken.ts"), "export const b = 1;\n");
    expect(warden("init").code).toBe(0);
  });

  it("a failed init restores a settings file that already existed", async () => {
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, ".claude/settings.json"), '{"model":"x"}\n');
    await writeFile(join(root, "src/broken.ts"), "export const = ;\n");
    expect(warden("init").code).toBe(2);
    expect(await readFile(join(root, ".claude/settings.json"), "utf8")).toBe('{"model":"x"}\n');
    expect(existsSync(join(root, ".warden"))).toBe(false);
  });

  it("init outside a git repository exits 2 and leaves nothing behind", async () => {
    await rm(join(root, ".git"), { recursive: true });
    const r = warden("init");
    expect(r.code).toBe(2);
    expect(r.err).toContain("not a git repository");
    expect(existsSync(join(root, ".warden"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });

  it("compile exits 2 when records have findings", async () => {
    await mkdir(join(root, ".warden/packs/local"), { recursive: true });
    await writeFile(
      join(root, ".warden/config.yaml"),
      'warden: "0.1.0"\nproject: p\nbase: main\npacks:\n  - id: local\n    paths: ["src/**"]\ntierBudgetMs: { edit: 1, commit: 1, boundary: 1 }\nloopBreakerRepeats: 3\n',
    );
    await writeFile(
      join(root, ".warden/packs/local/pack.yaml"),
      [
        "id: local",
        "layer: 1",
        "terms: []",
        "practices:",
        "  - id: no-var",
        "    statement: Declare with const.",
        "    terms: []",
        "    paths: []",
        "    conflictsWith: []",
        "    guardrails:",
        "      - id: local-no-var",
        "        kind: lint",
        "        runs: [edit]",
        "        budgetMs: 5000",
        "        version: 1",
        '        implementation: "eslint:no-var"',
        '        mustFail: "const a = 1;\\n"',
        '        mustPass: "const a = 1;\\n"',
        "",
      ].join("\n"),
    );
    const r = warden("compile");
    expect(r.code).toBe(2);
    expect(r.err).toContain("example-failed");
  });

  it("hook mode reads the edited file from the hook input on stdin", async () => {
    init();
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    await writeFile(join(root, "src/b.ts"), "// new\nexport const b = 1;\n");
    const input = JSON.stringify({ tool_input: { file_path: join(root, "src/b.ts") } });
    const reasons = [1, 2, 3].map(() => (JSON.parse(wardenIn(root, input, "check", "--base", "main", "--format", "agent", "--hook", "claude").out) as { reason: string }).reason);
    expect(reasons[2]).toContain("Next action: stop editing this file");
    const bad = wardenIn(root, "not json", "check", "--base", "main", "--format", "agent", "--hook", "claude");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("hook input");
  });

  it("check from a subdirectory uses the repository root and resolves paths from the current directory", async () => {
    init();
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    await writeFile(join(root, "src/b.ts"), "// new\nexport const b = 1;\n");
    const r = wardenIn(join(root, "src"), "", "check", "b.ts", "--base", "main", "--format", "json");
    expect(r.code, r.err).toBe(1);
    expect((JSON.parse(r.out) as { failures: { file: string }[] }).failures.map((f) => f.file)).toEqual(["src/b.ts"]);
  });
});
