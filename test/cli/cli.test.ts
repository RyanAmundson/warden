import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const wardenRoot = resolve(import.meta.dirname, "../..");
const main = join(wardenRoot, "dist/src/cli/main.js");
const bundled = readdirSync(join(wardenRoot, "packs"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort((a, b) => a.localeCompare(b));
const everyPack = [...bundled, "local"].join(",");

let root: string;
let home: string;
let benched: string;

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

beforeAll(async () => {
  execFileSync("npx", ["tsc"], { cwd: wardenRoot, stdio: "ignore" });
  benched = await mkdtemp(join(tmpdir(), "warden-home-"));
  root = await mkdtemp(join(tmpdir(), "warden-cli-"));
  home = benched;
  await writeFile(join(root, "a.ts"), "export const a = 1;\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  expect(warden("init").code).toBe(0);
  await rm(root, { recursive: true, force: true });
});

afterAll(() => rm(benched, { recursive: true, force: true }));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-cli-"));
  home = await mkdtemp(join(tmpdir(), "warden-home-"));
  await cp(join(benched, "bench"), join(home, "bench"), { recursive: true });
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
    expect(r.out).not.toContain("FAIL src/add.ts:1  no-comments");
    expect(r.out).toContain("Do this:  export const add = (a: number, b: number) => a + b;\n            Fix the rule it hid.");
    expect(r.out).not.toContain("const a = 1");
  });

  it("the unstaged next action names a command that gets past the usage check", async () => {
    init();
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    await writeFile(join(root, "src/b.ts"), "export const b = 1;\n");
    git("add", "-A");
    await writeFile(join(root, "src/b.ts"), "export const b = 2;\n");
    const r = warden("check", "--base", "main");
    expect(r.code).toBe(1);
    const advised = /Next action: run git add -- 'src\/b\.ts', then run warden (check[^\n]*)\.$/m.exec(r.out)?.[1];
    expect(advised).toBe("check --base main");
    git("add", "--", "src/b.ts");
    const again = warden(...(advised as string).split(" "));
    expect(again.err).toBe("");
    expect(again.code).toBe(0);
  });

  it("bench with an unknown rule exits 2 with one next action", () => {
    init();
    const r = warden("bench", "--rule", "nope");
    expect(r.code).toBe(2);
    expect(r.err.match(/Next action:/g)).toHaveLength(1);
    expect(r.err).toContain('no Practice or Guardrail has id "nope"');
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

  it("report charges each shared ESLint pass once and keeps a review ESLint Guardrail's own cost", async () => {
    await mkdir(join(root, ".warden/packs/local"), { recursive: true });
    const guardrailYaml = (id: string, kind: string, rule: string, bad: string): string[] => [
      `      - id: ${id}`, `        kind: ${kind}`, "        runs: [edit]", "        budgetMs: 5000", "        version: 1", `        implementation: "eslint:${rule}"`,
      `        mustFail: "${bad}\\n"`, '        mustPass: "const y = 1;\\n"',
    ];
    await writeFile(
      join(root, ".warden/packs/local/pack.yaml"),
      ["id: local", "layer: 1", "terms: []", "practices:", "  - id: many", "    statement: Many rules.", "    terms: []", "    paths: []", "    conflictsWith: []", "    guardrails:",
        ...guardrailYaml("local-a", "lint", "no-var", "var a = 1;"), ...guardrailYaml("local-b", "lint", "no-debugger", "debugger;"), ...guardrailYaml("local-c", "lint", "no-eval", "eval(1);"), ...guardrailYaml("local-rev", "review", "no-empty", "if (a) {}"), ""].join("\n"),
    );
    const initRun = warden("init", "--packs", "core,local");
    expect(initRun.err).toBe("");
    expect(initRun.code).toBe(0);
    const project = JSON.parse(/^project: (.+)$/m.exec(await readFile(join(root, ".warden/config.yaml"), "utf8"))?.[1] as string) as string;
    const before = JSON.parse(warden("report", "--json").out) as { guardrails: { guardrail: string; kind: string }[] };
    const lint = before.guardrails.filter((g) => g.kind === "lint").map((g) => g.guardrail);
    expect(lint).toEqual(expect.arrayContaining(["local-a", "local-b", "local-c"]));
    const at = "2026-11-18T00:00:00.000Z";
    const rows = [
      { at, kind: "cost", shared: "eslint", guardrails: 1, members: ["local-old"], status: "pass", ms: 9999 },
      ...lint.map((guardrail) => ({ at, kind: "cost", guardrail, status: "pass", ms: 1000 })),
      ...[100, 200, 300].map((ms) => ({ at, kind: "cost", shared: "eslint", guardrails: lint.length, members: lint, status: "pass", ms })),
      ...[50, 70].map((ms) => ({ at, kind: "cost", guardrail: "local-rev", status: "pass", ms })),
    ];
    await mkdir(join(home, "evidence"), { recursive: true });
    await writeFile(join(home, "evidence", `${project}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    const report = JSON.parse(warden("report", "--json").out) as {
      guardrails: { guardrail: string; medianMs?: number; slowestMs?: number; costShared?: string }[];
      shared: { shared: string; guardrails: number; medianMs: number; slowestMs: number }[];
      tiers: { tier: string; medianMs: number; runs: number; packs: unknown[] }[];
    };
    expect(report.shared).toMatchObject([{ shared: "eslint", guardrails: lint.length, medianMs: 200, slowestMs: 300 }]);
    for (const g of report.guardrails.filter((x) => lint.includes(x.guardrail))) {
      expect(g).toMatchObject({ costShared: "eslint" });
      expect(g.medianMs).toBeUndefined();
      expect(g.slowestMs).toBeUndefined();
    }
    const review = report.guardrails.find((x) => x.guardrail === "local-rev");
    expect(review).toMatchObject({ medianMs: 60, slowestMs: 70 });
    expect(review?.costShared).toBeUndefined();
    expect(report.tiers.find((t) => t.tier === "edit")).toMatchObject({ medianMs: 0, runs: 0, packs: [] });
    const text = warden("report").out;
    expect(text).toContain(`eslint (shared, ${lint.length} guardrails)  median=200ms  slowest=300ms`);
    expect(text).toMatch(/local-a  kind=lint.*median=shared  slowest=shared/);
    expect(text).toMatch(/local-rev  kind=review.*median=60ms  slowest=70ms/);
    expect(text).toContain("tier edit: median 0ms, slowest 0ms of 2000ms over 0 runs");
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

  it("doctor, report, and explain outside any project say to run warden init", async () => {
    const outside = await mkdtemp(join(tmpdir(), "warden-outside-"));
    execFileSync("git", ["init", "-q"], { cwd: outside });
    try {
      for (const args of [["doctor"], ["report"], ["explain", "no-comments"]]) {
        const r = wardenIn(outside, "", ...args);
        expect(r.code, args.join(" ")).toBe(2);
        expect(r.err, args.join(" ")).toContain("not found. Next action: run warden init.");
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("check outside any project says to run warden init", () => {
    const r = warden("check", "--base", "main");
    expect(r.code).toBe(2);
    expect(r.err).toContain("warden init");
  });

  it("a base that does not exist ends in one next action", () => {
    init();
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    const r = warden("check", "--base", "nope");
    expect(r.code).toBe(2);
    expect(r.err).toContain('base ref "nope" does not exist. Next action: run warden check --base <an existing branch>');
  });

  const adoptedBase = async (base: string): Promise<void> => {
    expect(await readFile(join(root, ".warden/config.yaml"), "utf8")).toContain(`base: ${JSON.stringify(base)}`);
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    expect(warden("check", "--base", base).code).toBe(0);
  };

  it("init without a main branch asks for an existing base and writes the one it is given", async () => {
    git("branch", "-m", "trunk");
    const r = warden("init");
    expect(r.code).toBe(2);
    expect(r.err).toContain("Next action: run warden init --base <an existing branch>");
    expect(r.err).not.toContain("git checkout");
    expect(warden("init", "--base", "trunk").code).toBe(0);
    await adoptedBase("trunk");
  });

  it("init when main has no commit yet asks for an existing base and writes the one it is given", async () => {
    git("branch", "side");
    git("checkout", "-q", "--orphan", "fresh");
    git("branch", "-D", "main");
    git("symbolic-ref", "HEAD", "refs/heads/main");
    const r = warden("init");
    expect(r.code).toBe(2);
    expect(r.err).toContain("Next action: run warden init --base <an existing branch>");
    expect(warden("init", "--base", "side").code).toBe(0);
    expect(await readFile(join(root, ".warden/config.yaml"), "utf8")).toContain('base: "side"');
  });

  it("init when main exists only on the remote takes the remote ref as the base and leaves the branches alone", async () => {
    const bare = join(home, "bare.git");
    execFileSync("git", ["clone", "-q", "--bare", root, bare]);
    git("remote", "add", "origin", bare);
    git("fetch", "-q", "origin");
    git("checkout", "-q", "-b", "feat");
    git("branch", "-D", "main");
    const r = warden("init");
    expect(r.code).toBe(2);
    expect(r.err).toContain("Next action: run warden init --base origin/main");
    expect(warden("init", "--base", "origin/main").code).toBe(0);
    expect(await readFile(join(root, ".warden/config.yaml"), "utf8")).toContain('base: "origin/main"');
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    const adopted = warden("check", "--base", "origin/main");
    expect(adopted.err).toBe("");
    expect(adopted.code).toBe(1);
    expect(adopted.out).toContain("Next action: run git --literal-pathspecs restore --source=");
    expect(execFileSync("git", ["branch", "--list"], { cwd: root, encoding: "utf8" }).replace(/[* ]/g, "").split("\n").filter(Boolean)).toEqual(["feat"]);
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

  it("init and compile leave .claude/settings.json and package.json untouched and write only under .warden", async () => {
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, ".claude/settings.json"), '{"model":"x"}\n');
    await writeFile(join(root, "package.json"), '{"name":"p","scripts":{}}\n');
    git("add", "-A");
    git("commit", "-q", "-m", "settings");
    init();
    expect(warden("compile").code).toBe(0);
    expect(await readFile(join(root, ".claude/settings.json"), "utf8")).toBe('{"model":"x"}\n');
    expect(await readFile(join(root, "package.json"), "utf8")).toBe('{"name":"p","scripts":{}}\n');
    const changed = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).trim().split("\n");
    expect(changed.filter((line) => !line.startsWith("?? .warden/"))).toEqual([]);
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

  it("compile exits 2 on an unknown adapter and writes no lock", async () => {
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
        "  - id: no-x",
        "    statement: No x.",
        "    terms: []",
        "    paths: []",
        "    conflictsWith: []",
        "    guardrails:",
        "      - id: local-no-x",
        "        kind: lint",
        "        runs: [edit]",
        "        budgetMs: 5000",
        "        version: 1",
        '        implementation: "eslnt:no-x"',
        '        mustFail: "var a = 1;\\n"',
        '        mustPass: "const a = 1;\\n"',
        "",
      ].join("\n"),
    );
    const r = warden("compile");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^unknown-adapter local-no-x: .*Next action: set implementation to one of eslint:<\.\.\.>, tsc:<\.\.\.>, cmd:<\.\.\.> in \S*\/\.warden\/packs\/local\/pack\.yaml, then run warden compile\.$/m);
    expect(existsSync(join(root, ".warden/lock.json"))).toBe(false);
  });

  it("hook mode reads the edited file from the hook input on stdin", async () => {
    init();
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    await writeFile(join(root, "src/b.ts"), "// new\nexport const b = 1;\n");
    const input = JSON.stringify({ tool_input: { file_path: join(root, "src/b.ts") } });
    const { reason } = JSON.parse(wardenIn(root, input, "check", "--base", "main", "--format", "agent", "--hook", "claude").out) as { reason: string };
    expect(reason).toContain("FAIL src/b.ts:1");
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

  describe("pack picker", () => {
    const localPack = async (): Promise<void> => {
      await mkdir(join(root, ".warden/packs/local"), { recursive: true });
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
          '        mustFail: "var a = 1;\\n"',
          '        mustPass: "const a = 1;\\n"',
          "",
        ].join("\n"),
      );
    };

    it("report orders Practices by strongest kind and marks review-only ones promote", async () => {
      await mkdir(join(root, ".warden/packs/local"), { recursive: true });
      await writeFile(
        join(root, ".warden/packs/local/pack.yaml"),
        ["id: local", "layer: 1", "terms: []", "practices:", "  - id: no-var", "    statement: Declare with const.", "    terms: []", "    paths: []", "    conflictsWith: []", "    guardrails:",
          "      - id: local-no-var", "        kind: review", "        runs: [edit]", "        budgetMs: 5000", "        version: 1", '        implementation: "eslint:no-var"',
          '        mustFail: "var a = 1;\\n"', '        mustPass: "const a = 1;\\n"',
          "  - id: no-debugger", "    statement: No debugger statements.", "    terms: []", "    paths: []", "    conflictsWith: []", "    guardrails:",
          "      - id: local-no-debugger", "        kind: lint", "        runs: [edit]", "        budgetMs: 5000", "        version: 1", '        implementation: "eslint:no-debugger"',
          '        mustFail: "debugger;\\n"', '        mustPass: "const a = 1;\\n"', ""].join("\n"),
      );
      expect(warden("init", "--packs", "core,local").code).toBe(0);
      const json = JSON.parse(warden("report", "--format", "json").out) as { practices: { practice: string; strongestKind: string; promote: boolean }[] };
      const packs = JSON.parse(warden("packs", "--format", "json").out) as { packs: { id: string; kinds: Record<string, number> }[] };
      expect(packs.packs.find((p) => p.id === "local")?.kinds).toEqual({ lint: 1, review: 1 });
      expect(json.practices.at(-1)).toMatchObject({ practice: "no-var", strongestKind: "review", promote: true });
      expect(json.practices.slice(0, -1).every((p) => p.strongestKind === "lint" && !p.promote)).toBe(true);
      expect(json.practices.map((p) => p.practice).indexOf("no-debugger")).toBeLessThan(json.practices.map((p) => p.practice).indexOf("no-var"));
      const lines = warden("report").out.split("\n");
      expect(lines.filter((l) => l.startsWith("practice ")).at(-1)).toBe("practice no-var  strongest=review  promote");
    });

    it("report shows every Guardrail proven when a legacy one carries fixture trees, and explain prints the trees", async () => {
      await mkdir(join(root, ".warden/packs/local"), { recursive: true });
      await writeFile(
        join(root, ".warden/packs/local/pack.yaml"),
        ["id: local", "layer: 1", "terms: []", "practices:", "  - id: script-passes", "    statement: The script passes.", "    terms: []", "    paths: []", "    conflictsWith: []", "    guardrails:",
          "      - id: local-script", "        kind: legacy", "        runs: [commit]", "        budgetMs: 5000", "        version: 1", '        implementation: "cmd:test ! -e broken"',
          "        mustFail:", '          broken: "x\\n"', "        mustPass:", '          ok.txt: "x\\n"', ""].join("\n"),
      );
      expect(warden("init", "--packs", "core,local").code).toBe(0);
      const json = JSON.parse(warden("report", "--format", "json").out) as { guardrails: { guardrail: string; strength: string }[] };
      expect(json.guardrails.map((g) => g.guardrail)).toContain("local-script");
      expect(json.guardrails.filter((g) => g.strength !== "proven")).toEqual([]);
      expect(warden("explain", "local-script").out).toContain("    Violating example (mustFail):\n      broken:\n        x\n");
    });

    it("an instruction Guardrail beside a lint one reads prose, and no row reads unproven", async () => {
      await mkdir(join(root, ".warden/packs/local"), { recursive: true });
      await writeFile(
        join(root, ".warden/packs/local/pack.yaml"),
        ["id: local", "layer: 1", "terms: []", "practices:", "  - id: no-var", "    statement: Declare with const.", "    terms: []", "    paths: []", "    conflictsWith: []", "    guardrails:",
          "      - id: local-no-var", "        kind: lint", "        runs: [edit]", "        budgetMs: 5000", "        version: 1", '        implementation: "eslint:no-var"',
          '        mustFail: "var a = 1;\\n"', '        mustPass: "const a = 1;\\n"',
          "      - id: local-no-var-prose", "        kind: instruction", "        runs: [edit]", "        budgetMs: 100", "        version: 1", '        implementation: "instruction:CLAUDE.md"',
          '        mustFail: "var a = 1;\\n"', '        mustPass: "const a = 1;\\n"', ""].join("\n"),
      );
      expect(warden("init", "--packs", "core,local").code).toBe(0);
      const json = JSON.parse(warden("report", "--format", "json").out) as { guardrails: { guardrail: string; strength: string }[] };
      expect(json.guardrails.find((g) => g.guardrail === "local-no-var-prose")?.strength).toBe("prose");
      expect(json.guardrails.filter((g) => g.strength === "unproven")).toEqual([]);
      expect(warden("report").out).not.toContain("unproven");
    });

    it("packs lists bundled then local with on and off states", async () => {
      init();
      await localPack();
      const r = warden("packs");
      expect(r.code, r.err).toBe(0);
      const lines = r.out.trim().split("\n");
      expect(lines).toHaveLength(bundled.length + 1);
      expect(lines.find((l) => l.startsWith("core  "))).toMatch(/^core {2}bundled {2}\d+ practices {2}lint=\d+ {2}on {2}\*\*\/\*\.\{ts,tsx,js,mjs\}$/);
      expect(lines.at(-1)).toBe("local  local  1 practices  lint=1  off");
    });

    it("packs --format json returns the same data", async () => {
      init();
      await localPack();
      const data = JSON.parse(warden("packs", "--format", "json").out) as { packs: { id: string; source: string; practices: number; on: boolean; paths: string[] }[] };
      expect(data.packs.map((p) => [p.id, p.source, p.on])).toEqual([...bundled.map((id) => [id, "bundled", id === "core"]), ["local", "local", false]]);
      const core = data.packs.find((p) => p.id === "core");
      const local = data.packs.find((p) => p.id === "local");
      expect(local?.practices).toBe(1);
      expect(local).toMatchObject({ kinds: { lint: 1 } });
      expect(Object.keys((core as unknown as { kinds: object }).kinds)).toEqual(["lint"]);
      expect(core?.paths).toEqual(["**/*.{ts,tsx,js,mjs}"]);
    });

    it("packs without a config shows everything off and ends with the init next action", async () => {
      await localPack();
      const r = warden("packs");
      expect(r.code, r.err).toBe(0);
      expect(r.out).not.toContain("  on");
      expect(r.out.trim().split("\n").at(-1)).toBe(`Next action: run warden init --packs ${everyPack}`);
    });

    it("init takes the packs in layer order whatever order --packs lists them", async () => {
      await localPack();
      await writeFile(join(root, ".warden/packs/local/pack.yaml"), (await readFile(join(root, ".warden/packs/local/pack.yaml"), "utf8")).replace("layer: 1", "layer: 9"));
      const r = warden("init", "--packs", "local,core");
      expect(r.code, r.out + r.err).toBe(0);
    });

    it("init --packs core,local writes both, compiles, and locks both", async () => {
      await localPack();
      const r = warden("init", "--packs", "core,local");
      expect(r.code, r.err).toBe(0);
      const config = await readFile(join(root, ".warden/config.yaml"), "utf8");
      expect(config).toContain("  - id: core");
      expect(config).toContain("  - id: local");
      const lock = await readFile(join(root, ".warden/lock.json"), "utf8");
      expect(lock).toContain("local-no-var");
      expect(lock).toContain("warden-no-comments");
    });

    it("init --packs nope exits 2 and its next action works", async () => {
      await localPack();
      const r = warden("init", "--packs", "core,nope");
      expect(r.code).toBe(2);
      expect(r.err).toContain(`Next action: run warden init --packs ${everyPack}.`);
      expect(existsSync(join(root, ".warden/config.yaml"))).toBe(false);
      expect(warden("init", "--packs", "core,local").code).toBe(0);
    });

    it("init --packs without core exits 2 with the next action to add it", async () => {
      await localPack();
      const r = warden("init", "--packs", "local");
      expect(r.code).toBe(2);
      expect(r.err).toContain("Next action: run warden init --packs core,local.");
      expect(warden("init", "--packs", "core,local").code).toBe(0);
    });

    it("init refuses a .warden holding anything but packs and leaves it untouched", async () => {
      await mkdir(join(root, ".warden"), { recursive: true });
      await writeFile(join(root, ".warden/notes.txt"), "mine\n");
      const r = warden("init");
      expect(r.code).toBe(2);
      expect(r.err).toContain("Next action: move or delete .warden/notes.txt, then run warden init again.");
      expect(await readFile(join(root, ".warden/notes.txt"), "utf8")).toBe("mine\n");
      await rm(join(root, ".warden/notes.txt"));
      expect(warden("init").code).toBe(0);
    });

    it("init --packs trims ids and rejects an empty one with a working next action", async () => {
      await localPack();
      const r = warden("init", "--packs", "core,");
      expect(r.code).toBe(2);
      expect(r.err).toContain("empty pack id");
      expect(r.err).toContain(`Next action: run warden init --packs ${everyPack}.`);
      expect(warden("init", "--packs", " core , local ").code).toBe(0);
    });

    it("init --packs with a duplicate id exits 2", async () => {
      const r = warden("init", "--packs", "core,core");
      expect(r.code).toBe(2);
      expect(r.err).toContain("listed more than once");
    });
  });

  it("doctor prints one ok line per check and exits 0, and init runs it after writing its files", () => {
    const initialized = warden("init");
    expect(initialized.code, initialized.err).toBe(0);
    expect(initialized.out).toContain("ok    tool typescript\n");
    const r = warden("doctor");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("ok    tool eslint\nok    tool typescript-eslint\nok    tool typescript\nok    tool warden eslint plugin\nok    git pre-commit hook: .warden/generated/hooks/pre-commit\n");
  });

  it("doctor exits 2 with the failing item and one next action", async () => {
    init();
    await mkdir(join(root, ".warden/packs/local"), { recursive: true });
    await writeFile(
      join(root, ".warden/packs/local/pack.yaml"),
      ["id: local", "layer: 1", "terms: []", "practices:", "  - id: script-passes", "    statement: The script passes.", "    terms: []", "    paths: []", "    conflictsWith: []", "    guardrails:",
        "      - id: local-script", "        kind: legacy", "        runs: [boundary]", "        budgetMs: 5000", "        version: 1", '        implementation: "cmd:npm run test:changed"',
        "        mustFail:", '          broken: "x\\n"', "        mustPass:", '          ok.txt: "x\\n"', ""].join("\n"),
    );
    await writeFile(join(root, ".warden/config.yaml"), (await readFile(join(root, ".warden/config.yaml"), "utf8")).replace("tierBudgetMs:", '  - id: local\n    paths: ["src/**"]\ntierBudgetMs:'));
    const r = warden("doctor");
    expect(r.code, r.err).toBe(2);
    expect(r.out).toContain('FAIL  cmd local-script: npm run test:changed  package.json has no "test:changed" script\n');
    expect(r.out.match(/Next action:/g)).toHaveLength(1);
    expect(r.out).toContain('Next action: add a "test:changed" script to package.json, then run warden doctor\n');
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { "test:changed": "true" } }));
    expect(warden("doctor").code).toBe(0);
  });

  it("check --trigger git-commit records its trigger, and runs --format json shows it", () => {
    init();
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    expect(warden("check", "--base", "main", "--trigger", "git-commit").code).toBe(0);
    expect(warden("check", "--base", "main", "--trigger", "agent").code).toBe(2);
    const r = warden("runs", "--format", "json");
    expect(r.code, r.err).toBe(0);
    expect((JSON.parse(r.out) as { trigger: string }[]).map((e) => e.trigger)).toEqual(["git-commit"]);
  });

  it("plain warden outside a terminal prints the view once as plain text and exits 0", () => {
    init();
    const r = warden();
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(" WARDEN  ");
    expect(r.out).toContain(" NOW  ");
    expect(r.out).not.toContain("\x1b");
  });

  it("a closed stdout ends init and runs --follow quietly with the exit code of the work done", async () => {
    const closed = (...args: string[]): Promise<{ code: number | null; err: string }> =>
      new Promise((done) => {
        const child = spawn("node", [main, ...args], { cwd: root, env: { ...process.env, WARDEN_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.destroy();
        let err = "";
        child.stderr.on("data", (chunk: Buffer) => {
          err += chunk.toString();
        });
        child.on("close", (code) => done({ code, err }));
      });
    expect(await closed("init")).toEqual({ code: 0, err: "" });
    expect(existsSync(join(root, ".warden/baseline.json"))).toBe(true);
    expect(await closed("runs", "--follow")).toEqual({ code: 0, err: "" });
  });

  it("a bundled tool that does not load stops check and doctor with one line and one next action", async () => {
    init();
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    const copy = await mkdtemp(join(tmpdir(), "warden-copy-"));
    try {
      for (const entry of ["dist", "packs", "package.json"]) await cp(join(wardenRoot, entry), join(copy, entry), { recursive: true });
      await mkdir(join(copy, "node_modules"));
      for (const entry of readdirSync(join(wardenRoot, "node_modules")).filter((e) => e !== "typescript-eslint")) {
        await symlink(join(wardenRoot, "node_modules", entry), join(copy, "node_modules", entry));
      }
      const run = (...args: string[]) => spawnSync("node", [join(copy, "dist/src/cli/main.js"), ...args], { cwd: root, encoding: "utf8", env: { ...process.env, WARDEN_HOME: home } });
      const checked = run("check", "--base", "main");
      expect(checked.status).toBe(2);
      expect(checked.stderr).toContain("Warden's bundled typescript-eslint does not load: Cannot find module");
      expect(checked.stderr).toContain("Next action: reinstall Warden so its bundled typescript-eslint loads, then run warden doctor.");
      expect(checked.stderr).not.toContain("Require stack");
      const doctor = run("doctor");
      expect(doctor.status).toBe(2);
      expect(doctor.stdout).toMatch(/^FAIL {2}tool typescript-eslint {2}Cannot find module [^\n]*$/m);
      expect(doctor.stdout).not.toContain("Require stack");
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it("a base that exists only on the remote names the git command that creates it, and following it passes", async () => {
    init();
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    git("checkout", "-q", "-b", "feature");
    const clones = await mkdtemp(join(tmpdir(), "warden-clones-"));
    try {
      for (const [name, extra, action] of [
        ["tracking", [], "git branch main origin/main"],
        ["single", ["--single-branch"], "git fetch origin main:main"],
      ] as const) {
        const clone = join(clones, name);
        execFileSync("git", ["clone", "-q", ...extra, "-b", "feature", root, clone], { stdio: "ignore" });
        const r = wardenIn(clone, "", "check", "--base", "main");
        expect(r.code).toBe(2);
        expect(r.err).toContain(`base ref "main" does not exist. Next action: run ${action}, then run the same warden command again`);
        execFileSync("git", action.split(" ").slice(1), { cwd: clone, stdio: "ignore" });
        expect(wardenIn(clone, "", "check", "--base", "main").code).toBe(0);
      }
    } finally {
      await rm(clones, { recursive: true, force: true });
    }
  });

  it("--version prints the version in Warden's package", async () => {
    const r = warden("--version");
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${(JSON.parse(await readFile(join(wardenRoot, "package.json"), "utf8")) as { version: string }).version}\n`);
  });

  it("a bad option value exits 2 with one next action naming the command", () => {
    init();
    const r = warden("runs", "--format", "xml");
    expect(r.code).toBe(2);
    expect(r.err).toBe("--format must be one of text, json. Next action: run warden runs --help\n");
  });

  it("warden --layers outside a terminal prints the layers screen once as plain text and lists only packs that exist", () => {
    init();
    const r = warden("--layers");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(" LAYERS  strongest first");
    expect(r.out).toMatch(/ PACKS {3}[●○] /);
    expect(r.out).toMatch(/● core \(bundled, \d+ rules?\)/);
    const shown = [...r.out.matchAll(/[●○] (\S+) \(bundled/g)].map((m) => m[1]);
    expect(shown).toContain("core");
    expect(shown.filter((id) => !bundled.includes(id as string))).toEqual([]);
    expect(r.out).not.toContain("\x1b");
  });

  it("warden --violations outside a terminal prints the violations screen once, from the baseline, before and without any Evidence", async () => {
    init();
    const r = warden("--violations");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^ WARDEN .* v back {2}d determinism\n/);
    expect(r.out).toMatch(/\n VIOLATIONS BY PACK +baselined +new +last run\n/);
    expect(r.out).toMatch(/\n core +█+ +1 +– *\n/);
    expect(r.out).toMatch(/\n {3}warden-no-comments +█+ +1 +– *\n/);
    expect(r.out).toContain(" Next action: press r to run warden check");
    expect(r.out).not.toContain("\x1b");
    await rm(join(root, ".warden/baseline.json"));
    const bare = warden("--violations");
    expect(bare.code, bare.err).toBe(0);
    expect(bare.out).toMatch(/\n core +▏ +0 +– *\n/);
    const narrow = spawnSync("node", [main, "--violations"], { cwd: root, encoding: "utf8", env: { ...process.env, WARDEN_HOME: home, COLUMNS: "60" } });
    expect(narrow.stdout.split("\n").every((l) => l.length <= 60)).toBe(true);
    expect(narrow.stdout).toContain(`${"─".repeat(60)}\n`);
    expect(warden("--violations", "--layers").err).toBe("--layers, --violations, and --determinism each open one screen. Next action: run warden with only one of them\n");
  });

  it("warden --determinism outside a terminal prints every project's last run split by band, from the kinds warden check records", async () => {
    init();
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    const project = (await readFile(join(root, ".warden/config.yaml"), "utf8")).match(/^project: "?([^"\n]+)"?$/m)?.[1] as string;
    const before = warden("--determinism");
    expect(before.code, before.err).toBe(0);
    expect(before.out).toMatch(/\n ▸ \S+ +no completed run yet\n/);
    expect(before.out).toContain(" No project has a completed run. Next action: press r to run warden check");
    await writeFile(join(root, "src/add.ts"), "// eslint-disable-next-line\nexport const add = (a: number, b: number) => a + b;\n");
    expect(warden("check", "--base", "main").code).toBe(1);
    const run = (await readFile(join(home, "evidence", `${project}.jsonl`), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { guardrail?: string; outcome?: string; kinds?: Record<string, number> }).filter((e) => e.guardrail === "run").at(-1);
    expect(run?.kinds).toEqual({ lint: 1 });
    await writeFile(join(home, "evidence", "older.jsonl"), `${JSON.stringify({ at: "2026-11-18T10:00:00.000Z", kind: "cost", guardrail: "run", run: "o1", outcome: "ran", result: "fail", failures: [{ file: "a.ts", line: 1, guardrail: "x", practice: "x" }] })}\n`);
    const wide = spawnSync("node", [main, "--determinism"], { cwd: root, encoding: "utf8", env: { ...process.env, WARDEN_HOME: home, COLUMNS: "120" } });
    const r = { code: wide.status, out: wide.stdout, err: wide.stderr };
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^ WARDEN .* d back\n/);
    expect(r.out).toMatch(/\n DETERMINISM BY PROJECT +deterministic +judgment +prose +unknown +det\. share\n/);
    expect(r.out).toMatch(new RegExp(`\\n ▸ ${project} +█+ +1 +0 +0 +0 +100%\\n`));
    expect(r.out).toMatch(/\n {3}older +·+ +0 +0 +0 +1 +–\n/);
    expect(r.out).not.toContain("\x1b");
    expect(warden("--determinism", "--layers").code).toBe(2);
  });
});

describe("the commit-tier git hook", () => {
  const commit = (path: string): { code: number | null; out: string; err: string } => {
    const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x"], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: path, WARDEN_HOME: home } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  let bin: string;
  const tools = (): string => `${bin}:/usr/bin:/bin`;

  beforeEach(async () => {
    bin = await mkdtemp(join(tmpdir(), "warden-bin-"));
    await symlink(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
  });

  afterEach(() => rm(bin, { recursive: true, force: true }));

  it("init points git at the locked, executable pre-commit hook under .warden", async () => {
    init();
    expect(execFileSync("git", ["config", "core.hooksPath"], { cwd: root, encoding: "utf8" }).trim()).toBe(".warden/generated/hooks");
    const lock = JSON.parse(await readFile(join(root, ".warden/lock.json"), "utf8")) as { generated: Record<string, string> };
    expect(Object.keys(lock.generated)).toContain(".warden/generated/hooks/pre-commit");
    expect(execFileSync("sh", ["-c", "test -x .warden/generated/hooks/pre-commit && echo yes"], { cwd: root, encoding: "utf8" })).toBe("yes\n");
  });

  it("a commit runs Warden's commit check and is refused when a Guardrail fails", async () => {
    init();
    await writeFile(join(bin, "warden"), `#!/bin/sh\nexec "${process.execPath}" "${main}" "$@"\n`, { mode: 0o755 });
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    await writeFile(join(root, "src/b.ts"), "// new\nexport const b = 1;\n");
    git("add", "-A");
    const refused = commit(tools());
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("FAIL src/b.ts:1");
    await writeFile(join(root, "src/b.ts"), "export const b = 1;\n");
    git("add", "-A");
    expect(commit(tools()).code).toBe(0);
  });

  it("a commit with no warden on PATH is refused with the install command as its one next action", () => {
    init();
    git("add", "-A");
    const r = commit(tools());
    expect(r.code).not.toBe(0);
    const version = (JSON.parse(readFileSync(join(wardenRoot, "package.json"), "utf8")) as { version: string }).version;
    expect(r.err).toContain(`Next action: run npm install -g git+https://github.com/RyanAmundson/warden.git#v${version}, then commit again.`);
    expect(r.err.match(/Next action/g)).toHaveLength(1);
  });

  it("init leaves a project's own hooks in force, and doctor names the one line that chains Warden's", async () => {
    await mkdir(join(root, "hooks"));
    git("config", "core.hooksPath", "hooks");
    const r = warden("init");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Next action: make hooks/pre-commit an executable script that runs .warden/generated/hooks/pre-commit and exits with its status, then run warden doctor\n");
    expect(execFileSync("git", ["config", "core.hooksPath"], { cwd: root, encoding: "utf8" }).trim()).toBe("hooks");
    await writeFile(join(root, "hooks/pre-commit"), "#!/bin/sh\n.warden/generated/hooks/pre-commit || exit $?\n", { mode: 0o755 });
    expect(warden("doctor").code).toBe(0);
  });

  it("doctor in a fresh clone names the git config command that installs the hook", () => {
    init();
    git("config", "--unset", "core.hooksPath");
    const r = warden("doctor");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Next action: run git config core.hooksPath .warden/generated/hooks, then run warden doctor\n");
  });
});

describe("the Claude Code plugin hook", () => {
  const script = join(wardenRoot, "hooks/warden.sh");
  let shims: string;
  let system: string;

  beforeEach(async () => {
    shims = await mkdtemp(join(tmpdir(), "warden-shims-"));
    await mkdir(join(shims, "tools"));
    await symlink(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(shims, "tools/git"));
    system = `${join(shims, "tools")}:/usr/bin:/bin`;
    await writeFile(join(shims, "warden"), `#!/bin/sh\nexec "${process.execPath}" "${main}" "$@"\n`, { mode: 0o755 });
  });

  afterEach(() => rm(shims, { recursive: true, force: true }));

  const hook = (event: string, input: unknown, path = `${shims}:${system}`): { code: number | null; out: string; err: string } => {
    const r = spawnSync("sh", [script, event], { cwd: root, input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, PATH: path, WARDEN_HOME: home } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  const edit = (file: string): unknown => ({ tool_name: "Edit", tool_input: { file_path: join(root, file) } });
  const bash = (command: string): unknown => ({ tool_name: "Bash", tool_input: { command } });
  const denied = (r: { out: string }): string | undefined =>
    r.out === "" ? undefined : (JSON.parse(r.out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason;

  it("does nothing in a project with no .warden/config.yaml, even without warden on PATH", () => {
    for (const event of ["guard", "check"]) expect(hook(event, bash("git commit -n -m x"), system)).toEqual({ code: 0, out: "", err: "" });
  });

  const pluginVersion = (): string => (JSON.parse(readFileSync(join(wardenRoot, ".claude-plugin/plugin.json"), "utf8")) as { version: string }).version;

  const versionShim = async (version: string): Promise<void> => {
    await writeFile(join(shims, "warden"), `#!/bin/sh\n[ "$1" = --version ] && echo ${version} && exit 0\nexec "${process.execPath}" "${main}" "$@"\n`, { mode: 0o755 });
  };

  it("the plugin's version is the package's version", () => {
    expect(pluginVersion()).toBe((JSON.parse(readFileSync(join(wardenRoot, "package.json"), "utf8")) as { version: string }).version);
  });

  it.each([
    ["missing", undefined],
    ["older", "0.0.1"],
  ])("with warden %s, blocks edits and commits with the install command and lets the install run", async (_case, version) => {
    init();
    if (version !== undefined) await versionShim(version);
    const path = version === undefined ? system : `${shims}:${system}`;
    const install = `npm install -g git+https://github.com/RyanAmundson/warden.git#v${pluginVersion()}`;
    for (const [event, input] of [["guard", edit("src/a.ts")], ["guard", bash("git add -A && git commit -m x")], ["check", edit("src/a.ts")]] as const) {
      const r = hook(event, input, path);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`Next action: run ${install}.`);
      expect(r.err.match(/Next action/g)).toHaveLength(1);
    }
    expect(hook("guard", bash(install), path)).toEqual({ code: 0, out: "", err: "" });
  });

  it("with warden matching or newer than the plugin, hands the call to warden", async () => {
    init();
    expect(denied(hook("guard", bash("git commit -n")))).toContain("-n skips the pre-commit hook");
    await versionShim("99.0.0");
    expect(denied(hook("guard", bash("git commit -n")))).toContain("-n skips the pre-commit hook");
    expect(hook("guard", bash("npm test"))).toEqual({ code: 0, out: "", err: "" });
  });

  it("refuses an edit under .warden and allows one elsewhere", () => {
    init();
    expect(denied(hook("guard", edit(".warden/config.yaml")))).toContain("Next action: tell the user what to change in .warden/config.yaml");
    expect(denied(hook("guard", { tool_name: "Write", tool_input: { file_path: join(root, ".warden/new.yaml") } }))).toContain(".warden/new.yaml");
    expect(hook("guard", edit("src/a.ts"))).toEqual({ code: 0, out: "", err: "" });
  });

  it("refuses a git commit that skips the pre-commit hook and allows one whose message only mentions -n", () => {
    init();
    expect(denied(hook("guard", bash("git add -A && git commit -an")))).toContain("Next action: run the git commit again with -a in place of -an.");
    expect(denied(hook("guard", bash("git commit --no-verify -m x")))).toContain("Next action: run the git commit again without --no-verify.");
    expect(hook("guard", bash('git commit -m "skip -n here"'))).toEqual({ code: 0, out: "", err: "" });
  });

  it("returns the edit check's block decision after an edit", async () => {
    init();
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    await writeFile(join(root, "src/b.ts"), "// new\nexport const b = 1;\n");
    const r = hook("check", edit("src/b.ts"));
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ decision: "block" });
    expect((JSON.parse(r.out) as { reason: string }).reason).toContain("FAIL src/b.ts:1");
    await writeFile(join(root, "src/b.ts"), "export const b = 1;\n");
    expect(hook("check", edit("src/b.ts"))).toEqual({ code: 0, out: "", err: "" });
  });

  const codexCommand = (event: "PreToolUse" | "PostToolUse"): string => {
    const config = JSON.parse(readFileSync(join(wardenRoot, "hooks/codex.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    return (config.hooks[event] as { hooks: { command: string }[] }[])[0]?.hooks[0]?.command as string;
  };
  const codex = (event: "PreToolUse" | "PostToolUse", input: unknown): { code: number | null; out: string; err: string } => {
    const r = spawnSync("sh", ["-c", codexCommand(event)], { cwd: root, input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, PATH: `${shims}:${system}`, WARDEN_HOME: home, PLUGIN_ROOT: wardenRoot } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const patch = (...lines: string[]): unknown => ({ tool_name: "apply_patch", tool_input: { command: ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n") } });

  it("the Codex plugin's version is the package's version, and its manifest names the Codex hooks", () => {
    const manifest = JSON.parse(readFileSync(join(wardenRoot, ".codex-plugin/plugin.json"), "utf8")) as { version: string; hooks: string };
    expect(manifest.version).toBe(pluginVersion());
    expect(existsSync(join(wardenRoot, manifest.hooks))).toBe(true);
  });

  it("the Codex hooks refuse a patch under .warden, and block after a patch that breaks a Guardrail", async () => {
    init();
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    expect(denied(codex("PreToolUse", patch("*** Update File: src/a.ts", "*** Add File: .warden/x.yaml", "+x")))).toContain(".warden/x.yaml is a Warden record");
    expect(codex("PreToolUse", patch("*** Update File: src/a.ts"))).toEqual({ code: 0, out: "", err: "" });
    expect(denied(codex("PreToolUse", bash("git commit -n")))).toContain("-n skips the pre-commit hook");
    await writeFile(join(root, "src/b.ts"), "// new\nexport const b = 1;\n");
    const r = codex("PostToolUse", patch("*** Add File: src/b.ts", "+// new", "+export const b = 1;"));
    expect(r.code, r.err).toBe(0);
    expect((JSON.parse(r.out) as { decision: string; reason: string }).reason).toContain("FAIL src/b.ts:1");
  });

  it("turns a warden crash into a block with one next action", async () => {
    init();
    await writeFile(join(shims, "warden"), `#!/bin/sh\n[ "$1" = --version ] && echo ${pluginVersion()} && exit 0\nexit 7\n`, { mode: 0o755 });
    const r = hook("guard", edit("src/a.ts"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("warden exited 7. Next action: run warden doctor");
  });
});
