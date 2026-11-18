import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ESLint } from "eslint";
import { eslintAdapter } from "../../src/adapters/eslint.js";
import { PARSE_ERROR, type RunResult } from "../../src/adapters/types.js";
import { runCheck } from "../../src/cli/check.js";
import { runInit } from "../../src/cli/init.js";
import { compile } from "../../src/compiler/compile.js";
import { readLock, sha256 } from "../../src/compiler/lock.js";
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
    "        runs: [edit, commit]",
    `        budgetMs: ${budgetMs}`,
    `        version: ${version}`,
    "        implementation: \"eslint:no-var\"",
    "        mustFail: \"var a = 1;\\n\"",
    "        mustPass: \"const a = 1;\\n\"",
    "  - id: no-event-global",
    "    statement: Never read the event global.",
    "    terms: []",
    "    paths: []",
    "    conflictsWith: []",
    "    guardrails:",
    "      - id: local-no-event",
    "        kind: lint",
    "        runs: [edit, commit]",
    "        budgetMs: 5000",
    "        version: 1",
    "        implementation: \"eslint:no-restricted-globals\"",
    "        options: [\"event\"]",
    "        mustFail: \"export const a = event;\\n\"",
    "        mustPass: \"const a = 1;\\n\"",
    "",
  ].join("\n");

const LOCAL_PATHS = '  - id: local\n    paths: ["**/*.ts"]';

const withLocalPaths = (paths: string): string => config(["core", "local"]).replace(LOCAL_PATHS, `  - id: local\n    paths: ${paths}`);

const legacyPack = (runs: string, command: string, budgetMs: number): string =>
  [
    "id: legacy",
    "layer: 2",
    "terms: []",
    "practices:",
    "  - id: legacy-check",
    "    statement: The legacy script passes.",
    "    terms: []",
    "    paths: []",
    "    conflictsWith: []",
    "    guardrails:",
    "      - id: legacy-script",
    "        kind: legacy",
    `        runs: [${runs}]`,
    `        budgetMs: ${budgetMs}`,
    "        version: 1",
    `        implementation: ${JSON.stringify(`cmd:${command}`)}`,
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

const check = async (opts: Partial<Parameters<typeof runCheck>[0]> = {}, stage = true): Promise<{ code: number; out: string; err: string }> => {
  if (stage && opts.hook === undefined && (opts.tier ?? "commit") === "commit" && existsSync(join(root, ".git"))) git("add", "-A");
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
    const code = await runCheck({ root, wardenRoot, format: "text", base: "main", ...opts });
    return { code, out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
};

const addLegacy = async (runs: string, command: string, budgetMs: number): Promise<void> => {
  await write(".warden/config.yaml", config(["core", "local", "legacy"]));
  await write(".warden/packs/legacy/pack.yaml", legacyPack(runs, command, budgetMs));
  expect((await compile(root, wardenRoot)).findings).toEqual([]);
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
    expect(await tampered()).toEqual([
      { file: ".warden/lock.json", detail: "loosened" },
      { file: ".warden/lock.json", detail: "loosened" },
    ]);
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

  it("loop breaker prints after repeats of an explicit path", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    const runs = [await check({ paths: ["b.ts"] }), await check({ paths: ["b.ts"] }), await check({ paths: ["b.ts"] })];
    expect(runs.map((r) => r.code)).toEqual([1, 1, 1]);
    expect(runs[0]?.out).not.toContain("Same failure");
    expect(runs[1]?.out).not.toContain("Same failure");
    expect(runs[2]?.out).toContain("Same failure 3 times: warden-no-comments in b.ts.");
    expect(runs[2]?.out.split("\n").filter((l) => l.startsWith("Next action:"))).toEqual([
      "Next action: stop editing this file; in your reply, name the rule and file, quote its Do this line, and say why it does not fit; then continue with other work.",
    ]);
    expect(runs[2]?.out).not.toContain("dispute");
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
    expect(JSON.parse(out)).toEqual({ failures: [], tampered: [], overBudget: [], killed: [], next: null });
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

  it("leftover temp file is tampering only where Warden writes", async () => {
    await write("notes/y.json.warden-tmp-1", "{}");
    await write(".claude/worktrees/w/settings.json.warden-tmp-1", "{}");
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

describe("ruling fixes", () => {
  it("runs only Guardrails whose tiers include the requested tier", async () => {
    await addLegacy("boundary", "exit 1", 5000);
    await write("b.ts", "const b = 1;\n");
    expect((await check({ tier: "edit" })).code).toBe(0);
    expect((await check({ tier: "commit" })).code).toBe(0);
    expect((await check()).code).toBe(0);
    expect((await check({ hook: "claude", format: "agent", tier: "boundary" })).out).toBe("");
    expect((await check({ tier: "boundary" })).code).toBe(1);
  });

  it("a removed .warden is tampering when base has a lock", async () => {
    await rm(join(root, ".warden"), { recursive: true });
    expect((await check()).code).toBe(1);
    git("add", "-A");
    git("commit", "-q", "-m", "drop warden");
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out).toContain("Next action: revert your change to .warden");
    expect(await tampered()).toEqual([
      { file: ".warden", detail: "removed" },
      { file: ".warden", detail: "removed" },
    ]);
  });

  it("raising loopBreakerRepeats against base is loosening", async () => {
    await write(".warden/config.yaml", config(["core", "local"], 5));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "loosened" }]);
  });

  it("raising a tier budget against base is loosening", async () => {
    await write(".warden/config.yaml", config(["core", "local"]).replace("edit: 2000", "edit: 3000"));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "loosened" }]);
  });

  it("a parse error is a failure with a syntax next action, never cached or baselined", async () => {
    await write("a.ts", "// one\nconst = ;\n");
    await write("b.ts", "const = ;\n");
    const spy = vi.spyOn(eslintAdapter, "run");
    const first = await check();
    expect(first.code).toBe(1);
    expect(first.out).toContain("FAIL b.ts:1  warden:parse-error");
    expect(first.out.split("\n").filter((l) => l.startsWith("Next action:"))).toEqual(["Next action: fix the syntax error at a.ts:2."]);
    expect((await check()).code).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await read(".warden/baseline.json"))).toEqual({ "warden-no-comments": { "a.ts": 1 } });
  });

  it("a Guardrail killed at its budget fails and says to run its command directly", async () => {
    await addLegacy("commit", "sleep 2", 200);
    await write("b.ts", "const b = 1;\n");
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out).toMatch(/^ {2}Reason: {3}stopped at \d+ ms: did not finish within its 200 ms budget$/m);
    expect(out.split("\n").filter((l) => l.startsWith("Next action:"))).toEqual([
      "Next action: run `sleep 2` directly to see why it does not finish.",
    ]);
    expect(out).not.toMatch(/blocked|cannot proceed/i);
  });
});

