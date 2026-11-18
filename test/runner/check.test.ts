import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eslintAdapter } from "../../src/adapters/eslint.js";
import type { RunResult } from "../../src/adapters/types.js";
import { runCheck } from "../../src/cli/check.js";
import { compile } from "../../src/compiler/compile.js";
import { sha256 } from "../../src/compiler/lock.js";
import { applyBaseline } from "../../src/runner/baseline.js";

const wardenRoot = resolve(import.meta.dirname, "../..");

const config = (packs: string[], repeats = 3): string =>
  [
    "warden: \"0.1.0\"",
    "project: fixture",
    "base: main",
    "packs:",
    ...packs.flatMap((id) => [`  - id: ${id}`, "    paths: [\"**/*.ts\"]"]),
    "tierBudgetMs: { edit: 2000, commit: 30000, boundary: 120000 }",
    `loopBreakerRepeats: ${repeats}`,
    "",
  ].join("\n");

const localPack = (version = 1, budgetMs = 5000): string =>
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
    `        budgetMs: ${budgetMs}`,
    `        version: ${version}`,
    "        implementation: \"eslint:no-var\"",
    "        mustFail: \"var a = 1;\\n\"",
    "        mustPass: \"const a = 1;\\n\"",
    "",
  ].join("\n");

let template: string;
let root: string;
let home: string;

const git = (...args: string[]): string =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const write = async (file: string, content: string): Promise<void> => {
  await mkdir(resolve(root, file, ".."), { recursive: true });
  await writeFile(join(root, file), content);
};

const read = (file: string): Promise<string> => readFile(join(root, file), "utf8");

