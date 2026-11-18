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
    const advised = /Next action: stage or discard unstaged changes, then run warden (check[^\n]*)\.$/m.exec(r.out)?.[1];
    expect(advised).toBe("check --base main");
    git("add", "-A");
    const again = warden(...(advised as string).split(" "));
    expect(again.err).toBe("");
    expect(again.code).toBe(0);
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
      tiers: { tier: string; medianTotalMs: number }[];
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
    expect(report.tiers.find((t) => t.tier === "edit")?.medianTotalMs).toBe(260);
    const text = warden("report").out;
    expect(text).toContain(`eslint (shared, ${lint.length} guardrails)  median=200ms  slowest=300ms`);
    expect(text).toMatch(/local-a  kind=lint.*median=shared  slowest=shared/);
    expect(text).toMatch(/local-rev  kind=review.*median=60ms  slowest=70ms/);
    expect(text).toContain("tier edit: 260ms of");
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
      expect(lines[0]).toMatch(/^core {2}bundled {2}\d+ practices {2}lint=\d+ {2}on {2}\*\*\/\*\.\{ts,tsx,js,mjs\}$/);
      expect(lines[1]).toBe("local  local  1 practices  lint=1  off");
    });

    it("packs --format json returns the same data", async () => {
      init();
      await localPack();
      const data = JSON.parse(warden("packs", "--format", "json").out) as { packs: { id: string; source: string; practices: number; on: boolean; paths: string[] }[] };
      expect(data.packs.map((p) => [p.id, p.source, p.on])).toEqual([
        ["core", "bundled", true],
        ["local", "local", false],
      ]);
      expect(data.packs[1]?.practices).toBe(1);
      expect(data.packs[1]).toMatchObject({ kinds: { lint: 1 } });
      expect(Object.keys((data.packs[0] as unknown as { kinds: object }).kinds)).toEqual(["lint"]);
      expect(data.packs[0]?.paths).toEqual(["**/*.{ts,tsx,js,mjs}"]);
    });

    it("packs without a config shows everything off and ends with the init next action", async () => {
      await localPack();
      const r = warden("packs");
      expect(r.code, r.err).toBe(0);
      expect(r.out).not.toContain("  on");
      expect(r.out.trim().split("\n").at(-1)).toBe("Next action: run warden init --packs core,local");
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
      expect(r.err).toContain("Next action: run warden init --packs core,local.");
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
      expect(r.err).toContain("Next action: run warden init --packs core,local.");
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
    expect(r.out).toBe("ok    tool eslint\nok    tool typescript-eslint\nok    tool typescript\nok    tool warden eslint plugin\n");
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
});