describe("review fixes", () => {
  const recompile = async (): Promise<void> => {
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
  };

  it("dropping a tier and recompiling is loosening", async () => {
    await write(".warden/packs/local/pack.yaml", localPack().replace("runs: [edit, commit]", "runs: [edit]"));
    await recompile();
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "loosened" }]);
  });

  it("narrowing paths and recompiling is loosening", async () => {
    await write(".warden/config.yaml", withLocalPaths('["src/**/*.ts"]'));
    await recompile();
    expect((await check()).code).toBe(1);
    expect((await tampered()).map((t) => t.detail)).toEqual(["loosened", "loosened"]);
  });

  it("changing options and recompiling is loosening", async () => {
    await write(".warden/packs/local/pack.yaml", localPack().replace('options: ["event"]', 'options: ["event", "name"]'));
    await recompile();
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "loosened" }]);
  });

  it("changing kind to instruction and recompiling is loosening", async () => {
    const extra = [
      "      - id: local-no-debugger",
      "        kind: lint",
      "        runs: [edit, commit]",
      "        budgetMs: 5000",
      "        version: 1",
      "        implementation: \"eslint:no-debugger\"",
      "        mustFail: \"debugger;\\n\"",
      "        mustPass: \"const a = 1;\\n\"",
      "  - id: no-event-global",
    ].join("\n");
    const pack = localPack().replace("kind: lint", "kind: instruction").replace("  - id: no-event-global", extra);
    await write(".warden/packs/local/pack.yaml", pack);
    await recompile();
    await write("b.ts", "var b = 1;\n");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "loosened" }]);
  });

  it("a Guardrail runs only where the pack paths and the Practice paths both match", async () => {
    await write(".warden/config.yaml", config(["core", "local"]).replace('paths: ["**/*.ts"]', 'paths: ["src/**/*.ts"]'));
    await recompile();
    git("add", "-A");
    git("commit", "-q", "-m", "narrow");
    git("branch", "-f", "main", "HEAD");
    expect(readLock(root).guardrails["warden-no-comments"]?.paths).toEqual(["**/*.{ts,tsx,mts,cts,js,mjs,cjs} & src/**/*.ts"]);
    await write("fixtures/y.ts", "// c\nconst y = 1;\n");
    expect((await check({ paths: ["fixtures/y.ts"] })).code).toBe(0);
    await write("src/x.ts", "// c\nconst x = 1;\n");
    expect((await check({ paths: ["src/x.ts"] })).code).toBe(1);
  });

  it("adding a path and recompiling passes", async () => {
    await write(".warden/config.yaml", withLocalPaths('["**/*.ts", "lib/**/*.ts"]'));
    await recompile();
    expect((await check()).code).toBe(0);
    expect(await tampered()).toEqual([]);
  });

  it("a cached result from an earlier lock is not reused", async () => {
    await write(".warden/config.yaml", withLocalPaths('["src/**/*.ts"]'));
    await recompile();
    git("add", "-A");
    git("commit", "-q", "-m", "narrow");
    git("branch", "-f", "main", "HEAD");
    await write("b.ts", "var b = 1;\n");
    expect((await check()).code).toBe(0);
    await write(".warden/config.yaml", withLocalPaths('["src/**/*.ts", "**/*.ts"]'));
    await recompile();
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out).toContain("FAIL b.ts:1  no-var");
  });

  it("base comparisons use the merge base, not the base tip", async () => {
    git("checkout", "-q", "main");
    await write("a.ts", "const a = 1;\n");
    await write(".warden/baseline.json", "{}\n");
    git("commit", "-q", "-am", "main burns down");
    git("checkout", "-q", "feature");
    const { code, out } = await check();
    expect(out).toBe("");
    expect(code).toBe(0);
  });

  it("type errors a change causes in other files fail at commit tier only", async () => {
    await symlink(join(wardenRoot, "node_modules"), join(root, "node_modules"));
    await write("package.json", "{}\n");
    await write(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: true }, include: ["c.ts", "d.ts"] }),
    );
    await write("c.ts", "export type T = { n: number };\n");
    await write("d.ts", 'import type { T } from "./c.js";\nexport const x: T = { n: 1 };\n');
    await write(".warden/config.yaml", config(["core", "local", "types"]));
    await write(
      ".warden/packs/types/pack.yaml",
      [
        "id: types",
        "layer: 2",
        "terms: []",
        "practices:",
        "  - id: strict-null",
        "    statement: Values are never possibly undefined.",
        "    terms: []",
        "    paths: []",
        "    conflictsWith: []",
        "    guardrails:",
        "      - id: types-strict-null",
        "        kind: type",
        "        runs: [edit, commit]",
        "        budgetMs: 60000",
        "        version: 1",
        "        implementation: \"tsc:strictNullChecks\"",
        "        mustFail: \"export function f(a?: string) { return a.length; }\\n\"",
        "        mustPass: \"const a = 1;\\n\"",
        "",
      ].join("\n"),
    );
    await recompile();
    git("add", "-A");
    git("commit", "-q", "-m", "types");
    git("branch", "-f", "main", "HEAD");
    await write("c.ts", "export type T = { n: string };\n");
    expect((await check({ tier: "edit" })).code).toBe(0);
    const { code, out } = await check({ format: "json" });
    expect(code).toBe(1);
    expect(failedFiles(out)).toEqual(["d.ts"]);
  });
});