const evidence = async (): Promise<Record<string, unknown>[]> => {
  const text = await readFile(join(home, "evidence/fixture.jsonl"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

const tampered = async (): Promise<{ file: unknown; detail: unknown }[]> =>
  (await evidence()).filter((e) => e.kind === "tampered").map((e) => ({ file: e.file, detail: e.detail }));

const check = async (opts: Partial<Parameters<typeof runCheck>[0]> = {}): Promise<{ code: number; out: string; err: string }> => {
  let out = "";
  let err = "";
  const o = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const e = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  try {
    const code = await runCheck({ root, wardenRoot, format: "text", ...opts });
    return { code, out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
};

const failedFiles = (out: string): string[] =>
  (JSON.parse(out) as { failures: { file: string }[] }).failures.map((f) => f.file);

beforeAll(async () => {
  template = await realpath(await mkdtemp(join(tmpdir(), "warden-check-template-")));
  root = template;
  await write(".warden/config.yaml", config(["core", "local"]));
  await write(".warden/packs/local/pack.yaml", localPack());
  await write(".gitignore", "node_modules\n");
  const { findings } = await compile(template, wardenRoot);
  expect(findings).toEqual([]);
});

afterAll(() => rm(template, { recursive: true, force: true }));

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "warden-check-")));
  home = await mkdtemp(join(tmpdir(), "warden-home-"));
  vi.stubEnv("WARDEN_HOME", home);
  await cp(template, root, { recursive: true });
  await write("a.ts", "// one\nconst a = 1;\n");
  await write(".warden/baseline.json", `${JSON.stringify({ "warden-no-comments": { "a.ts": 1 } }, null, 2)}\n`);
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("runCheck", () => {
  it("new violation fails, baselined one passes", async () => {
    await write("a.ts", "// one\nconst a = 2;\n");
    await write("b.ts", "// two\nconst b = 1;\n");
    const { code, out } = await check({ format: "json" });
    expect(code).toBe(1);
    expect(failedFiles(out)).toEqual(["b.ts"]);
  });

  it("fixing shrinks the baseline", async () => {
    await write("a.ts", "const a = 1;\n");
    const { code } = await check();
    expect(code).toBe(0);
    expect(JSON.parse(await read(".warden/baseline.json"))).toEqual({});
  });

  it("deleted file drops its entries", async () => {
    await rm(join(root, "a.ts"));
    const { code } = await check();
    expect(code).toBe(0);
    expect(JSON.parse(await read(".warden/baseline.json"))).toEqual({});
  });

  it("hand-edited generated config is tampering", async () => {
    await writeFile(join(root, ".warden/generated/eslint.rules.json"), `${await read(".warden/generated/eslint.rules.json")}\n`);
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/generated/eslint.rules.json", detail: "generated-drift" }]);
    expect(out).toContain("Next action: revert your change to .warden/generated/eslint.rules.json");
  });

  it("removing a Guardrail against base is loosening", async () => {
    await write(".warden/config.yaml", config(["core"]));
    await rm(join(root, ".warden/packs/local"), { recursive: true });
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    const { code } = await check();
    expect(code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "loosened" }]);
  });

  it("raising a budget against base is loosening", async () => {
    await write(".warden/packs/local/pack.yaml", localPack(1, 9000));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    const { code } = await check();
    expect(code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "loosened" }]);
  });

  it("raising a baseline entry against base is loosening", async () => {
    await write(".warden/baseline.json", JSON.stringify({ "warden-no-comments": { "a.ts": 2 } }));
    const { code } = await check();
    expect(code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/baseline.json", detail: "loosened" }]);
  });

  it("unknown base exits 2", async () => {
    git("branch", "-m", "main", "trunk");
    const { code, err } = await check();
    expect(code).toBe(2);
    expect(err).toContain("main");
  });

  it("not a repository exits 2", async () => {
    await rm(join(root, ".git"), { recursive: true, force: true });
    const { code, err } = await check();
    expect(code).toBe(2);
    expect(err).toContain("not a git repository");
  });

  it("unchanged file hits the cache", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    const spy = vi.spyOn(eslintAdapter, "run");
    expect((await check()).code).toBe(1);
    expect((await check()).code).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("version bump bypasses the cache", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    const spy = vi.spyOn(eslintAdapter, "run");
    expect((await check()).code).toBe(1);
    await write(".warden/packs/local/pack.yaml", localPack(2));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    spy.mockClear();
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toContain("b.ts");
    expect(out).toContain("FAIL b.ts:1  no-comments");
  });

  it("loop breaker prints after repeats", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    const runs = [await check(), await check(), await check()];
    expect(runs.map((r) => r.code)).toEqual([1, 1, 1]);
    expect(runs[0]?.out).not.toContain("Same failure");
    expect(runs[1]?.out).not.toContain("Same failure");
    expect(runs[2]?.out).toContain("Same failure 3 times: fix the code to match the compliant example.");
    expect(runs[2]?.out).toContain(
      "Next action: this failure repeated 3 times. Rewrite the code to follow \"Do this\", or file warden dispute warden-no-comments b.ts listing the approaches you tried. Stopping without either is recorded as stalled.",
    );
  });

  it("feedback names rule, example, and one next action", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out).toContain("FAIL b.ts:1  no-comments");
    expect(out).toContain("Rule:     Source files carry no comments.");
    expect(out).toContain("Do this:  const a = 1;");
    expect(out).toContain("Why:      warden explain no-comments");
    expect(out.split("\n").filter((l) => l.startsWith("Next action:"))).toEqual([
      "Next action: change the code at the lines above to match \"Do this\". Do not edit .warden/ or generated config; that is recorded as tampering.",
    ]);
    expect(out).not.toMatch(/blocked|cannot proceed/i);
    const fired = (await evidence()).filter((e) => e.kind === "fired");
    expect(fired).toEqual([
      expect.objectContaining({ guardrail: "warden-no-comments", file: "b.ts", status: "fail", detail: sha256("// two\nconst b = 1;\n") }),
    ]);
    expect((await evidence()).some((e) => e.kind === "cost" && typeof e.ms === "number")).toBe(true);
  });

  it("hook format blocks with reason", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    const failing = await check({ format: "agent", hook: "claude" });
    expect(failing.code).toBe(0);
    const parsed = JSON.parse(failing.out) as { decision: string; reason: string };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("Next action:");
    await write("b.ts", "const b = 1;\n");
    const passing = await check({ format: "agent", hook: "claude" });
    expect(passing).toEqual({ code: 0, out: "", err: "" });
  });

  it("explicit paths are checked instead of changed files", async () => {
    const { code, out } = await check({ paths: ["a.ts"], format: "json" });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ failures: [], tampered: [], next: null });
  });

  it("rule narrows the run to one practice", async () => {
    await write("b.ts", "// two\nvar b = 1;\n");
    const { code, out } = await check({ rule: "no-var", format: "json" });
    expect(code).toBe(1);
    expect((JSON.parse(out) as { failures: { guardrail: string }[] }).failures.map((f) => f.guardrail)).toEqual(["local-no-var"]);
    expect((await check({ rule: "nope" })).code).toBe(2);
  });

  it("missing lock is tampering", async () => {
    await rm(join(root, ".warden/lock.json"));
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "missing-lock" }]);
  });

  it("leftover temp file is tampering, outside node_modules", async () => {
    await write("node_modules/x/y.json.warden-tmp-1", "{}");
    expect((await check()).code).toBe(0);
    await write(".warden/generated/eslint.rules.json.warden-tmp-99", "{}");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/generated/eslint.rules.json.warden-tmp-99", detail: "leftover-temp" }]);
  });

  it("disabling hooks in either settings file is tampering", async () => {
    await write(".claude/settings.local.json", JSON.stringify({ disableAllHooks: true }));
    expect((await check()).code).toBe(1);
    const settings = JSON.parse(await read(".claude/settings.json")) as Record<string, unknown>;
    await write(".claude/settings.json", JSON.stringify({ ...settings, disableAllHooks: true }));
    await rm(join(root, ".claude/settings.local.json"));
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([
      { file: ".claude/settings.local.json", detail: "hooks-disabled" },
      { file: ".claude/settings.json", detail: "hooks-disabled" },
    ]);
  });

  it("removing a Warden settings entry is drift, other settings edits are not", async () => {
    const settings = JSON.parse(await read(".claude/settings.json")) as { permissions: { deny: string[] } };
    await write(".claude/settings.json", JSON.stringify({ ...settings, model: "x", permissions: { deny: [...settings.permissions.deny, "Bash(rm*)"] } }));
    expect((await check()).code).toBe(0);
    await write(".claude/settings.json", JSON.stringify({ ...settings, permissions: { deny: settings.permissions.deny.slice(1) } }));
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".claude/settings.json", detail: "generated-drift" }]);
  });

  it("record edits without compile are source drift", async () => {
    await write(".warden/config.yaml", config(["core", "local"], 5));
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/config.yaml", detail: "source-drift" }]);
  });

  it("a lock edited to match a hand-edited config is lock drift", async () => {
    const edited = `${await read(".warden/generated/eslint.rules.json")}\n`;
    await write(".warden/generated/eslint.rules.json", edited);
    const lock = JSON.parse(await read(".warden/lock.json")) as { generated: Record<string, string> };
    lock.generated[".warden/generated/eslint.rules.json"] = sha256(edited);
    await write(".warden/lock.json", JSON.stringify(lock));
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "lock-drift" }]);
  });
});

describe("applyBaseline", () => {
  const result = (guardrail: string, files: string[], status: RunResult["status"] = "fail"): RunResult => ({
    guardrail,
    status,
    violations: files.map((file) => ({ guardrail, file, line: 1, message: "m" })),
    ms: 1,
  });

  it("ignores violations in files that were not scanned", () => {
    const { failures, next } = applyBaseline([result("tsc:baseline-errors", ["other.ts"])], {}, ["a.ts"], () => true);
    expect(failures).toEqual([]);
    expect(next).toEqual({});
  });

  it("keys project-wide violations under the empty file", () => {
    const baseline = { legacy: { "": 1 } };
    expect(applyBaseline([result("legacy", [""])], baseline, ["a.ts"], () => true)).toEqual({ failures: [], next: baseline });
    expect(applyBaseline([result("legacy", ["", ""])], baseline, ["a.ts"], () => true).failures).toHaveLength(2);
  });

  it("over budget fails and keeps the baseline", () => {
    const baseline = { g: { "a.ts": 2 } };
    const { failures, next } = applyBaseline([result("g", [], "over-budget")], baseline, ["a.ts"], () => true);
    expect(failures.map((f) => f.guardrail)).toEqual(["g"]);
    expect(next).toEqual(baseline);
  });
});
