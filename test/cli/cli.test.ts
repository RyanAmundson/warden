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

const warden = (...args: string[]): { code: number | null; out: string; err: string } => {
  const r = spawnSync("node", [main, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, WARDEN_HOME: home } });
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
    expect(warden("check").code).toBe(0);
  });

  it("init refuses when .warden exists", () => {
    init();
    const r = warden("init");
    expect(r.code).toBe(2);
    expect(r.err).toContain("already exists");
  });

  it("explain no-comments prints its compliant example path", () => {
    init();
    const r = warden("explain", "no-comments");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Compliant example (mustPass)");
    expect(r.out).toContain("const a = 1;");
    expect(r.out).toContain("warden-no-comments");
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
    const r = warden("check");
    expect(r.code).toBe(2);
    expect(r.err).toContain("warden compile");
  });

  it("check outside any project says to run warden init", () => {
    const r = warden("check");
    expect(r.code).toBe(2);
    expect(r.err).toContain("warden init");
  });

  it("an invalid flag value is a usage error, exit 2", () => {
    init();
    expect(warden("check", "--tier", "bogus").code).toBe(2);
    expect(warden("bogus").code).toBe(2);
  });

  it("check exits 1 when a Guardrail fails", async () => {
    init();
    git("add", "-A");
    git("commit", "-q", "-m", "adopt");
    await writeFile(join(root, "src/b.ts"), "// new\nexport const b = 1;\n");
    expect(warden("check").code).toBe(1);
  });
});