const slowLint = (ms: number): void => {
  const real = performance.now.bind(performance);
  let skew = 0;
  vi.spyOn(performance, "now").mockImplementation(() => real() + skew);
  const lint = ESLint.prototype.lintFiles;
  vi.spyOn(ESLint.prototype, "lintFiles").mockImplementation(async function (this: ESLint, files) {
    const out = await lint.call(this, files);
    if (![files].flat().some((f) => f.includes("warden-example"))) skew += ms;
    return out;
  });
};

describe("final review: budgets", () => {
  it("a lint Guardrail over budget still counts and caches its violations, and records a Warden defect", async () => {
    await write("b.ts", "var b = 1;\n");
    slowLint(6000);
    const first = await check();
    expect(first.code).toBe(1);
    expect(first.out).toContain("FAIL b.ts:1  no-var");
    expect(first.out).toMatch(/^WARDEN DEFECT {2}no-var$/m);
    expect((await evidence()).filter((e) => e.kind === "cost" && e.status === "over-budget").map((e) => e.guardrail)).toContain("local-no-var");
    const spy = vi.mocked(ESLint.prototype.lintFiles);
    spy.mockClear();
    expect((await check()).code).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a lint Guardrail over budget with no violations passes", async () => {
    await write("b.ts", "const b = 1;\n");
    slowLint(6000);
    const { code, out } = await check();
    expect(code).toBe(0);
    expect(out).toMatch(/^WARDEN DEFECT {2}no-comments$/m);
    expect(out).toContain("Next action: continue your task; nothing in your code failed.");
  });

  it("init baselines the whole repository without Guardrail budgets", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "warden-init-")));
    try {
      await writeFile(join(repo, "a.ts"), "// c\nconst a = 1;\n");
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "init", "-q", "-b", "main"], { cwd: repo });
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "s"], { cwd: repo });
      slowLint(60000);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(await runInit(repo, wardenRoot)).toBe(0);
      expect(JSON.parse(await readFile(join(repo, ".warden/baseline.json"), "utf8"))).toEqual({ "warden-no-comments": { "a.ts": 1 } });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("final review: legacy feedback", () => {
  it("a legacy failure shows the command output and says to run the command", async () => {
    await addLegacy("commit", "echo broken thing; exit 1", 5000);
    await write("b.ts", "const b = 1;\n");
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out).toContain("  Output:   echo broken thing; exit 1 exited with 1\n            broken thing");
    expect(out.split("\n").filter((l) => l.startsWith("Next action:"))).toEqual([
      "Next action: run `echo broken thing; exit 1` and fix what it reports.",
    ]);
  });
});

describe("final review: project-wide baseline", () => {
  it("a baseline entry for the whole project is tampering, so it cannot silence a legacy Guardrail", async () => {
    await addLegacy("commit", "exit 1", 5000);
    await write(".warden/baseline.json", JSON.stringify({ "warden-no-comments": { "a.ts": 1 }, "legacy-script": { "": 1 } }));
    const { code } = await check();
    expect(code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/baseline.json", detail: "loosened" }]);
  });
});

describe("final review: changed lines and renames", () => {
  it("a comment swapped for another at equal count fails on the changed line", async () => {
    await write("a.ts", "// rewritten\nconst a = 1;\n");
    const { code, out } = await check({ format: "json" });
    expect(code).toBe(1);
    expect(failedFiles(out)).toEqual(["a.ts"]);
  });

  it("a violation on a changed line fails at the edit tier too", async () => {
    await write("a.ts", "// rewritten\nconst a = 1;\n");
    expect((await check({ tier: "edit" })).code).toBe(1);
  });

  it("a changed line in a file whose name has a space fails", async () => {
    await write("a b.ts", "const x = 1;\n");
    await write(".warden/baseline.json", `${JSON.stringify({ "warden-no-comments": { "a.ts": 1, "a b.ts": 1 } })}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "spaced");
    git("branch", "-f", "main", "HEAD");
    await write("a b.ts", "// c\nconst x = 1;\n");
    expect((await check()).code).toBe(1);
  });

  it("an untouched baselined line still passes when other lines change", async () => {
    await write("a.ts", "// one\nconst a = 1;\nexport const b = a;\n");
    expect((await check()).code).toBe(0);
  });

  it("a renamed file keeps its baselined counts", async () => {
    git("mv", "a.ts", "renamed.ts");
    expect((await check()).code).toBe(0);
    expect(JSON.parse(await read(".warden/baseline.json"))).toEqual({ "warden-no-comments": { "renamed.ts": 1 } });
    const again = await check();
    expect(again.code).toBe(0);
    expect(await tampered()).toEqual([]);
  });

  it("a renamed file still fails on its changed lines", async () => {
    git("mv", "a.ts", "renamed.ts");
    await write("renamed.ts", "// one\nconst a = 1;\n// two\n");
    const { code, out } = await check({ format: "json" });
    expect(code).toBe(1);
    expect((JSON.parse(out) as { failures: { file: string; line: number }[] }).failures.map((f) => `${f.file}:${f.line}`)).toEqual(["renamed.ts:3"]);
  });
});

describe("final review: lock records base and project", () => {
  it("pointing base at the working branch and recompiling is loosening", async () => {
    await write(".warden/config.yaml", config(["core", "local"]).replace("base: main", "base: feature"));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect(readLock(root).config.base).toBe("feature");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "loosened" }]);
  });

  it("renaming the project and recompiling is loosening", async () => {
    await write(".warden/config.yaml", config(["core", "local"]).replace("project: fixture", "project: other"));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out).toContain("TAMPERED .warden/lock.json  loosened");
  });

  const commitBaseLock = async (edit: (lock: Record<string, unknown>) => void): Promise<void> => {
    git("checkout", "-q", "main");
    const lock = JSON.parse(await read(".warden/lock.json")) as Record<string, unknown>;
    edit(lock);
    await write(".warden/lock.json", JSON.stringify(lock));
    git("commit", "-q", "-am", "base lock");
  };

  const unformatted = (lock: Record<string, unknown>): void => {
    delete lock.format;
    const config = lock.config as Record<string, unknown>;
    delete config.base;
    delete config.project;
    for (const g of Object.values(lock.guardrails as Record<string, Record<string, unknown>>)) delete g.kind;
  };

  it("upgrading a pre-format base lock on the base branch passes", async () => {
    await commitBaseLock(unformatted);
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    const { code, out, err } = await check();
    expect(err).toBe("");
    expect(code, out).toBe(0);
    expect(await tampered()).toEqual([]);
  });

  it("a pre-format base lock still catches loosening in the fields it shares", async () => {
    await commitBaseLock(unformatted);
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-edit", "main");
    await write(".warden/packs/local/pack.yaml", localPack(1, 9000));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "loosened" }]);
  });

  it("a base lock from a newer Warden exits 2 and says to update Warden", async () => {
    await commitBaseLock((lock) => {
      lock.format = 2;
    });
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-edit", "main");
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    const { code, err } = await check();
    expect(code).toBe(2);
    expect(err).toContain("Next action: update this project's Warden to the release that wrote the lock on main");
  });
});

describe("final review: loop breaker", () => {
  const hook = (file: string) => check({ format: "agent", hook: "claude", hookInput: JSON.stringify({ tool_input: { file_path: join(root, file) } }) });

  it("repeated checks of changed files that nobody named never trip the loop breaker", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    const runs = [await check(), await check(), await check()];
    expect(runs.map((r) => r.code)).toEqual([1, 1, 1]);
    expect(runs[2]?.out).not.toContain("Same failure");
  });

  it("hook runs after edits to another file do not count as repeats", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    await write("c.ts", "const c = 1;\n");
    const runs = [await hook("c.ts"), await hook("c.ts"), await hook("c.ts")];
    expect(runs.map((r) => (JSON.parse(r.out) as { reason: string }).reason).some((r) => r.includes("Same failure"))).toBe(false);
  });

  it("hook runs after edits to the failing file trip the loop breaker", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    const runs = [await hook("b.ts"), await hook("b.ts"), await hook("b.ts")];
    expect((JSON.parse(runs[2]?.out ?? "") as { reason: string }).reason).toContain("Next action: stop editing this file");
  });
});

describe("final review: commit tier judges the index", () => {
  it("unstaged changes to a scanned tracked file fail the commit tier with a stage-or-discard next action", async () => {
    await write("a.ts", "// one\nconst a = 2;\n");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    expect(out).toContain("UNSTAGED a.ts");
    expect(out.split("\n").filter((l) => l.startsWith("Next action:"))).toEqual(["Next action: stage or discard unstaged changes, then run warden check again."]);
    expect((await check({ tier: "edit" }, false)).code).toBe(0);
    git("add", "a.ts");
    expect((await check({}, false)).code).toBe(0);
  });
});

describe("residual fixes", () => {
  const rebase = (): void => {
    git("add", "-A");
    git("commit", "-q", "-m", "rebase");
    git("branch", "-f", "main", "HEAD");
  };

  it("a rewrite inside a baselined multi-line comment fails", async () => {
    await write("a.ts", "/* one\n   two */\nconst a = 1;\n");
    rebase();
    await write("a.ts", "/* one\n   rewritten */\nconst a = 1;\n");
    const { code, out } = await check({ format: "json" });
    expect(code).toBe(1);
    expect(failedFiles(out)).toEqual(["a.ts"]);
  });

  it("a base committed as the agent's own branch is loosening against the base the hook names", async () => {
    await write(".warden/config.yaml", config(["core", "local"]).replace("base: main", "base: feature"));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    git("add", "-A");
    git("commit", "-q", "-m", "own base");
    expect((await check({ base: "main" })).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "loosened" }]);
  });

  it("check without --base exits 2 and names the command to run", async () => {
    const { code, err } = await check({ base: undefined });
    expect(code).toBe(2);
    expect(err).toContain("Next action: run warden check --base main");
  });

  it("the emitted hook command names the base it was compiled with", async () => {
    const settings = JSON.parse(await read(".claude/settings.json")) as { hooks: { PostToolUse: { hooks: { command: string }[] }[] } };
    expect(settings.hooks.PostToolUse.flatMap((e) => e.hooks.map((h) => h.command))).toEqual([
      "npx --no -- warden check --format agent --hook claude --base 'main'",
    ]);
  });
});

describe("residual fixes: baseline writes", () => {
  it("a plain mv followed by an edit-tier check keeps the moved file's baseline entries", async () => {
    const before = await read(".warden/baseline.json");
    await rename(join(root, "a.ts"), join(root, "moved.ts"));
    await check({ tier: "edit", paths: ["moved.ts"] });
    expect(await read(".warden/baseline.json")).toBe(before);
    git("add", "-A");
    expect((await check()).code).toBe(0);
    expect(JSON.parse(await read(".warden/baseline.json"))).toEqual({ "warden-no-comments": { "moved.ts": 1 } });
  });
});

describe("residual fixes: commit tier stages the baseline it writes", () => {
  it("a shrunk baseline is staged, so the next commit-tier check passes", async () => {
    await write("a.ts", "const a = 1;\n");
    expect((await check()).code).toBe(0);
    expect(git("diff", "--name-only")).toBe("");
    const { code, out } = await check({}, false);
    expect(code, out).toBe(0);
  });
});

describe("residual fixes: after a carried rename", () => {
  beforeEach(async () => {
    git("mv", "a.ts", "renamed.ts");
    expect((await check()).code).toBe(0);
    expect(JSON.parse(await read(".warden/baseline.json"))).toEqual({ "warden-no-comments": { "renamed.ts": 1 } });
  });

  it("deleting the renamed file is not loosening", async () => {
    git("rm", "-q", "-f", "renamed.ts");
    const { code, out } = await check();
    expect(await tampered()).toEqual([]);
    expect(code, out).toBe(0);
  });

  it("renaming the file back is not loosening", async () => {
    git("mv", "renamed.ts", "a.ts");
    const { code, out } = await check();
    expect(await tampered()).toEqual([]);
    expect(code, out).toBe(0);
  });
});

describe("residual fixes: path widening", () => {
  const usePaths = async (paths: string): Promise<void> => {
    await write(".warden/config.yaml", withLocalPaths(paths));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
  };

  beforeEach(async () => {
    await usePaths('["**/*.{ts,tsx}"]');
    git("add", "-A");
    git("commit", "-q", "-m", "brace paths");
    git("branch", "-f", "main", "HEAD");
  });

  it("a same-prefix superset brace list counts as covered", async () => {
    await usePaths('["**/*.{ts,tsx,js}"]');
    const { code, out } = await check();
    expect(await tampered()).toEqual([]);
    expect(code, out).toBe(0);
  });

  it("a brace list that drops a member is loosening", async () => {
    await usePaths('["**/*.{ts,js}"]');
    expect((await check()).code).toBe(1);
    expect((await tampered()).map((t) => t.detail)).toEqual(["loosened", "loosened"]);
  });

  it("a superset brace list under another prefix is loosening", async () => {
    await usePaths('["src/**/*.{ts,tsx,js}"]');
    expect((await check()).code).toBe(1);
    expect((await tampered()).map((t) => t.detail)).toEqual(["loosened", "loosened"]);
  });
});

describe("applyBaseline", () => {
  const result =(guardrail: string, files: string[], status: RunResult["status"] = "fail"): RunResult => ({
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

  it("project-wide violations always fail and are never baselined", () => {
    const { failures, next } = applyBaseline([result("legacy", [""])], {}, ["a.ts"], () => true);
    expect(failures).toHaveLength(1);
    expect(next).toEqual({});
  });

  it("a killed result keeps the baseline", () => {
    const baseline = { g: { "a.ts": 2 } };
    expect(applyBaseline([result("g", [], "killed")], baseline, ["a.ts"], () => true)).toEqual({ failures: [], next: baseline });
  });

  it("never absorbs a parse error", () => {
    const baseline = { [PARSE_ERROR]: { "a.ts": 1 }, g: { "a.ts": 1 } };
    const { failures, next } = applyBaseline([result(PARSE_ERROR, ["a.ts", "other.ts"]), result("g", [], "pass")], baseline, ["a.ts"], () => true);
    expect(failures.map((f) => f.file)).toEqual(["a.ts"]);
    expect(next).toEqual({ g: { "a.ts": 1 } });
  });
});
