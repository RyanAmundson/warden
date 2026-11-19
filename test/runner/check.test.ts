import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ESLint } from "eslint";
import { COMMAND_CHARS, runIt } from "../../src/adapters/cmd.js";
import { eslintAdapter } from "../../src/adapters/eslint.js";
import { PARSE_ERROR, type RunResult } from "../../src/adapters/types.js";
import { runCheck } from "../../src/cli/check.js";
import { runInit } from "../../src/cli/init.js";
import { compile, expectedOutputs } from "../../src/compiler/compile.js";
import { readLock, sha256 } from "../../src/compiler/lock.js";
import { loadRecords } from "../../src/records/load.js";
import { applyBaseline } from "../../src/runner/baseline.js";
import { LOOP_TAIL_BYTES } from "../../src/runner/evidence.js";
import { findTampering, recordedBases } from "../../src/runner/tamper.js";

const packageRoot = resolve(import.meta.dirname, "../..");
let wardenRoot: string;
let keys: string;

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
    "        mustFail:",
    '          broken: "x\\n"',
    "        mustPass:",
    '          ok.txt: "x\\n"',
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

const pub = (name: string): string => readFileSync(join(keys, `${name}.pub`), "utf8").trim();
const signers = (...names: string[]): string => names.map((n) => `ryan ${pub(n)}\n`).join("");
const commitSigned = (key: string, message: string): void => {
  git("-c", "gpg.format=ssh", "-c", "gpg.ssh.program=ssh-keygen", "-c", `user.signingkey=${join(keys, key)}`, "commit", "-q", "-S", "-m", message);
};

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

let templateHome: string;

beforeAll(async () => {
  keys = await mkdtemp(join(tmpdir(), "warden-keys-"));
  for (const name of ["ryan", "agent"]) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", join(keys, name)]);
  wardenRoot = await mkdtemp(join(tmpdir(), "warden-package-"));
  for (const entry of await readdir(packageRoot)) if (entry !== "allowed_signers" && entry !== ".git") await symlink(join(packageRoot, entry), join(wardenRoot, entry));
  await writeFile(join(wardenRoot, "allowed_signers"), signers("ryan"));
  templateHome = await mkdtemp(join(tmpdir(), "warden-home-"));
  vi.stubEnv("WARDEN_HOME", templateHome);
  template = await realpath(await mkdtemp(join(tmpdir(), "warden-check-template-")));
  root = template;
  await write(".warden/config.yaml", config(["core", "local"]));
  await write(".warden/packs/local/pack.yaml", localPack());
  await write(".gitignore", "node_modules\n");
  const { findings } = await compile(template, wardenRoot);
  expect(findings).toEqual([]);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(template, { recursive: true, force: true });
  await rm(templateHome, { recursive: true, force: true });
  await rm(keys, { recursive: true, force: true });
  await rm(wardenRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await writeFile(join(wardenRoot, "allowed_signers"), signers("ryan"));
  root = await realpath(await mkdtemp(join(tmpdir(), "warden-check-")));
  home = await mkdtemp(join(tmpdir(), "warden-home-"));
  vi.stubEnv("WARDEN_HOME", home);
  await cp(join(templateHome, "bench"), join(home, "bench"), { recursive: true });
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

  it("unchanged file hits the cache at the edit tier", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    const spy = vi.spyOn(eslintAdapter, "run");
    expect((await check({ tier: "edit" })).code).toBe(1);
    expect((await check({ tier: "edit" })).code).toBe(1);
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
      `Next action: stop editing this file and run warden dispute 'warden-no-comments' '${join(root, "b.ts")}' with --reason and --attempt describing what you tried, then continue with other work.`,
    ]);
  });

  it("the loop breaker counts only repeats in the last LOOP_TAIL_BYTES of Evidence, so an old failure does not count and check never reads the whole history", async () => {
    const source = "// two\nconst b = 1;\n";
    await write("b.ts", source);
    const old = { at: "t", kind: "fired", guardrail: "warden-no-comments", file: "b.ts", status: "fail", detail: sha256(source), triggered: true };
    const step = `${JSON.stringify({ at: "t", kind: "step" })}\n`;
    const filler = step.repeat(Math.ceil(LOOP_TAIL_BYTES / step.length));
    await mkdir(join(home, "evidence"), { recursive: true });
    await writeFile(join(home, "evidence/fixture.jsonl"), `${JSON.stringify(old)}\n${JSON.stringify(old)}\n${filler}`);
    expect((await check({ paths: ["b.ts"] })).out).not.toContain("Same failure");
    expect((await check({ paths: ["b.ts"] })).out).not.toContain("Same failure");
    expect((await check({ paths: ["b.ts"] })).out).toContain("Same failure 3 times: warden-no-comments in b.ts.");
  });

  it("text and agent feedback for a file-and-line failure quote the tool's own message", async () => {
    await write("b.ts", "var b = 1;\n");
    for (const format of ["text", "agent"] as const) {
      const { code, out } = await check({ format });
      expect(code).toBe(1);
      expect(out).toContain("FAIL b.ts:1  no-var\n  Rule:     Declare with const.\n  Output:   Unexpected var, use let or const instead.\n");
    }
    await write("b.ts", "// two\nconst b = 1;\n");
    expect((await check({ format: "agent" })).out).not.toContain("Output:");
  });

  it("feedback names rule, example, and one next action", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out).toContain("FAIL b.ts:1  no-comments");
    expect(out).toContain("Rule:     Source files carry no comments.");
    expect(out).toContain("Do this:  Delete this line.\n            Put any meaning in a name.");
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
    await write(".claude/settings.json", JSON.stringify({ model: "x", disableAllHooks: true }));
    await rm(join(root, ".claude/settings.local.json"));
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([
      { file: ".claude/settings.local.json", detail: "hooks-disabled" },
      { file: ".claude/settings.json", detail: "hooks-disabled" },
    ]);
  });

  it("edits to .claude/settings.json are not Warden's drift", async () => {
    await write(".claude/settings.json", JSON.stringify({ model: "x", permissions: { deny: ["Bash(rm*)"] } }));
    expect((await check()).code).toBe(0);
    expect(await tampered()).toEqual([]);
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
    await addLegacy("boundary", "test ! -e broken", 5000);
    await write("broken", "x\n");
    await write("b.ts", "const b = 1;\n");
    expect((await check({ tier: "edit" })).code).toBe(0);
    expect((await check({ tier: "commit" })).code).toBe(0);
    expect((await check()).code).toBe(0);
    expect((await check({ hook: "claude", format: "agent", tier: "boundary" })).out).toBe("");
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
    await addLegacy("commit", "test ! -e slow || sleep 2.413; test ! -e broken", 200);
    await write("slow", "x\n");
    await write("b.ts", "const b = 1;\n");
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out).toMatch(/^ {2}Reason: {3}stopped at \d+ ms: did not finish within its 200 ms budget$/m);
    expect(out.split("\n").filter((l) => l.startsWith("Next action:"))).toEqual([
      `Next action: run \`export WARDEN_PACK_DIR=${join(root, ".warden/packs/legacy")}; test ! -e slow || sleep 2.413; test ! -e broken\` directly to see why it does not finish.`,
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
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "weakened-kind" }]);
  });

  it("weakening lint to review is tampering and names the kind to restore", async () => {
    const pack = localPack().replace("kind: lint", "kind: review");
    await write(".warden/packs/local/pack.yaml", pack);
    await recompile();
    const { code, out } = await check();
    expect(code).toBe(1);
    expect((await tampered()).map((t) => t.detail)).toContain("weakened-kind");
    expect(out).toContain("Next action: restore kind lint on local-no-var and run warden compile.");
  });

  it("strengthening instruction to lint is not tampering", async () => {
    const weak = localPack()
      .replace("kind: lint\n", "kind: instruction\n")
      .replace('        implementation: "eslint:no-var"', "        implementation: Declare with const.")
      .replace("  - id: no-event-global", [
        "      - id: local-no-debugger",
        "        kind: lint",
        "        runs: [edit, commit]",
        "        budgetMs: 5000",
        "        version: 1",
        "        implementation: \"eslint:no-debugger\"",
        "        mustFail: \"debugger;\\n\"",
        "        mustPass: \"const a = 1;\\n\"",
        "  - id: no-event-global",
      ].join("\n"));
    await write(".warden/packs/local/pack.yaml", weak);
    await recompile();
    git("add", "-A");
    git("commit", "-q", "-m", "instruction kind");
    git("branch", "-f", "main", "HEAD");
    await write(".warden/packs/local/pack.yaml", weak.replace("kind: instruction", "kind: lint").replace("implementation: Declare with const.", 'implementation: "eslint:no-var"'));
    await recompile();
    expect((await check()).code).toBe(0);
    expect(await tampered()).toEqual([]);
  });

  it("strengthening review to lint with a different rule is still loosening", async () => {
    const base = localPack().replace("kind: lint\n", "kind: review\n");
    await write(".warden/packs/local/pack.yaml", base);
    await recompile();
    git("add", "-A");
    git("commit", "-q", "-m", "review kind");
    git("branch", "-f", "main", "HEAD");
    await write(
      ".warden/packs/local/pack.yaml",
      base.replace("kind: review", "kind: lint").replace('"eslint:no-var"', '"eslint:prefer-const"').replace('"var a = 1;\\n"', '"let a = 1;\\n"'),
    );
    await recompile();
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
    slowLint(60000);
    const first = await check();
    expect(first.code).toBe(1);
    expect(first.out).toContain("FAIL b.ts:1  no-var");
    expect(first.out).toMatch(/^WARDEN DEFECT {2}no-var$/m);
    expect(first.out).toMatch(/over the \d+ ms shared budget/);
    const costs = (await evidence()).filter((e) => e.kind === "cost" && e.shared === "eslint");
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ status: "over-budget", guardrails: expect.any(Number) });
    expect(costs[0]?.guardrail).toBeUndefined();
    expect((await evidence()).filter((e) => e.kind === "cost" && e.shared === undefined && e.guardrail === "local-no-var")).toEqual([]);
    const spy = vi.mocked(ESLint.prototype.lintFiles);
    spy.mockClear();
    expect((await check({ tier: "edit" })).code).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a review ESLint Guardrail runs its own pass: its cost is its own and the lint pass names its members", async () => {
    await write(".warden/config.yaml", config(["core", "local", "rev"]));
    await write(
      ".warden/packs/rev/pack.yaml",
      ["id: rev", "layer: 2", "terms: []", "practices:", "  - id: no-debugger", "    statement: No debugger.", "    terms: []", "    paths: []", "    conflictsWith: []", "    guardrails:",
        "      - id: rev-no-debugger", "        kind: review", "        runs: [edit, commit]", "        budgetMs: 5000", "        version: 1", '        implementation: "eslint:no-debugger"',
        '        mustFail: "debugger;\\n"', '        mustPass: "const a = 1;\\n"', ""].join("\n"),
    );
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    await write("b.ts", "const b = 1;\n");
    expect((await check()).code).toBe(0);
    const costs = (await evidence()).filter((e) => e.kind === "cost");
    const shared = costs.filter((e) => e.shared === "eslint");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.members).toEqual(expect.arrayContaining(["warden-no-comments", "local-no-var"]));
    expect(shared[0]?.members).not.toContain("rev-no-debugger");
    expect(shared[0]?.guardrails).toBe((shared[0]?.members as string[]).length);
    expect(costs.filter((e) => e.guardrail === "rev-no-debugger" && e.shared === undefined)).toHaveLength(1);
  });

  it("a lint Guardrail over budget with no violations passes", async () => {
    await write("b.ts", "const b = 1;\n");
    slowLint(60000);
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

describe("unknown adapter at check time", () => {
  it("a locked pack whose prefix breaks is tampering, and reverting it passes", async () => {
    await write(".warden/packs/local/pack.yaml", localPack().replace("eslint:no-var", "eslnt:no-var"));
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/packs/local/pack.yaml", detail: "source-drift" }]);
    expect(out.split("\n").filter((l) => l.startsWith("Next action:"))).toEqual(["Next action: revert your change to .warden/packs/local/pack.yaml."]);
    git("checkout", "HEAD", "--", ".warden/packs/local/pack.yaml");
    expect((await check()).code).toBe(0);
  });

  it("an edit to a script shipped in a pack is tampering, and reverting it passes", async () => {
    const SCRIPT = ".warden/packs/local/bin/no-broken.mjs";
    await write(SCRIPT, "process.exit(1);\n");
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    git("add", "-A");
    commitSigned("ryan", "script");
    await write(SCRIPT, "process.exit(0);\n");
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(await tampered()).toEqual([{ file: SCRIPT, detail: "source-drift" }]);
    expect(out.split("\n").filter((l) => l.startsWith("Next action:"))).toEqual([`Next action: revert your change to ${SCRIPT}.`]);
    git("checkout", "HEAD", "--", SCRIPT);
    expect((await check()).code).toBe(0);
  });

  describe("a lock edit cannot turn a locked pack's broken prefix into a compile action", () => {
    const PACK = ".warden/packs/local/pack.yaml";
    const breakPrefix = async (): Promise<void> => {
      await write(PACK, localPack().replace("eslint:no-var", "eslnt:no-var"));
    };
    const editLock = async (edit: (sources: Record<string, string>) => void): Promise<void> => {
      const lock = JSON.parse(await read(".warden/lock.json")) as { sources: Record<string, string> };
      edit(lock.sources);
      await write(".warden/lock.json", JSON.stringify(lock, null, 2));
    };
    const expectTamperThenRevert = async (expected: { file: string; detail: string }[]): Promise<void> => {
      const { code, out } = await check();
      expect(code).toBe(1);
      expect(await tampered()).toEqual(expected);
      const next = out.split("\n").filter((l) => l.startsWith("Next action:"));
      expect(next).toEqual([`Next action: revert your change to ${[...new Set(expected.map((t) => t.file))].join(", ")}.`]);
      git("checkout", "HEAD", "--", ...new Set(expected.map((t) => t.file)));
      expect((await check()).code).toBe(0);
    };

    it("B: the lock's source hash forged to match the broken pack", async () => {
      await breakPrefix();
      const text = await read(PACK);
      await editLock((sources) => {
        sources[PACK] = sha256(text);
      });
      await expectTamperThenRevert([
        { file: ".warden/lock.json", detail: "lock-drift" },
        { file: PACK, detail: "source-drift" },
      ]);
    });

    it("C: the pack's entry deleted from the lock", async () => {
      await breakPrefix();
      await editLock((sources) => {
        delete sources[PACK];
      });
      await expectTamperThenRevert([
        { file: ".warden/lock.json", detail: "lock-drift" },
        { file: PACK, detail: "source-drift" },
      ]);
    });

    it("D: the lock file deleted", async () => {
      await breakPrefix();
      await rm(join(root, ".warden/lock.json"));
      await expectTamperThenRevert([
        { file: ".warden/lock.json", detail: "missing-lock" },
        { file: PACK, detail: "source-drift" },
      ]);
    });
  });

  it("an unlocked pack with an unknown prefix exits 2 naming its file, and following the next action passes", async () => {
    const file = join(root, ".warden/packs/extra/pack.yaml");
    await write(".warden/config.yaml", config(["core", "local", "extra"]));
    await write(
      ".warden/packs/extra/pack.yaml",
      [
        "id: extra",
        "layer: 2",
        "terms: []",
        "practices:",
        "  - id: no-debugger",
        "    statement: No debugger statements.",
        "    terms: []",
        "    paths: []",
        "    conflictsWith: []",
        "    guardrails:",
        "      - id: extra-no-debugger",
        "        kind: lint",
        "        runs: [edit, commit]",
        "        budgetMs: 5000",
        "        version: 1",
        '        implementation: "eslnt:no-debugger"',
        '        mustFail: "debugger;\\n"',
        '        mustPass: "const a = 1;\\n"',
        "",
      ].join("\n"),
    );
    const { code, err } = await check();
    expect(code).toBe(2);
    expect(err).toBe(
      `${file} /guardrails/extra-no-debugger/implementation: Guardrail extra-no-debugger names adapter "eslnt", which is not registered; the known adapters are eslint, tsc, cmd, fs, graph. Next action: set implementation to one of eslint:<...>, tsc:<...>, cmd:<...>, fs:<...>, graph:<...> in ${file}, then run warden compile.\n`,
    );
    await write(".warden/packs/extra/pack.yaml", (await read(".warden/packs/extra/pack.yaml")).replace("eslnt:", "eslint:"));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect((await check()).code).toBe(0);
  });
});

describe("final review: legacy feedback", () => {
  it("a legacy failure shows the command output and says to run the command", async () => {
    await addLegacy("commit", "test ! -e broken || { echo broken thing; exit 1; }", 5000);
    await write("broken", "x\n");
    await write("b.ts", "const b = 1;\n");
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out).toContain(`  Output:   export WARDEN_PACK_DIR=${join(root, ".warden/packs/legacy")}; test ! -e broken || { echo broken thing; exit 1; } exited with 1\n            broken thing`);
    expect(out.split("\n").filter((l) => l.startsWith("Next action:"))).toEqual([
      `Next action: run \`export WARDEN_PACK_DIR=${join(root, ".warden/packs/legacy")}; test ! -e broken || { echo broken thing; exit 1; }\` and fix what it reports.`,
    ]);
  });

  it("a cmd Guardrail runs a script shipped in its pack, passes its examples at compile, and on failure names the expanded command that reproduces it", async () => {
    await write(".warden/packs/legacy/bin/no-broken.mjs", 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("broken") ? 1 : 0);\n');
    await addLegacy("commit", 'node "$WARDEN_PACK_DIR/bin/no-broken.mjs"', 5000);
    await write("broken", "x\n");
    await write("b.ts", "const b = 1;\n");
    const { code, out } = await check();
    expect(code).toBe(1);
    const next = /^Next action: run `(.+)` and fix what it reports\.$/m.exec(out)?.[1] as string;
    expect(next).toBe(`export WARDEN_PACK_DIR=${join(root, ".warden/packs/legacy")}; node "$WARDEN_PACK_DIR/bin/no-broken.mjs"`);
    expect(spawnSync("sh", ["-c", next], { cwd: root }).status).toBe(1);
  });
});

describe("a cmd Guardrail's project scripts are locked", () => {
  const lockedThenEdited = async (command: string, files: Record<string, string>, edit: [string, string], sources?: string[]): Promise<{ code: number; out: string }> => {
    for (const [file, content] of Object.entries(files)) await write(file, content);
    await write(".warden/config.yaml", config(["core", "local", "legacy"]));
    const pack = legacyPack("commit", command, 5000);
    await write(".warden/packs/legacy/pack.yaml", sources === undefined ? pack : pack.replace("        mustFail:", `        sources: ${JSON.stringify(sources)}\n        mustFail:`));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    git("add", "-A");
    git("commit", "-q", "-m", "legacy");
    git("branch", "-f", "main", "HEAD");
    expect((await check()).code).toBe(0);
    await write(edit[0], edit[1]);
    return check();
  };

  it("a script run by sh with no extension is locked", async () => {
    const { code } = await lockedThenEdited("test ! -e broken || sh scripts/check", { "scripts/check": "exit 1\n" }, ["scripts/check", "true\n"]);
    expect(code).toBe(1);
    expect(await tampered()).toContainEqual({ file: "./scripts/check", detail: "source-drift" });
  });

  it("an npm script another npm script calls is locked, and the next action names the script in package.json", async () => {
    const pkg = (inner: string): string => JSON.stringify({ scripts: { check: "npm run check:inner", "check:inner": inner } });
    const { code, out } = await lockedThenEdited("test ! -e broken || npm run check", { "package.json": pkg("sh scripts/c.sh"), "scripts/c.sh": "exit 1\n" }, ["package.json", pkg("true")]);
    expect(code).toBe(1);
    expect(await tampered()).toContainEqual({ file: "./package.json#scripts/check:inner", detail: "source-drift" });
    expect(out.split("\n").filter((l) => l.startsWith("Next action:"))).toEqual(['Next action: revert your change to the "check:inner" script in package.json.']);
  });

  it("a module a locked script imports is locked", async () => {
    const { code } = await lockedThenEdited("test ! -e broken || node scripts/c.mjs", { "scripts/c.mjs": 'import { ok } from "./lib.mjs";\nprocess.exit(ok ? 0 : 1);\n', "scripts/lib.mjs": "export const ok = false;\n" }, ["scripts/lib.mjs", "export const ok = true;\n"]);
    expect(code).toBe(1);
    expect(await tampered()).toContainEqual({ file: "./scripts/lib.mjs", detail: "source-drift" });
  });

  it("an npm script named after a flag is locked", async () => {
    const { code } = await lockedThenEdited("test ! -e broken || npm run --silent check", { "package.json": JSON.stringify({ scripts: { check: "sh scripts/c.sh" } }), "scripts/c.sh": "exit 1\n" }, ["scripts/c.sh", "true\n"]);
    expect(code).toBe(1);
    expect(await tampered()).toContainEqual({ file: "./scripts/c.sh", detail: "source-drift" });
  });

  it("a script run after cd resolves against that folder and is locked", async () => {
    const { code } = await lockedThenEdited("test ! -e broken || (cd scripts && sh c.sh)", { "scripts/c.sh": "exit 1\n" }, ["scripts/c.sh", "true\n"]);
    expect(code).toBe(1);
    expect(await tampered()).toContainEqual({ file: "./scripts/c.sh", detail: "source-drift" });
  });

  it("a data file listed in sources is locked", async () => {
    const { code } = await lockedThenEdited("test ! -e broken || sh scripts/c.sh", { "scripts/c.sh": 'test "$(cat scripts/target.txt)" = ok\n', "scripts/target.txt": "no\n" }, ["scripts/target.txt", "ok\n"], ["scripts/target.txt"]);
    expect(code).toBe(1);
    expect(await tampered()).toContainEqual({ file: "./scripts/target.txt", detail: "source-drift" });
  });

  for (const command of ["sh -e scripts/c.sh", "env sh scripts/c.sh", 'test "$(sh scripts/c.sh)" = ok', "if sh scripts/c.sh; then exit 0; else exit 1; fi"]) {
    it(`a script run through ${command} is locked`, async () => {
      const { code } = await lockedThenEdited(`test ! -e broken || ${command}`, { "scripts/c.sh": "exit 1\n" }, ["scripts/c.sh", "echo ok\n"]);
      expect(code).toBe(1);
      expect(await tampered()).toContainEqual({ file: "./scripts/c.sh", detail: "source-drift" });
    });
  }

  it("a script a locked shell script calls is locked, and a form its body does not model does not stop compile", async () => {
    const { code } = await lockedThenEdited("test ! -e broken || sh scripts/c.sh", { "scripts/c.sh": 'eval "true"\nsh scripts/inner.sh\n', "scripts/inner.sh": "exit 1\n" }, ["scripts/inner.sh", "true\n"]);
    expect(code).toBe(1);
    expect(await tampered()).toContainEqual({ file: "./scripts/inner.sh", detail: "source-drift" });
  });

  it("a project script a bare command finds on PATH is locked", async () => {
    vi.stubEnv("PATH", `${join(root, "bin")}:${process.env.PATH ?? ""}`);
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/check-canon"), "exit 1\n", { mode: 0o755 });
    const { code } = await lockedThenEdited("test ! -e broken || check-canon", {}, ["bin/check-canon", "true\n"]);
    expect(code).toBe(1);
    expect(await tampered()).toContainEqual({ file: "./bin/check-canon", detail: "source-drift" });
  });

  for (const command of ["nice ./scripts/c.sh", "timeout 5 ./scripts/c.sh"]) {
    it(`a script run through ${command} is locked`, async () => {
      await write("scripts/c.sh", "exit 1\n");
      await chmod(join(root, "scripts/c.sh"), 0o755);
      const { code } = await lockedThenEdited(`test ! -e broken || ${command}`, {}, ["scripts/c.sh", "exit 0\n"]);
      expect(code).toBe(1);
      expect(await tampered()).toContainEqual({ file: "./scripts/c.sh", detail: "source-drift" });
    });
  }

  it("a form compile cannot resolve exits 2 with one next action, and following it clears the refusal", async () => {
    await write("scripts/a.php", "a\n");
    await write(".warden/config.yaml", config(["core", "local", "legacy"]));
    const pack = legacyPack("commit", "test ! -e broken || fakeinterp scripts/a.php", 5000);
    await write(".warden/packs/legacy/pack.yaml", pack);
    const refused = await compile(root, wardenRoot).catch((cause: unknown) => cause);
    expect(refused).toMatchObject({ pointer: "/guardrails/legacy-script/implementation" });
    expect(((refused as Error).message.match(/Next action:/g) ?? []).length).toBe(1);
    const listed = pack.replace("        mustFail:", '        sources: ["scripts/a.php"]\n        mustFail:');
    expect((refused as Error).message).toContain("scripts/a.php");
    await write(".warden/packs/legacy/pack.yaml", listed);
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect(readLock(root).sources["./scripts/a.php"]).toBe(sha256("a\n"));
    await write(".warden/packs/legacy/pack.yaml", pack);
    const { code, err } = await check();
    expect(code).toBe(2);
    expect(err.match(/Next action:/g)).toHaveLength(1);
  });

  it("a form with no file to list names a rewrite, and the rewritten command compiles", async () => {
    await write("scripts/c.sh", "exit 0\n");
    await write(".warden/config.yaml", config(["core", "local", "legacy"]));
    await write(".warden/packs/legacy/pack.yaml", legacyPack("commit", "test ! -e broken || eval 'sh scripts/c.sh'", 5000));
    const refused = await compile(root, wardenRoot).catch((cause: unknown) => cause);
    expect(refused).toMatchObject({ pointer: "/guardrails/legacy-script/implementation" });
    expect(((refused as Error).message.match(/Next action:/g) ?? []).length).toBe(1);
    await write(".warden/packs/legacy/pack.yaml", legacyPack("commit", "test ! -e broken || sh scripts/c.sh", 5000));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
  });

  it("a listed source that is missing names one next action, and creating it clears the refusal", async () => {
    await write(".warden/config.yaml", config(["core", "local", "legacy"]));
    await write(".warden/packs/legacy/pack.yaml", legacyPack("commit", "test ! -e broken", 5000).replace("        mustFail:", '        sources: ["data.txt"]\n        mustFail:'));
    const refused = await compile(root, wardenRoot).catch((cause: unknown) => cause);
    expect(refused).toMatchObject({ pointer: "/guardrails/legacy-script/sources" });
    expect(((refused as Error).message.match(/Next action:/g) ?? []).length).toBe(1);
    await write("data.txt", "d\n");
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
  });

  it("a malformed package.json stops compile with its name and one next action", async () => {
    await write("package.json", "{ bad");
    await write(".warden/config.yaml", config(["core", "local", "legacy"]));
    await write(".warden/packs/legacy/pack.yaml", legacyPack("commit", "test ! -e broken", 5000));
    const refused = await compile(root, wardenRoot).catch((cause: unknown) => cause);
    expect(refused).toMatchObject({ file: "package.json" });
    expect(((refused as Error).message.match(/Next action:/g) ?? []).length).toBe(1);
    await write("package.json", "{}\n");
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
  });

  it("a project file the command only reads as an argument is not locked, so editing it is not tampering", async () => {
    const { code } = await lockedThenEdited('test ! -e broken && test "$(cat x.ts 2>/dev/null)" = "$(cat y.ts 2>/dev/null)"', { "x.ts": "export const v = 1;\n", "y.ts": "export const v = 1;\n" }, ["x.ts", "export const v = 2;\n"]);
    expect(code).toBe(1);
    expect(await tampered()).toEqual([]);
    await write("y.ts", "export const v = 2;\n");
    expect((await check()).code).toBe(0);
    expect(Object.keys(readLock(root).sources).filter((k) => k.startsWith("./"))).toEqual([]);
  });
});

describe("a cmd Guardrail that runs a script in its pack", () => {
  it("runs WARDEN_PACK_DIR as the pack folder, names the resolved command, and treats a script edit as tampering", async () => {
    await write(".warden/packs/legacy/check.sh", "test ! -e broken || { echo broken thing; exit 1; }\n");
    await addLegacy("commit", 'sh "$WARDEN_PACK_DIR/check.sh"', 5000);
    await write("broken", "x\n");
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out).toContain(`  Output:   ${`export WARDEN_PACK_DIR=${join(root, ".warden/packs/legacy")}; sh "$WARDEN_PACK_DIR/check.sh"`.slice(0, COMMAND_CHARS)}`);
    expect(out).toContain(` exited with 1\n            broken thing`);
    expect(out.split("\n").filter((l) => l.startsWith("Next action:"))).toEqual([`Next action: ${runIt({ id: "legacy-script", kind: "legacy", runs: ["commit"], budgetMs: 5000, version: 1, implementation: 'cmd:sh "$WARDEN_PACK_DIR/check.sh"', packDir: join(root, ".warden/packs/legacy") })}`]);
    await write(".warden/packs/legacy/check.sh", "true\n");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toContainEqual({ file: ".warden/packs/legacy/check.sh", detail: "source-drift" });
  });

  it("hashes a project script the command names, so editing it is source drift, and recompiling it is loosening", async () => {
    await write("scripts/check.sh", "test ! -e broken\n");
    await addLegacy("commit", "test ! -e broken || sh scripts/check.sh", 5000);
    expect(readLock(root).sources["./scripts/check.sh"]).toBe(sha256("test ! -e broken\n"));
    git("add", "-A");
    git("commit", "-q", "-m", "legacy");
    git("branch", "-f", "main", "HEAD");
    expect((await check()).code).toBe(0);
    await write("scripts/check.sh", "true\n");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toContainEqual({ file: "./scripts/check.sh", detail: "source-drift" });
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect((await check()).code).toBe(1);
    expect(await tampered()).toContainEqual({ file: ".warden/lock.json", detail: "loosened" });
  });

  it("a script that exits 2 stops the check with exit 2 and the script's next action, not a Guardrail failure", async () => {
    await write(".warden/packs/legacy/check.sh", "test ! -e broken || exit 1; test ! -e nogit || { echo 'git is not on PATH. Next action: install git so that it is on PATH.'; exit 2; }\n");
    await addLegacy("commit", 'sh "$WARDEN_PACK_DIR/check.sh"', 5000);
    await write("nogit", "x\n");
    const { code, out, err } = await check();
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toBe(`${join(root, ".warden/packs/legacy/pack.yaml")} /guardrails/legacy-script/implementation: export WARDEN_PACK_DIR=${join(root, ".warden/packs/legacy")}; sh "$WARDEN_PACK_DIR/check.sh" exited with 2, an error in its environment or usage, not a violation: git is not on PATH. Next action: install git so that it is on PATH.\n`);
  });

  it("moving a base-locked cmd Guardrail from lint to runtime, as compile asks, is not tampering", async () => {
    await write(".warden/config.yaml", config(["core", "local", "legacy"]));
    await write(".warden/packs/legacy/pack.yaml", legacyPack("commit", "test ! -e broken", 5000).replace("kind: legacy", "kind: runtime"));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    const lock = JSON.parse(await read(".warden/lock.json")) as { guardrails: Record<string, { kind: string }> };
    (lock.guardrails["legacy-script"] as { kind: string }).kind = "lint";
    await write(".warden/lock.json", `${JSON.stringify(lock, null, 2)}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "cmd lint");
    git("branch", "-f", "main", "HEAD");
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect((await check()).code).toBe(0);
    expect(await tampered()).toEqual([]);
  });
});

describe("a whole-tree Guardrail", () => {
  const treePack = [
    "id: tree",
    "layer: 2",
    "terms: []",
    "practices:",
    "  - id: no-flag",
    "    statement: No flag file sits beside the code.",
    "    terms: []",
    "    paths: []",
    "    conflictsWith: []",
    "    guardrails:",
    "      - id: tree-flagged",
    "        kind: lint",
    "        runs: [commit]",
    "        budgetMs: 5000",
    "        version: 1",
    "        implementation: \"fs:tree/flagged\"",
    "        mustFail:",
    "          flag.ts: \"export const flag = 1;\\n\"",
    "          a.ts: \"export const a = 1;\\n\"",
    "        mustPass:",
    "          a.ts: \"export const a = 1;\\n\"",
    "",
  ].join("\n");
  const flagged = 'export default {\n  flagged: ({ files, all }) => (all.includes("flag.ts") ? files.filter((f) => f !== "flag.ts").map((file) => ({ file, message: "flag.ts is present.", doThis: "Delete flag.ts." })) : []),\n};\n';
  const addTree = async (): Promise<void> => {
    await write(".warden/config.yaml", config(["core", "local", "tree"]));
    await write(".warden/packs/tree/pack.yaml", treePack);
    await write(".warden/packs/tree/fs.js", flagged);
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
  };

  it("fails at the commit tier on a file the change did not touch, with the check's next action", async () => {
    await addTree();
    await write("flag.ts", "export const flag = 1;\n");
    const { code, out } = await check({ format: "json" });
    expect(code).toBe(1);
    const { failures } = JSON.parse(out) as { failures: { file: string; doThis: string }[] };
    expect(failures.map((f) => [f.file, f.doThis])).toEqual([["a.ts", "Delete flag.ts."]]);
  });

  it("at the commit tier judges only staged files, so an untracked file does not block an unrelated commit", async () => {
    await addTree();
    git("add", "-A");
    git("commit", "-q", "-m", "tree");
    git("branch", "-f", "main", "HEAD");
    await write("flag.ts", "export const flag = 1;\n");
    await write("a.ts", "export const a = 2;\n");
    git("add", "a.ts");
    expect((await check({}, false)).code).toBe(0);
    git("add", "flag.ts");
    expect((await check({}, false)).code).toBe(1);
  });

  it("changing a pack's settings and recompiling is loosening", async () => {
    await write(".warden/config.yaml", config(["core", "local", "tree"]).replace('  - id: tree\n    paths: ["**/*.ts"]', '  - id: tree\n    paths: ["**/*.ts"]\n    settings: { flag: flag.ts }'));
    await write(".warden/packs/tree/pack.yaml", `${treePack}settings:\n  type: object\n  properties:\n    flag: { type: string, default: flag.ts }\n`);
    await write(".warden/packs/tree/fs.js", flagged);
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    git("add", "-A");
    git("commit", "-q", "-m", "settings");
    git("branch", "-f", "main", "HEAD");
    expect((await check()).code).toBe(0);
    await write(".warden/config.yaml", (await read(".warden/config.yaml")).replace("flag: flag.ts", "flag: none.ts"));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    const loosened = await check();
    expect(loosened.code).toBe(1);
    expect(loosened.out.split("\n").filter((l) => l.startsWith("TAMPERED"))).toEqual(["TAMPERED .warden/lock.json  loosened tree-flagged"]);
    expect(await tampered()).toContainEqual({ file: ".warden/lock.json", detail: "loosened" });
  });

  it("accepts the bundled principles default when an older lock omitted contractExports", async () => {
    const withPrinciples = config(["core", "local", "principles"]);
    await write(".warden/config.yaml", withPrinciples);
    const set = await loadRecords(root, wardenRoot);
    const current = await expectedOutputs(set, root, wardenRoot);
    const before = structuredClone(current.lock);
    const withoutSettings = Object.values(before.guardrails).filter((guardrail) => guardrail.settings !== undefined);
    expect(withoutSettings.length).toBeGreaterThan(0);
    for (const guardrail of withoutSettings) delete guardrail.settings;
    const recordBaseLock = async () => {
      await write(".warden/lock.json", JSON.stringify(before));
      git("add", ".warden");
      git("commit", "-qm", "historical lock");
      git("branch", "-f", "main", "HEAD");
    };
    await recordBaseLock();

    const changedSettings = async (config: string) => {
      await write(".warden/config.yaml", config);
      const records = await loadRecords(root, wardenRoot);
      const { lock, files } = await expectedOutputs(records, root, wardenRoot);
      for (const [file, content] of Object.entries(files)) await write(file, content);
      await write(".warden/lock.json", JSON.stringify(lock));
      return (await findTampering(records, wardenRoot, "main", false)).filter((entry) => entry.detail === "loosened");
    };
    expect(await changedSettings(withPrinciples)).toEqual([]);
    const explicitExemption = withPrinciples.replace('  - id: principles\n    paths: ["**/*.ts"]', '  - id: principles\n    paths: ["**/*.ts"]\n    settings: { contractExports: [Widget] }');
    expect(await changedSettings(explicitExemption)).toContainEqual(expect.objectContaining({
      detail: "loosened", guardrail: "principles-unused-exports",
    }));
    delete before.sources["packs/principles/pack.yaml"];
    await recordBaseLock();
    expect(await changedSettings(withPrinciples)).toContainEqual(expect.objectContaining({
      detail: "loosened", guardrail: "principles-unused-exports",
    }));
  });

  it("editing a local pack's shipped code and recompiling is loosening", async () => {
    await addTree();
    git("add", "-A");
    git("commit", "-q", "-m", "tree");
    git("branch", "-f", "main", "HEAD");
    expect((await check()).code).toBe(0);
    await write(".warden/packs/tree/fs.js", "export default { flagged: () => [] };\n");
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect((await check()).code).toBe(1);
    expect(await tampered()).toContainEqual({ file: ".warden/lock.json", detail: "loosened" });
  });

  it("compile baselines the violations a new whole-tree Guardrail finds, file by file", async () => {
    await write("flag.ts", "export const flag = 1;\n");
    await addTree();
    expect(JSON.parse(await read(".warden/baseline.json"))).toEqual({ "warden-no-comments": { "a.ts": 1 }, "tree-flagged": { "a.ts": 1 } });
    expect((await check()).code).toBe(0);
  });
});

describe("final review: project-wide baseline", () => {
  it("a baseline entry for the whole project is tampering, so it cannot silence a legacy Guardrail", async () => {
    await addLegacy("commit", "test ! -e broken", 5000);
    await write("broken", "x\n");
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
  it("pointing base at the working branch and recompiling is a moved base", async () => {
    await write(".warden/config.yaml", config(["core", "local"]).replace("base: main", "base: feature"));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect(readLock(root).config.base).toBe("feature");
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "base-moved" }]);
    expect(out).toContain("Next action: revert the base change in .warden/config.yaml and run warden compile.");
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

  it("a base lock that does not parse exits 2 with one next action, and following it passes", async () => {
    const working = await read(".warden/lock.json");
    git("checkout", "-q", "main");
    await write(".warden/lock.json", "{");
    git("commit", "-q", "-am", "corrupt base lock");
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-edit", "main");
    await write(".warden/lock.json", working);
    git("commit", "-q", "-am", "keep the working lock");
    const { code, err } = await check();
    expect(code).toBe(2);
    expect(err).toContain("Next action: run warden compile on main and commit the lock there, merge main into this branch, then run warden check --base main again.");
    git("checkout", "-q", "main");
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    git("commit", "-q", "-am", "recompile");
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-edit", "main");
    expect((await check()).code).toBe(0);
  });

  it("a base lock from a newer Warden stops check and compile, and names the release to install", async () => {
    const working = await read(".warden/lock.json");
    await commitBaseLock((lock) => {
      lock.format = 4;
      lock.warden = "9.0.0";
    });
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-edit", "main");
    await write(".warden/lock.json", working);
    await expect(compile(root, wardenRoot)).rejects.toThrow("Next action: install Warden 9.0.0, the release that wrote the lock on main");
    const { code, err } = await check();
    expect(code).toBe(2);
    expect(err).toContain("Next action: install Warden 9.0.0, the release that wrote the lock on main, then run warden check --base main again.");
  });
});

describe("bench settings in the lock", () => {
  const withBench = (setting: string): string => config(["core", "local"]).replace("loopBreakerRepeats: 3", `loopBreakerRepeats: 3\nbench:\n  ${setting}`);

  for (const setting of ["linearMax: 1.5", "constantMs: 50", "minMarginalMs: 500", "maxFiles: 400"]) {
    it(`setting ${setting} in config.yaml is loosening`, async () => {
      await write(".warden/config.yaml", withBench(setting));
      expect((await compile(root, wardenRoot)).findings).toEqual([]);
      expect(readLock(root).config.bench).toMatchObject(Object.fromEntries([[setting.split(": ")[0] as string, Number(setting.split(": ")[1])]]));
      expect((await check()).code).toBe(1);
      expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "loosened" }]);
    });
  }

  it("tightening the bench settings is not loosening", async () => {
    await write(".warden/config.yaml", withBench("linearMax: 1.05\n  maxFiles: 3300\n  constantMs: 2"));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect((await check()).code).toBe(0);
    expect(await tampered()).toEqual([]);
  });
});

describe("bundled tool versions in the lock", () => {
  const editLock = async (edit: (lock: Record<string, unknown>) => void): Promise<void> => {
    const lock = JSON.parse(await read(".warden/lock.json")) as Record<string, unknown>;
    edit(lock);
    await write(".warden/lock.json", `${JSON.stringify(lock, null, 2)}\n`);
  };

  it("a lock whose tools differ from the loaded versions exits 2 with one next action, and following it passes", async () => {
    await editLock((lock) => {
      (lock.tools as Record<string, string>).typescript = "0.0.0";
    });
    const { code, out, err } = await check();
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err.match(/Next action:/g)).toHaveLength(1);
    expect(err).toContain("Next action: run warden compile.");
    expect(await tampered()).toEqual([]);
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect((await check()).code).toBe(0);
  });

  it("a lock written before tools were recorded exits 2 and says to run warden compile", async () => {
    await editLock((lock) => {
      delete lock.tools;
    });
    const { code, err } = await check();
    expect(code).toBe(2);
    expect(err).toContain("Next action: run warden compile.");
  });

  it("an edited generated file is still tampering when the lock's tools are also deleted", async () => {
    await editLock((lock) => {
      delete lock.tools;
    });
    const rules = ".warden/generated/eslint.rules.json";
    await write(rules, (await read(rules)).replace('"error"', '"off"'));
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out).toContain(`TAMPERED ${rules}  generated-drift`);
    expect(await tampered()).toContainEqual({ file: rules, detail: "generated-drift" });
  });

  it("a newer-format base lock without sources gets the format next action when a pack names an unknown adapter", async () => {
    const working = await read(".warden/lock.json");
    git("checkout", "-q", "main");
    await editLock((lock) => {
      lock.format = 4;
      lock.warden = "9.0.0";
      delete lock.sources;
    });
    git("commit", "-q", "-am", "newer base lock");
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-edit", "main");
    await write(".warden/lock.json", working);
    git("commit", "-q", "-am", "keep the working lock");
    await write(".warden/config.yaml", config(["core", "local", "extra"]));
    await write(".warden/packs/extra/pack.yaml", (await read(".warden/packs/local/pack.yaml")).replace("id: local", "id: extra").replace(/local-/g, "extra-").replace("eslint:no-restricted-globals", "eslnt:no-restricted-globals"));
    const { code, err } = await check();
    expect(code).toBe(2);
    expect(err).toContain("Next action: install Warden 9.0.0, the release that wrote the lock on main");
  });
});

describe("doctor at check", () => {
  const withTool = async (): Promise<string> => {
    const bin = await mkdtemp(join(tmpdir(), "warden-bin-"));
    await writeFile(join(bin, "mytool"), "#!/bin/sh\ntest ! -e broken\n");
    await chmod(join(bin, "mytool"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    return bin;
  };

  it("a cmd Guardrail whose command does not resolve exits 2 with the doctor's one next action", async () => {
    const bin = await withTool();
    await addLegacy("boundary", "mytool", 5000);
    await rm(bin, { recursive: true, force: true });
    const { code, out, err } = await check();
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("FAIL  cmd legacy-script: mytool  mytool is not on PATH");
    expect(err.match(/Next action:/g)).toHaveLength(1);
    expect(err).toContain("Next action: install mytool so it is on PATH, then run warden doctor");
  });

  it("a repeat edit-tier check with the same lock and package.json skips the doctor, and a package.json change runs it again", async () => {
    const bin = await withTool();
    await addLegacy("boundary", "mytool", 5000);
    expect((await check({ tier: "edit" })).code).toBe(0);
    await rm(bin, { recursive: true, force: true });
    expect((await check({ tier: "edit" })).code).toBe(0);
    await write("package.json", "{}\n");
    expect((await check({ tier: "edit" })).code).toBe(2);
  });

  it("the commit tier runs the doctor even when the cache holds a pass", async () => {
    const bin = await withTool();
    await addLegacy("boundary", "mytool", 5000);
    expect((await check({ tier: "edit" })).code).toBe(0);
    await rm(bin, { recursive: true, force: true });
    expect((await check()).code).toBe(2);
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
  it("unstaged changes to a scanned tracked file fail the commit tier with a next action that stages them", async () => {
    await write("a.ts", "// one\nconst a = 2;\n");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    expect(out).toContain("UNSTAGED a.ts");
    expect(out.split("\n").filter((l) => l.startsWith("Next action:"))).toEqual(["Next action: run git add -- 'a.ts', then run warden check --base main."]);
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

  const commitOwnBase = async (): Promise<void> => {
    await write(".warden/config.yaml", config(["core", "local"]).replace("base: main", "base: feature"));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    git("add", "-A");
    commitSigned("ryan", "own base");
  };

  it("a base committed as the agent's own branch is a moved base against the base the hook names", async () => {
    await commitOwnBase();
    expect((await check({ base: "main" })).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "base-moved" }]);
  });

  it("a moved base committed at HEAD is caught even when the working copy restores it", async () => {
    await commitOwnBase();
    await write(".warden/config.yaml", config(["core", "local"]));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect((await check({ base: "main" }, false)).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "base-moved" }]);
  });

  it("the reviewer's repro: --base set to the agent's own committed branch exits 2 and names the base it merges into", async () => {
    await commitOwnBase();
    expect(JSON.parse(await read(".warden/lock.json")).config.base).toBe("feature");
    const { code, err } = await check({ base: "feature" });
    expect(code).toBe(2);
    expect(err).toContain("Next action: run warden check --base main");
    expect(await tampered()).toEqual([]);
  });

  it("a moved base merged into the base branch is refused with advice that differs from the command and clears the refusal", async () => {
    await commitOwnBase();
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-edit", "feature");
    const refused = await check({ base: "main" });
    expect(refused.code).toBe(2);
    expect(refused.err).not.toContain("Next action: run warden check --base main");
    expect(refused.err).toContain("Next action: revert base in .warden/config.yaml to main and run warden compile");
    await write(".warden/config.yaml", config(["core", "local"]));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    const again = await check({ base: "main" });
    expect(again.err).toBe("");
    expect(again.code, again.out).toBe(0);
    expect(await tampered()).toEqual([]);
  });

  it("restoring the oldest recorded base on a branch whose base is now another branch is a moved base", async () => {
    git("checkout", "-q", "main");
    await write(".warden/config.yaml", config(["core", "local"]).replace("base: main", "base: trunk"));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    git("add", "-A");
    git("commit", "-q", "-m", "base is trunk");
    git("branch", "-m", "main", "trunk");
    git("branch", "-D", "feature");
    git("checkout", "-q", "-b", "feature", "trunk");
    await write(".warden/config.yaml", config(["core", "local"]));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    git("add", "-A");
    commitSigned("ryan", "base back to main");
    const { code, err } = await check({ base: "trunk" });
    expect(err).toBe("");
    expect(code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/lock.json", detail: "base-moved" }]);
  });

  it("--base naming a ref whose tip contains HEAD is refused unless the lock always recorded that base", async () => {
    git("branch", "own", "HEAD");
    const refused = await check({ base: "own" });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("Next action: run warden check --base main");
    git("checkout", "-q", "main");
    expect((await check({ base: "main" })).code).toBe(0);
  });

  it("check without --base exits 2 and names the command to run", async () => {
    const { code, err } = await check({ base: undefined });
    expect(code).toBe(2);
    expect(err).toContain("Next action: run warden check --base main");
  });

  it("the edit hook takes its base from the lock, not from the editable config", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    const input = JSON.stringify({ tool_input: { file_path: join(root, "b.ts") } });
    expect(JSON.parse((await check({ base: undefined, format: "agent", hook: "claude", hookInput: input })).out).decision).toBe("block");
    await write(".warden/config.yaml", config(["core", "local"]).replace("base: main", "base: nowhere"));
    const { code, err } = await check({ base: undefined, format: "agent", hook: "claude", hookInput: input });
    expect(code).toBe(0);
    expect(err).toBe("");
    await rm(join(root, ".warden/lock.json"));
    const missing = await check({ base: undefined, format: "agent", hook: "claude", hookInput: input });
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("Next action: run warden compile");
  });
});

describe("residual fixes: Do this fits the violation", () => {
  it("a trailing directive is removed from its own line and the hidden rule is named", async () => {
    await write("b.ts", "export const total = 1; // eslint-disable-line no-console, no-alert\n");
    const { code, out } = await check({ format: "json" });
    expect(code).toBe(1);
    expect((JSON.parse(out) as { failures: { practice: string; doThis: string }[] }).failures.map((f) => [f.practice, f.doThis])).toEqual([
      ["no-suppressions", "export const total = 1;\nFix the no-console, no-alert problem it hid."],
    ]);
  });

  const doThis = async (source: string): Promise<string[][]> => {
    await write("b.ts", source);
    const { out } = await check({ format: "json" });
    return (JSON.parse(out) as { failures: { line: number; practice: string; doThis: string }[] }).failures.map((f) => [`${f.line}`, f.practice, f.doThis]);
  };

  it("a whole-line comment says to delete the line, never shows the next comment", async () => {
    expect(await doThis("// first line\n// second line\nexport const a = 1;\n")).toEqual([
      ["1", "no-comments", "Delete this line.\nPut any meaning in a name."],
      ["2", "no-comments", "Delete this line.\nPut any meaning in a name."],
    ]);
  });

  it("a whole multi-line block comment says which lines to delete", async () => {
    expect(await doThis("/* first\n   second */\nexport const a = 1;\n")).toEqual([
      ["1", "no-comments", "Delete lines 1 to 2.\nPut any meaning in a name."],
    ]);
  });

  it("a directive's description is not read as a rule name", async () => {
    expect(await doThis("// eslint-disable-next-line -- legacy reason\nexport const a = 1;\n")).toEqual([
      ["1", "no-suppressions", "export const a = 1;\nFix the rule it hid."],
    ]);
    expect(await doThis("// eslint-disable-next-line no-console -- legacy reason\nexport const a = 1;\n")).toEqual([
      ["1", "no-suppressions", "export const a = 1;\nFix the no-console problem it hid."],
    ]);
  });

  it("a directive above another comment shows the code line it annotated", async () => {
    expect(await doThis("// eslint-disable-next-line\n// note\nexport const a = 1;\n")).toEqual([
      ["1", "no-suppressions", "export const a = 1;\nFix the rule it hid."],
      ["2", "no-comments", "Delete this line.\nPut any meaning in a name."],
    ]);
  });

  it("removing an inline comment leaves single spacing", async () => {
    expect(await doThis("export const c = /* two */ 2;\n")).toEqual([["1", "no-comments", "export const c = 2;\nPut any meaning in a name."]]);
  });

  it("a skipped test keeps the record example, which looks like real code", async () => {
    await write("b.test.ts", 'it.skip("adds", () => {});\n');
    const { out } = await check({ format: "json" });
    const doThis = (JSON.parse(out) as { failures: { doThis: string }[] }).failures.map((f) => f.doThis);
    expect(doThis).toHaveLength(1);
    expect(doThis[0]).not.toContain('it("x"');
  });
});

describe("deferred residual-bypass minors", () => {
  const doThis = async (source: string): Promise<string[][]> => {
    await write("b.ts", source);
    const { out } = await check({ format: "json" });
    return (JSON.parse(out) as { failures: { line: number; practice: string; doThis: string }[] }).failures.map((f) => [`${f.line}`, f.practice, f.doThis]);
  };

  it("--rule no-comments still reports a directive comment", async () => {
    await write("b.ts", "// eslint-disable-next-line\nexport const a = 1;\n");
    const { code, out } = await check({ format: "json", rule: "no-comments" });
    expect(code).toBe(1);
    expect((JSON.parse(out) as { failures: { line: number; practice: string }[] }).failures.map((f) => [f.line, f.practice])).toEqual([[1, "no-suppressions"]]);
  });

  it("removing an inline comment leaves no stray space beside a bracket or at the line start", async () => {
    expect(await doThis("export const f = (n: number) => n;\nexport const a = f(/* x */ 1);\n")).toEqual([["2", "no-comments", "export const a = f(1);\nPut any meaning in a name."]]);
    expect(await doThis("export const f = (n: number) => n;\nexport const a = f(1 /* x */);\n")).toEqual([["2", "no-comments", "export const a = f(1);\nPut any meaning in a name."]]);
    expect(await doThis("/* x */ export const a = 1;\n")).toEqual([["1", "no-comments", "export const a = 1;\nPut any meaning in a name."]]);
    expect(await doThis("export function g() {\n  /* x */ return 1;\n}\n")).toEqual([["2", "no-comments", "  return 1;\nPut any meaning in a name."]]);
  });

  it("a directive above a block comment shows the code line, not the comment's middle line", async () => {
    expect((await doThis("// eslint-disable-next-line\n/* first\n   second */\nexport const a = 1;\n"))[0]).toEqual(["1", "no-suppressions", "export const a = 1;\nFix the rule it hid."]);
  });

  it("a file that starts with a byte order mark gets the same Do this", async () => {
    expect(await doThis("\uFEFFexport const c = /* two */ 2;\n")).toEqual([["1", "no-comments", "export const c = 2;\nPut any meaning in a name."]]);
  });

  it("a manual commit-tier check says when it stages a lowered baseline", async () => {
    await write("a.ts", "const a = 1;\n");
    const { code, out } = await check();
    expect(code).toBe(0);
    expect(out).toBe("Staged .warden/baseline.json, which now holds 0 baselined violations; it held 1.\n");
    expect(git("diff", "--cached", "--name-only")).toContain(".warden/baseline.json");
  });

  it("a branch with no lock in its history may name a base that contains it, so Warden can be adopted on the base", async () => {
    await rm(join(root, ".git"), { recursive: true, force: true });
    git("init", "-q", "-b", "main");
    git("add", "a.ts", ".gitignore");
    git("commit", "-q", "-m", "before adoption");
    expect(recordedBases(root)).toEqual([]);
    expect((await check()).code).toBe(0);
  });

  it("the lock's recorded bases include a base set and reverted on a merged branch", async () => {
    const lockWith = async (base: string): Promise<void> => {
      const lock = JSON.parse(await read(".warden/lock.json")) as { config: { base: string } };
      lock.config.base = base;
      await write(".warden/lock.json", `${JSON.stringify(lock, null, 2)}\n`);
    };
    git("checkout", "-q", "-b", "side");
    await lockWith("dev");
    git("commit", "-q", "-am", "dev base");
    await lockWith("main");
    git("commit", "-q", "-am", "main base again");
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-ff", "--no-edit", "side");
    expect(recordedBases(root)).toContain("dev");
  });
});

describe("deferred engine review minors", () => {
  it("compile does not baseline a Guardrail that the merge-base lock already holds", async () => {
    await write(".warden/config.yaml", config(["core"]));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    await write("b.ts", "var b = 1;\n");
    await write(".warden/config.yaml", config(["core", "local"]));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect(JSON.parse(await read(".warden/baseline.json"))).toEqual({ "warden-no-comments": { "a.ts": 1 } });
    expect((await check()).code).toBe(1);
  });

  it("the run row records the base and the merge-base commit it compared with", async () => {
    await check({ base: "main" });
    const row = (await evidence()).find((e) => e.kind === "cost" && e.guardrail === "run");
    expect(row).toMatchObject({ base: "main", mergeBase: git("merge-base", "main", "HEAD").trim() });
  });

  it("a tracked source under a node_modules folder is linted", async () => {
    await write("src/node_modules/x/index.ts", "// vendored note\nexport const x = 1;\n");
    git("add", "-f", "src/node_modules/x/index.ts");
    const { code, out } = await check({ format: "json" });
    expect(code).toBe(1);
    expect(failedFiles(out)).toEqual(["src/node_modules/x/index.ts"]);
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

describe("performance: run records and input size", () => {
  const costs = async (): Promise<Record<string, unknown>[]> => (await evidence()).filter((e) => e.kind === "cost");

  it("a check writes one run record, and every cost row carries the run, tier, and size, with the pack on a Guardrail's own row", async () => {
    await addLegacy("commit", "test ! -e broken", 5000);
    await write("b.ts", "const b = 1;\n");
    git("add", "-A");
    commitSigned("ryan", "legacy");
    expect((await check({ paths: ["a.ts", "b.ts"] })).code).toBe(0);
    const rows = await costs();
    const runs = rows.filter((e) => e.guardrail === "run");
    expect(runs).toEqual([
      expect.objectContaining({ outcome: "ran", tier: "commit", files: 2, bytes: 33, commit: git("rev-parse", "HEAD").trim(), run: expect.any(String), ms: expect.any(Number) }),
    ]);
    const id = runs[0]?.run;
    const pass = rows.filter((e) => e.shared === "eslint");
    expect(pass).toHaveLength(1);
    expect(pass[0]).toMatchObject({ run: id, tier: "commit", files: 2, bytes: 33 });
    expect(pass[0]?.pack).toBeUndefined();
    const members = pass[0]?.members as string[];
    expect(Object.keys(pass[0]?.rules as Record<string, number>).sort()).toEqual([...members].sort());
    expect(Object.values(pass[0]?.rules as Record<string, number>).every((ms) => typeof ms === "number" && ms >= 0)).toBe(true);
    expect(rows.filter((e) => e.guardrail === "legacy-script")).toEqual([expect.objectContaining({ run: id, tier: "commit", pack: "legacy", files: 2, bytes: 33 })]);
  });

  it("a lint pass counts only the files the cache did not answer", async () => {
    await write("b.ts", "const b = 1;\n");
    expect((await check({ paths: ["a.ts", "b.ts"], tier: "edit" })).code).toBe(0);
    await write("b.ts", "const b = 22;\n");
    expect((await check({ paths: ["a.ts", "b.ts"], tier: "edit" })).code).toBe(0);
    const pass = (await costs()).filter((e) => e.shared === "eslint");
    expect(pass.map((e) => [e.files, e.bytes])).toEqual([[2, 33], [1, 14]]);
  });

  it("an early exit writes a run record with its outcome", async () => {
    expect((await check()).code).toBe(0);
    await writeFile(join(root, ".warden/generated/eslint.rules.json"), `${await read(".warden/generated/eslint.rules.json")}\n`);
    expect((await check()).code).toBe(1);
    git("checkout", "HEAD", "--", ".warden/generated/eslint.rules.json");
    await write("a.ts", "// one\nconst a = 2;\n");
    expect((await check({}, false)).code).toBe(1);
    const runs = (await costs()).filter((e) => e.guardrail === "run");
    expect(runs.map((e) => [e.outcome, e.tier])).toEqual([["empty", "commit"], ["tampered", "commit"], ["unstaged", "commit"]]);
    expect(new Set(runs.map((e) => e.run)).size).toBe(3);
  });

  it("each trigger writes its record, with the cache hits, the exit code, and the result", async () => {
    await write("b.ts", "const b = 1;\n");
    expect((await check({ paths: ["b.ts"] })).code).toBe(0);
    expect((await check({ paths: ["b.ts"], trigger: "git-commit" })).code).toBe(0);
    await write("b.ts", "// two\nconst b = 1;\n");
    expect((await check({ hook: "claude", hookInput: JSON.stringify({ tool_input: { file_path: join(root, "b.ts") } }) })).code).toBe(0);
    const runs = (await costs()).filter((e) => e.guardrail === "run");
    expect(runs.map((e) => [e.trigger, e.tier, e.outcome, e.result, e.exit, e.file])).toEqual([
      ["manual", "commit", "ran", "pass", 0, "b.ts"],
      ["git-commit", "commit", "ran", "pass", 0, "b.ts"],
      ["agent-edit", "edit", "ran", "fail", 0, "b.ts"],
    ]);
    expect(runs.map((e) => e.cached)).toEqual([0, 0, 0]);
    expect(runs.every((e) => typeof e.guardrails === "number" && (e.guardrails as number) > 0)).toBe(true);
    expect(runs[2]).toMatchObject({ failures: [expect.objectContaining({ file: "b.ts", line: 1, guardrail: "warden-no-comments", doThis: expect.any(String) })], next: expect.stringContaining("Do this"), ratchet: [1, 1] });
  });

  it("a run record names whether its ratchet counts came from the committed baseline or an uncommitted one", async () => {
    await write("b.ts", "const b = 1;\n");
    expect((await check({ paths: ["b.ts"], tier: "edit" })).code).toBe(0);
    await write(".warden/baseline.json", "{}\n");
    expect((await check({ paths: ["b.ts"], tier: "edit" })).code).toBe(0);
    git("rm", "-q", "--cached", ".warden/baseline.json");
    git("commit", "-q", "-m", "untrack");
    await write(".warden/baseline.json", `${JSON.stringify({ "warden-no-comments": { "a.ts": 1 } })}\n`);
    expect((await check({ paths: ["b.ts"], tier: "edit" })).code).toBe(0);
    const runs = (await costs()).filter((e) => e.guardrail === "run");
    expect(runs.map((e) => [e.ratchet, e.ratchetFrom])).toEqual([[[1, 1], "head"], [[0, 0], "uncommitted"], [[1, 1], "uncommitted"]]);
  });

  it("a check that exits 2 writes an error record with its next action", async () => {
    expect((await check({ base: undefined })).code).toBe(2);
    const runs = (await costs()).filter((e) => e.guardrail === "run");
    expect(runs).toEqual([expect.objectContaining({ outcome: "error", exit: 2, trigger: "manual", next: "run warden check --base main" })]);
    expect(runs[0]?.result).toBeUndefined();
  });

  it("a check that crashes writes an error record and fails its open step, then rethrows", async () => {
    vi.spyOn(eslintAdapter, "run").mockRejectedValue(new Error("eslint exploded"));
    await write("b.ts", "const b = 1;\n");
    await expect(check({ paths: ["b.ts"] })).rejects.toThrow("eslint exploded");
    const runs = (await costs()).filter((e) => e.guardrail === "run");
    expect(runs).toEqual([expect.objectContaining({ outcome: "error", exit: 2, next: "run warden check again; it stopped with: eslint exploded" })]);
    const steps = (await evidence()).filter((e) => e.kind === "step");
    expect(steps.at(-1)).toMatchObject({ step: "rules", state: "fail" });
  });

  it("a run record carries each rule's time, the shared pass time, the step times, and the rules the cache answered", async () => {
    await addLegacy("edit, commit", "test ! -e broken", 5000);
    await write("b.ts", "const b = 1;\n");
    git("add", "-A");
    commitSigned("ryan", "legacy");
    expect((await check({ paths: ["b.ts"], tier: "edit" })).code).toBe(0);
    expect((await check({ paths: ["b.ts"], tier: "edit" })).code).toBe(0);
    const [first, second] = (await costs()).filter((e) => e.guardrail === "run") as Record<string, unknown>[];
    const rules = first?.rules as Record<string, number>;
    expect(Object.keys(rules).sort()).toEqual(["legacy-script", "local-no-event", "local-no-var", "warden-no-comments", "warden-no-suppressions"]);
    const passes = first?.passes as Record<string, number>;
    expect(Object.keys(passes)).toEqual(["eslint"]);
    const steps = first?.steps as Record<string, number>;
    expect(Object.keys(steps)).toEqual(["rules-intact", "tools-ready", "rules", "verdict"]);
    const parts = Object.values(rules).reduce((a, b) => a + b, 0) + (passes.eslint as number);
    expect(parts).toBeLessThanOrEqual((steps.rules as number) + 1);
    expect(Object.values(steps).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(first?.ms as number);
    expect(first?.cachedRules).toEqual([]);
    expect(Object.keys(second?.rules as Record<string, number>)).toEqual(["legacy-script"]);
    expect((second?.cachedRules as string[]).sort()).toEqual(["local-no-event", "local-no-var", "warden-no-comments", "warden-no-suppressions"]);
  });

  it("a check appends its steps in order as it runs", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    expect((await check({ paths: ["b.ts"] })).code).toBe(1);
    const steps = (await evidence()).filter((e) => e.kind === "step");
    const run = (await costs()).find((e) => e.guardrail === "run")?.run;
    expect(steps.every((e) => e.run === run && typeof e.ms === "number")).toBe(true);
    expect(steps.map((e) => [e.step, e.state])).toEqual([
      ["rules-intact", "start"],
      ["rules-intact", "done"],
      ["tools-ready", "start"],
      ["tools-ready", "done"],
      ["rules", "start"],
      ["rules", "done"],
      ["verdict", "start"],
      ["verdict", "fail"],
    ]);
    expect(steps[4]).toMatchObject({ detail: "eslint", members: expect.arrayContaining(["warden-no-comments"]), trigger: "manual", tier: "commit" });
  });

  it("a tampered check fails its rules-intact step", async () => {
    await writeFile(join(root, ".warden/generated/eslint.rules.json"), `${await read(".warden/generated/eslint.rules.json")}\n`);
    expect((await check()).code).toBe(1);
    const steps = (await evidence()).filter((e) => e.kind === "step");
    expect(steps.map((e) => [e.step, e.state])).toEqual([["rules-intact", "start"], ["rules-intact", "fail"]]);
  });
});

describe("engine review: the Warden that wrote the lock", () => {
  const running = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }).version;

  const editLock = async (edit: (lock: Record<string, unknown>) => void): Promise<void> => {
    const lock = JSON.parse(await read(".warden/lock.json")) as Record<string, unknown>;
    edit(lock);
    await write(".warden/lock.json", JSON.stringify(lock));
  };

  it("a lock written by a newer Warden exits 2, names both versions, and says to install the lock's release", async () => {
    await editLock((lock) => {
      lock.warden = "99.0.0";
    });
    const { code, out, err } = await check();
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain(`was written by Warden 99.0.0; this is Warden ${running}.`);
    expect(err).toContain("Next action: install Warden 99.0.0, the release that wrote the lock, then run warden check --base main again.");
    expect(await tampered()).toEqual([]);
  });

  it("a lock written by an older Warden says to recompile, never to install the older release, and recompiling clears it", async () => {
    await editLock((lock) => {
      lock.warden = "0.0.9";
    });
    const { code, err } = await check();
    expect(code).toBe(2);
    expect(err).toContain(`was written by Warden 0.0.9, an older release than this Warden ${running}. Next action: run warden compile, stage .warden, and commit.`);
    expect(err).not.toContain("install Warden");
    expect(await tampered()).toEqual([]);
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect((await check()).code).toBe(0);
  });

  it("a lock in the previous format, hashing only each pack.yaml, says to recompile instead of reporting the pack's other files as tampering", async () => {
    await editLock((lock) => {
      lock.format = 2;
      lock.sources = Object.fromEntries(Object.entries(lock.sources as Record<string, string>).filter(([key]) => !key.startsWith("packs/") || key.endsWith("/pack.yaml")));
    });
    const { code, err } = await check();
    expect(code).toBe(2);
    expect(err).toContain(`is in an older format than this Warden ${running} writes. Next action: run warden compile, stage .warden, and commit.`);
    expect(err.match(/Next action:/g)).toHaveLength(1);
    expect(await tampered()).toEqual([]);
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect((await check()).code).toBe(0);
  });

  it("a lock that still records the old .claude/settings.json entry is an older lock, not tampering", async () => {
    await editLock((lock) => {
      (lock.generated as Record<string, string>)[".claude/settings.json#warden"] = "0".repeat(64);
    });
    const { code, err } = await check();
    expect(code).toBe(2);
    expect(err).toContain("Next action: run warden compile, stage .warden, and commit.");
    expect(await tampered()).toEqual([]);
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect(Object.keys(JSON.parse(await read(".warden/lock.json")).generated)).toEqual([".warden/generated/eslint.rules.json", ".warden/generated/hooks/pre-commit"]);
    expect((await check()).code).toBe(0);
  });

  it("a working lock in a newer format exits 2 and says to install the lock's release", async () => {
    await editLock((lock) => {
      lock.format = 4;
      lock.warden = "9.0.0";
    });
    const { code, err } = await check();
    expect(code).toBe(2);
    expect(err).toContain("has format 4; this Warden reads formats up to 3. Next action: install Warden 9.0.0, the release that wrote the lock.");
    expect(await tampered()).toEqual([]);
  });
});

describe("engine review: the result cache", () => {
  const overwriteCache = async (content: string): Promise<number> => {
    const dir = join(home, "cache/fixture");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    for (const f of files) await writeFile(join(dir, f), content);
    return files.length;
  };

  it("a forged cache entry cannot pass a failing commit-tier check", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    expect((await check()).code).toBe(1);
    expect(await overwriteCache("[]")).toBeGreaterThan(0);
    expect((await check()).code).toBe(1);
  });

  it("an unreadable cache entry is a miss, not an error", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    expect((await check({ tier: "edit" })).code).toBe(1);
    expect(await overwriteCache("[{")).toBeGreaterThan(0);
    const { code, out } = await check({ tier: "edit" });
    expect(code).toBe(1);
    expect(out).toContain("FAIL b.ts:1  no-comments");
  });
});

describe("engine review: whole-project Guardrails with no changed file", () => {
  it("a cmd Guardrail runs at its tier when nothing changed against the base", async () => {
    await addLegacy("commit, boundary", "test ! -e broken", 5000);
    await write("broken", "x\n");
    git("add", "-A");
    git("commit", "-q", "-m", "legacy and broken");
    git("branch", "-f", "main", "HEAD");
    const { code, out } = await check({ tier: "boundary" });
    expect(code).toBe(1);
    expect(out).toContain("FAIL project  legacy-check");
    expect((await check()).code).toBe(1);
  });
});

describe("engine review: a corrupt lock in history", () => {
  it("a committed lock that does not parse is skipped once a later commit restores the lock", async () => {
    const good = await read(".warden/lock.json");
    await write(".warden/lock.json", `<<<<<<< HEAD\n${good}=======\n${good}>>>>>>> other\n`);
    git("commit", "-q", "-am", "conflicted lock");
    await write(".warden/lock.json", good);
    git("commit", "-q", "-am", "restored lock");
    const { code, err } = await check();
    expect(err).toBe("");
    expect(code).toBe(0);
  });
});

describe("engine review: deleting only config.yaml", () => {
  it("is tampering with the revert action while a lock exists", async () => {
    await rm(join(root, ".warden/config.yaml"));
    const { code, out, err } = await check();
    expect(err).toBe("");
    expect(code).toBe(1);
    expect(out).toContain("Next action: revert your change to .warden/config.yaml.");
    expect(await tampered()).toEqual([{ file: ".warden/config.yaml", detail: "removed" }]);
  });
});

describe("engine review: a Guardrail added after init", () => {
  const withDebugger = (): string =>
    [
      localPack().trimEnd(),
      "  - id: no-debugger",
      "    statement: Never leave a debugger statement.",
      "    terms: []",
      "    paths: []",
      "    conflictsWith: []",
      "    guardrails:",
      "      - id: local-no-debugger",
      "        kind: lint",
      "        runs: [edit, commit]",
      "        budgetMs: 5000",
      "        version: 1",
      '        implementation: "eslint:no-debugger"',
      '        mustFail: "debugger;\\n"',
      '        mustPass: "const a = 1;\\n"',
      "",
    ].join("\n");

  it("baselines its existing violations when compile adds it, so an unrelated edit to an old file passes", async () => {
    git("checkout", "-q", "main");
    await write("c.ts", "debugger;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "old debugger");
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-edit", "main");
    await write(".warden/packs/local/pack.yaml", withDebugger());
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect(JSON.parse(await read(".warden/baseline.json"))["local-no-debugger"]).toEqual({ "c.ts": 1 });
    await write("c.ts", "debugger;\nconst c = 1;\n");
    const { code, out } = await check();
    expect(out).toBe("");
    expect(code).toBe(0);
    await write("c.ts", "debugger;\nconst c = 1;\ndebugger;\n");
    expect((await check()).code).toBe(1);
  });
});

describe("engine review: an Evidence line that does not parse", () => {
  it("is skipped, so a truncated last line does not stop the next check", async () => {
    await write("b.ts", "// two\nconst b = 1;\n");
    expect((await check({ paths: ["b.ts"] })).code).toBe(1);
    await writeFile(join(home, "evidence/fixture.jsonl"), `${await readFile(join(home, "evidence/fixture.jsonl"), "utf8")}{"at":"2026`);
    const { code, err } = await check({ paths: ["b.ts"] });
    expect(err).toBe("");
    expect(code).toBe(1);
  });
});

describe("engine review: one next action", () => {
  it("a loosened lock names the source to revert and warden compile, and following it passes", async () => {
    await write(".warden/config.yaml", withLocalPaths('["src/**/*.ts"]'));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out.split("\n").filter((l) => l.startsWith("Next action:"))).toEqual(["Next action: revert your change to .warden/config.yaml, then run warden compile."]);
    git("checkout", "main", "--", ".warden/config.yaml");
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    expect((await check()).code).toBe(0);
  });

  it("a base with no shared history names the cause and one action", async () => {
    git("checkout", "-q", "--orphan", "other");
    git("commit", "-q", "-m", "unrelated");
    git("checkout", "-q", "feature");
    const { code, err } = await check({ base: "other" });
    expect(code).toBe(2);
    expect(err).toContain("other and HEAD share no history. Next action: run warden check --base <the branch this work merges into>.");
  });

  it("a shallow clone without the merge base says to unshallow it", async () => {
    await write("b.ts", "const b = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "feature work");
    git("checkout", "-q", "main");
    await write("c.ts", "const c = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "main work");
    const origin = root;
    root = await realpath(await mkdtemp(join(tmpdir(), "warden-shallow-")));
    try {
      git("clone", "-q", "--depth", "1", "--no-single-branch", "-b", "feature", `file://${origin}`, ".");
      const { code, err } = await check({ base: "origin/main" });
      expect(code).toBe(2);
      expect(err).toContain("no merge base in this shallow clone. Next action: run git fetch --unshallow, then run warden check --base origin/main again.");
    } finally {
      await rm(root, { recursive: true, force: true });
      root = origin;
    }
  });
});

describe("signed .warden changes", () => {
  beforeEach(async () => {
    await write(".warden/notes.txt", "one\n");
    git("add", "-A");
    git("commit", "-q", "-m", "notes");
    git("branch", "-f", "main", "HEAD");
  });

  it("an unsigned commit that changes .warden is tampering with one next action", async () => {
    await write(".warden/notes.txt", signers("ryan", "agent"));
    git("commit", "-q", "-am", "add my key");
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "unsigned" }]);
    expect(out.match(/Next action:/g)).toHaveLength(1);
    expect(out).toContain(`Next action: run git --literal-pathspecs restore --source=${git("rev-parse", "main").trim()} --staged --worktree -- '.warden/notes.txt' && git --literal-pathspecs commit --only --allow-empty -m 'Restore .warden files changed without an allowed signature' -- '.warden/notes.txt' to restore the .warden/ files changed without an allowed signature to the merge base, then run warden check again.`);
    await follow(out);
    expect((await check()).code).toBe(0);
    expect(await read(".warden/notes.txt")).toBe("one\n");
  });

  const commitEnv = async (): Promise<NodeJS.ProcessEnv> => {
    const bin = join(root, ".git", "warden-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "warden"), `#!/bin/sh\nexec '${process.execPath}' --preserve-symlinks --preserve-symlinks-main '${join(wardenRoot, "dist/src/cli/main.js")}' "$@"\n`, { mode: 0o755 });
    git("config", "core.hooksPath", ".warden/generated/hooks");
    git("config", "commit.gpgsign", "false");
    return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  };

  const follow = async (out: string): Promise<void> => {
    const action = /Next action: run (.*) to restore the \.warden\/ files/s.exec(out)?.[1];
    expect(action).toBeDefined();
    const r = spawnSync("sh", ["-c", action as string], { cwd: root, env: await commitEnv(), encoding: "utf8" });
    expect(`${r.stdout}${r.stderr}`).not.toContain("TAMPERED");
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  };

  const fixes = async (stage = true): Promise<void> => {
    await follow((await check({}, stage)).out);
    expect((await check({}, stage)).code).toBe(0);
  };

  it("a staged revert of a committed unsigned change is told a command that works, which a refusing pre-commit hook does not block", async () => {
    await write(".warden/notes.txt", "two\n");
    git("commit", "-q", "-am", "agent change");
    const sha = git("rev-parse", "HEAD").trim();
    await write(".warden/notes.txt", "one\n");
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out.match(/Next action:/g)).toHaveLength(1);
    expect(out).toContain(`Next action: run git --literal-pathspecs restore --source=${git("rev-parse", "main").trim()} `);
    expect(out).not.toContain("stash");
    expect(sha).not.toBe(git("rev-parse", "main").trim());
    await follow(out);
    expect((await check()).code).toBe(0);
  });

  it("an unsigned merge is told a restore that works", async () => {
    git("checkout", "-q", "-b", "side");
    await write(".warden/side.txt", "side\n");
    git("add", "-A");
    commitSigned("ryan", "side");
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-ff", "--no-commit", "side");
    await write(".warden/notes.txt", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "merge side");
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out).toContain("-- '.warden/notes.txt' && ");
    await follow(out);
    expect((await check()).code).toBe(0);
  });

  it("an unsigned commit that loosens a Guardrail is told to restore it first, and that clears every failure", async () => {
    await write(".warden/packs/local/pack.yaml", localPack().replace("runs: [edit, commit]", "runs: [edit]"));
    expect((await compile(root, wardenRoot)).findings).toEqual([]);
    git("add", "-A");
    git("commit", "-q", "-m", "loosen");
    const { code, out } = await check();
    expect(code).toBe(1);
    expect((await tampered()).map((t) => t.detail)).toContain("loosened");
    expect(out.match(/Next action:/g)).toHaveLength(1);
    await follow(out);
    expect((await check()).code).toBe(0);
  });

  it("several unsigned commits are restored to the merge base in one commit", async () => {
    await write(".warden/b.txt", "x\n");
    await write(".warden/notes.txt", "c1\n");
    git("add", "-A");
    git("commit", "-q", "-m", "c1");
    await write(".warden/b.txt", "y\n");
    git("add", "-A");
    git("commit", "-q", "-m", "c2");
    await write(".warden/notes.txt", "c3\n");
    git("add", "-A");
    git("commit", "-q", "-m", "c3");
    const { out } = await check();
    expect(out).toContain("-- '.warden/b.txt' '.warden/notes.txt' && ");
    await follow(out);
    expect((await check()).code).toBe(0);
    expect(existsSync(join(root, ".warden/b.txt"))).toBe(false);
    expect(git("rev-list", "--count", "main..HEAD").trim()).toBe("4");
  });

  const gitlink = async (ignore: boolean): Promise<void> => {
    const sub = git("commit-tree", git("mktree").trim(), "-m", "sub").trim();
    git("update-index", "--add", "--cacheinfo", `160000,${sub},.warden/packs/evil`);
    await write(".gitmodules", `[submodule "evil"]\n\tpath = .warden/packs/evil\n\turl = https://example.invalid/x\n${ignore ? "\tignore = all\n" : ""}`);
    git("add", ".gitmodules");
    git("commit", "-q", "-m", "gitlink");
  };

  it("a submodule ignore = all in .gitmodules cannot hide an unsigned gitlink under .warden", async () => {
    await gitlink(true);
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/packs/evil", detail: "unsigned" }]);
    expect(out.match(/Next action:/g)).toHaveLength(1);
    await follow(out);
    expect((await check({}, false)).code).toBe(0);
  });

  it("diff.ignoreSubmodules = all in the repository config cannot hide an unsigned gitlink under .warden", async () => {
    await gitlink(false);
    git("config", "diff.ignoreSubmodules", "all");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/packs/evil", detail: "unsigned" }]);
    expect(out.match(/Next action:/g)).toHaveLength(1);
    await follow(out);
    expect((await check({}, false)).code).toBe(0);
  });

  it("an unsigned orphan first parent is tampering with one next action that works", async () => {
    git("switch", "-q", "--orphan", "orphan");
    git("checkout", "main", "--", ".");
    await write(".warden/notes.txt", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "orphan");
    git("merge", "-q", "--allow-unrelated-histories", "-s", "ours", "main", "-m", "merge main");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "unsigned" }]);
    expect(out.match(/Next action:/g)).toHaveLength(1);
    await follow(out);
    expect((await check({}, false)).code).toBe(0);
  });

  it("an untracked file in a path the restore brings back is replaced by the merge-base content", async () => {
    git("rm", "-q", ".warden/notes.txt");
    git("commit", "-q", "-m", "delete notes");
    await write(".warden/notes.txt", "local\n");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    await follow(out);
    expect((await check({}, false)).code).toBe(0);
    expect(await read(".warden/notes.txt")).toBe("one\n");
  });

  it("a restore keeps a later change to the same lines outside .warden and finishes under the pre-commit hook", async () => {
    await write(".warden/notes.txt", "evil\n");
    await write("a.ts", "// one\nconst a = 2;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "c1");
    await write("a.ts", "// one\nconst a = 3;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "c2");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    await follow(out);
    expect(await read("a.ts")).toBe("// one\nconst a = 3;\n");
    expect((await check({}, false)).code).toBe(0);
  });

  it("a merge of a signed main change over an unsigned edit to the same .warden lines is restored to the merge base in one step", async () => {
    await write(".warden/notes.txt", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "c1 unsigned");
    git("checkout", "-q", "main");
    await write(".warden/notes.txt", "b\n");
    git("add", "-A");
    commitSigned("ryan", "main signed");
    git("checkout", "-q", "feature");
    expect(() => git("merge", "-q", "main", "-m", "merge main")).toThrow();
    await write(".warden/notes.txt", "evil\n");
    git("add", "-A");
    git("commit", "-q", "--no-edit");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "unsigned" }]);
    expect(out.match(/Next action:/g)).toHaveLength(1);
    expect(out).toContain(`restore --source=${git("rev-parse", "main").trim()} `);
    await follow(out);
    expect(await read(".warden/notes.txt")).toBe("b\n");
    expect((await check({}, false)).code).toBe(0);
  });

  it("a signed later edit of a line an unsigned commit changed is restored to the merge base in one step", async () => {
    await write(".warden/notes.txt", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "c1 unsigned");
    await write(".warden/notes.txt", "evil2\n");
    git("add", "-A");
    commitSigned("ryan", "c2 signed");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "unsigned" }]);
    await follow(out);
    expect(await read(".warden/notes.txt")).toBe("one\n");
    expect((await check({}, false)).code).toBe(0);
  });

  it("a staged change outside .warden stays staged and out of the restore commit", async () => {
    await write(".warden/notes.txt", "evil\n");
    git("commit", "-q", "-am", "c1 unsigned");
    await write("a.ts", "const a = 9;\n");
    git("add", "a.ts");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    expect(out).not.toContain("stash");
    await follow(out);
    expect(git("diff", "--name-only", "HEAD~1", "HEAD").trim()).toBe(".warden/notes.txt");
    expect(git("diff", "--cached", "--name-only").trim()).toBe("a.ts");
    expect((await check({}, false)).code).toBe(0);
  });

  const hookCommit = async (message: string): Promise<string> => {
    const r = spawnSync("git", ["commit", "-m", message], { cwd: root, env: await commitEnv(), encoding: "utf8" });
    expect(r.status).not.toBe(0);
    return `${r.stdout}${r.stderr}`;
  };

  it("an untracked pack file beside an unsigned change is named first, and the restore after it is accepted by the hook", async () => {
    await write(".warden/notes.txt", "evil\n");
    git("commit", "-q", "-am", "c1 unsigned");
    await write(".warden/packs/local/extra.yaml", "x: 1\n");
    const first = await check({}, false);
    expect(first.code).toBe(1);
    expect(first.out.match(/Next action:/g)).toHaveLength(1);
    expect(first.out).toContain("Next action: delete .warden/packs/local/extra.yaml.");
    await rm(join(root, ".warden/packs/local/extra.yaml"));
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    await follow(out);
    expect((await check({}, false)).code).toBe(0);
  });

  it("a partial staged restore refused by the hook gets a hook action that restores every unsigned path", async () => {
    await write(".warden/notes.txt", "evil\n");
    await write(".warden/b.txt", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "two unsigned");
    git("restore", "--source=main", "--staged", "--worktree", "--", ".warden/notes.txt");
    const refused = await hookCommit("partial");
    expect(refused).toContain("TAMPERED .warden/b.txt  unsigned");
    expect(refused).toContain("-- '.warden/b.txt' '.warden/notes.txt' to restore");
    await follow(refused);
    expect((await check({}, false)).code).toBe(0);
    expect(existsSync(join(root, ".warden/b.txt"))).toBe(false);
  });

  it("a staged git rm of an unsigned added file gets a restore that commits the deletion", async () => {
    await write(".warden/b.txt", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add b unsigned");
    git("rm", "-q", ".warden/b.txt");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    await follow(out);
    expect((await check({}, false)).code).toBe(0);
    expect(git("stash", "list")).toBe("");
  });

  it("the hook's action after a staged git rm under .warden works", async () => {
    await write(".warden/b.txt", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add b unsigned");
    await write(".warden/notes.txt", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "notes unsigned");
    git("rm", "-q", ".warden/b.txt");
    await follow(await hookCommit("undo b"));
    expect((await check({}, false)).code).toBe(0);
  });

  it("a staged deletion outside .warden stays staged while the restore commits", async () => {
    await write(".warden/notes.txt", "evil\n");
    git("commit", "-q", "-am", "c1 unsigned");
    git("rm", "-q", "a.ts");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    await follow(out);
    expect(git("status", "--short")).toContain("D  a.ts");
    expect(git("diff", "--name-only", "HEAD~1", "HEAD").trim()).toBe(".warden/notes.txt");
    expect((await check({}, false)).code).toBe(0);
  });

  it("an unsigned commit that also raises the baseline gets a restore that includes the baseline", async () => {
    const before = await read(".warden/baseline.json");
    await write(".warden/notes.txt", "evil\n");
    await write(".warden/baseline.json", `${JSON.stringify({ ...JSON.parse(before), "local/no-broken": { "a.ts": 5 } }, null, 2)}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "raise");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    expect(out).toContain("-- '.warden/baseline.json' '.warden/notes.txt' to restore");
    await follow(out);
    expect(await read(".warden/baseline.json")).toBe(before);
    expect((await check({}, false)).code).toBe(0);
  });

  it("an unsigned change under a case variant of .warden is unsigned where git ignores case", async () => {
    git("config", "core.ignorecase", "true");
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: "x: 1\n", encoding: "utf8" }).trim();
    git("update-index", "--add", "--cacheinfo", `100644,${blob},.WARDEN/packs/local/extra.yaml`);
    git("commit", "-q", "-m", "case variant");
    expect((await check({}, false)).code).toBe(1);
    expect(await tampered()).toContainEqual({ file: ".WARDEN/packs/local/extra.yaml", detail: "unsigned" });
  });

  it("a case-only rename under .warden gets a restore that converges where git ignores case", async () => {
    git("config", "core.ignorecase", "true");
    git("mv", ".warden/notes.txt", ".warden/NOTES.txt");
    git("commit", "-q", "-m", "case rename");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    await follow(out);
    expect((await check({}, false)).code).toBe(0);
    expect(git("ls-tree", "-r", "--name-only", "HEAD", "--", ".warden/notes.txt").trim()).toBe(".warden/notes.txt");
  });

  it("git rm --cached of an unsigned added file gets a restore whose one commit removes it", async () => {
    await write(".warden/b.txt", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add b unsigned");
    git("rm", "-q", "--cached", ".warden/b.txt");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    await follow(out);
    expect(git("diff", "--name-only", "HEAD~1", "HEAD").trim()).toBe(".warden/b.txt");
    expect((await check({}, false)).code).toBe(0);
  });

  const outside = async (): Promise<string> => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "warden-outside-")));
    await writeFile(join(dir, "file"), "precious\n");
    await writeFile(join(dir, "-rf x"), "precious\n");
    return dir;
  };

  it("the restore never deletes a file outside .warden through a symlinked parent folder", async () => {
    await write(".warden/sub/file", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add sub/file unsigned");
    git("rm", "-r", "-q", "--cached", ".warden/sub");
    await rm(join(root, ".warden/sub"), { recursive: true });
    const dir = await outside();
    try {
      await symlink(dir, join(root, ".warden/sub"));
      const { code, out } = await check({}, false);
      expect(code).toBe(1);
      expect(out).toContain("Next action: run git --literal-pathspecs clean -ff -x -- '.warden/sub' && ");
      await follow(out);
      expect((await readdir(dir)).sort()).toEqual(["-rf x", "file"]);
      expect(existsSync(join(root, ".warden/sub"))).toBe(false);
      expect((await check({}, false)).code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the printed restore deletes nothing outside .warden when a symlink replaces the folder after the check prints it", async () => {
    await write(".warden/sub/file", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add sub/file unsigned");
    git("rm", "-r", "-q", "--cached", ".warden/sub");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    expect(out).toContain("Next action: run git --literal-pathspecs clean -ff -x -- '.warden/sub/file' && ");
    const dir = await outside();
    try {
      await rm(join(root, ".warden/sub"), { recursive: true });
      await symlink(dir, join(root, ".warden/sub"));
      const action = /Next action: run (.*) to restore the \.warden\/ files/s.exec(out)?.[1] as string;
      spawnSync("sh", ["-c", action], { cwd: root, env: await commitEnv(), encoding: "utf8" });
      expect((await readdir(dir)).sort()).toEqual(["-rf x", "file"]);
      expect(await readFile(join(dir, "file"), "utf8")).toBe("precious\n");
      await fixes(false);
      expect((await readdir(dir)).sort()).toEqual(["-rf x", "file"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const caseAlias = async (): Promise<void> => {
    await write(".warden/sub/keep", "keep\n");
    git("add", "-A");
    commitSigned("ryan", "signed keep");
    git("branch", "-f", "main", "HEAD");
    await write(".warden/sub/file", "evil\n");
    const blob = git("hash-object", "-w", ".warden/sub/file").trim();
    git("update-index", "--add", "--cacheinfo", `100644,${blob},.warden/Sub/file`);
    git("commit", "-q", "-m", "unsigned case alias");
    git("--literal-pathspecs", "rm", "-q", "--cached", ".warden/Sub/file");
  };

  it("a stray path whose case differs from its real folder on disk is removed and the check converges", async (ctx) => {
    if (!existsSync(join(root, ".WARDEN"))) ctx.skip();
    git("config", "core.ignorecase", "true");
    await caseAlias();
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    expect(out).toContain("Next action: run git --literal-pathspecs clean -ff -x -- '.warden/sub/file' && ");
    await fixes(false);
    expect(await readdir(join(root, ".warden/sub"))).toEqual(["keep"]);
  });

  it("a stray path whose case differs from a symlinked folder on disk removes only the link and the check converges", async (ctx) => {
    if (!existsSync(join(root, ".WARDEN"))) ctx.skip();
    git("config", "core.ignorecase", "true");
    await write(".warden/Sub/file", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add Sub/file unsigned");
    git("rm", "-r", "-q", "--cached", ".warden/Sub");
    await rm(join(root, ".warden/Sub"), { recursive: true });
    const dir = await outside();
    try {
      await symlink(dir, join(root, ".warden/sub"));
      const { code, out } = await check({}, false);
      expect(code).toBe(1);
      expect(out).toContain("Next action: run git --literal-pathspecs clean -ff -x -- '.warden/sub' && ");
      await fixes(false);
      expect((await readdir(dir)).sort()).toEqual(["-rf x", "file"]);
      expect(existsSync(join(root, ".warden/sub"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a symlinked parent folder that is staged in the index is unstaged and removed, and the check converges", async () => {
    await write(".warden/sub/file", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add sub/file unsigned");
    git("rm", "-r", "-q", "--cached", ".warden/sub");
    await rm(join(root, ".warden/sub"), { recursive: true });
    const dir = await outside();
    try {
      await symlink(dir, join(root, ".warden/sub"));
      git("add", ".warden/sub");
      const { code, out } = await check({}, false);
      expect(code).toBe(1);
      expect(out).toContain("Next action: run git --literal-pathspecs rm -q -f --cached --ignore-unmatch -- '.warden/sub' && git --literal-pathspecs clean -ff -x -- '.warden/sub' && ");
      await fixes(false);
      expect((await readdir(dir)).sort()).toEqual(["-rf x", "file"]);
      expect(existsSync(join(root, ".warden/sub"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a staged symlinked parent pointed at a new target after staging is unstaged and removed, and the check converges", async () => {
    await write(".warden/sub/file", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add sub/file unsigned");
    git("rm", "-r", "-q", "--cached", ".warden/sub");
    await rm(join(root, ".warden/sub"), { recursive: true });
    const first = await outside();
    const second = await outside();
    try {
      await symlink(first, join(root, ".warden/sub"));
      git("add", ".warden/sub");
      await rm(join(root, ".warden/sub"));
      await symlink(second, join(root, ".warden/sub"));
      const { code, out } = await check({}, false);
      expect(code).toBe(1);
      expect(out).toContain("Next action: run git --literal-pathspecs rm -q -f --cached --ignore-unmatch -- '.warden/sub' && ");
      await fixes(false);
      for (const dir of [first, second]) expect((await readdir(dir)).sort()).toEqual(["-rf x", "file"]);
      expect(existsSync(join(root, ".warden/sub"))).toBe(false);
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });

  it("a staged symlinked parent whose index spelling differs in case from the disk is unstaged by its index spelling, and the check converges", async (ctx) => {
    if (!existsSync(join(root, ".WARDEN"))) ctx.skip();
    git("config", "core.ignorecase", "true");
    await write(".warden/Sub/file", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add Sub/file unsigned");
    git("rm", "-r", "-q", "--cached", ".warden/Sub");
    await rm(join(root, ".warden/Sub"), { recursive: true });
    const dir = await outside();
    try {
      await symlink(dir, join(root, ".warden/sub"));
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: dir, encoding: "utf8" }).trim();
      git("update-index", "--add", "--cacheinfo", `120000,${blob},.warden/Sub`);
      const { code, out } = await check({}, false);
      expect(code).toBe(1);
      expect(out).toContain("Next action: run git --literal-pathspecs rm -q -f --cached --ignore-unmatch -- '.warden/Sub' && git --literal-pathspecs clean -ff -x -- '.warden/sub' && ");
      await fixes(false);
      expect((await readdir(dir)).sort()).toEqual(["-rf x", "file"]);
      expect(existsSync(join(root, ".warden/sub"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a nested git repository at a stray path is removed and the check converges", async () => {
    await write(".warden/x", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add x unsigned");
    git("rm", "-q", "--cached", ".warden/x");
    await rm(join(root, ".warden/x"));
    await mkdir(join(root, ".warden/x"));
    execFileSync("git", ["init", "-q"], { cwd: join(root, ".warden/x") });
    await writeFile(join(root, ".warden/x/a"), "a\n");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    expect(out).toContain("Next action: run git --literal-pathspecs clean -ff -x -- '.warden/x' && ");
    await fixes(false);
    expect(existsSync(join(root, ".warden/x"))).toBe(false);
  });

  it("a stray path that differs only in case from a tracked file commits the index and the check converges", async (ctx) => {
    if (!existsSync(join(root, ".WARDEN"))) ctx.skip();
    git("config", "core.ignorecase", "true");
    await write(".warden/sub/file", "signed\n");
    git("add", "-A");
    commitSigned("ryan", "signed file");
    git("branch", "-f", "main", "HEAD");
    await write("evil.txt", "evil\n");
    const blob = git("hash-object", "-w", "evil.txt").trim();
    await rm(join(root, "evil.txt"));
    git("update-index", "--add", "--cacheinfo", `100644,${blob},.warden/Sub/file`);
    git("commit", "-q", "-m", "unsigned case alias of a tracked file");
    git("--literal-pathspecs", "rm", "-q", "--cached", ".warden/Sub/file");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    expect(out).toContain("&& git commit --allow-empty -m 'Restore .warden files changed without an allowed signature' to restore");
    await fixes(false);
    expect(await read(".warden/sub/file")).toBe("signed\n");
    expect(git("ls-tree", "-r", "--name-only", "HEAD", ".warden").split("\n")).not.toContain(".warden/Sub/file");
  });

  it("the restore removes hostile untracked names literally and touches nothing else", async () => {
    const names = [".warden/-rf x", ".warden/a b", ".warden/$(touch PWNED)", ".warden/q'uote", ".warden/..dots", ".warden/-", ".warden/*"];
    for (const n of names) await write(n, "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "hostile unsigned");
    git("--literal-pathspecs", "rm", "-q", "--cached", "--", ...names);
    await write("keep.txt", "keep\n");
    const { code, out } = await check({}, false);
    expect(code).toBe(1);
    await follow(out);
    expect((await check({}, false)).code).toBe(0);
    expect(existsSync(join(root, "PWNED")) || existsSync(join(root, ".warden/PWNED"))).toBe(false);
    expect(await read("keep.txt")).toBe("keep\n");
    expect((await readdir(join(root, ".warden"))).filter((n) => names.includes(`.warden/${n}`))).toEqual([]);
  });

  it("the hook still refuses a plain partial commit whose unstaged files would fail a commit-tier guardrail", async () => {
    git("checkout", "-q", "main");
    await addLegacy("commit", 'test ! -e broken && test "$(cat x.ts 2>/dev/null)" = "$(cat y.ts 2>/dev/null)"', 5000);
    await write("x.ts", "export const v = 1;\n");
    await write("y.ts", "export const v = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "x y");
    git("checkout", "-q", "-B", "feature");
    await write("x.ts", "export const v = 2;\n");
    await write("y.ts", "export const v = 2;\n");
    git("add", "x.ts");
    const head = git("rev-parse", "HEAD").trim();
    const refused = await hookCommit("partial");
    expect(refused).toContain("UNSTAGED y.ts");
    expect(git("rev-parse", "HEAD").trim()).toBe(head);
  });

  it("Warden's pre-commit hook still refuses a staged unsigned .warden change over an unsigned commit", async () => {
    await write(".warden/notes.txt", "evil\n");
    git("commit", "-q", "-am", "c1 unsigned");
    const head = git("rev-parse", "HEAD").trim();
    await write(".warden/notes.txt", "evil2\n");
    git("add", "-A");
    const r = spawnSync("git", ["commit", "-m", "c2"], { cwd: root, env: await commitEnv(), encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("TAMPERED .warden/notes.txt  unsigned");
    expect(git("rev-parse", "HEAD").trim()).toBe(head);
  });

  it("a graft cannot hide an unsigned deletion", async () => {
    git("rm", "-q", ".warden/notes.txt");
    git("commit", "-q", "-m", "delete notes");
    await writeFile(join(root, ".git/info/grafts"), `${git("rev-parse", "HEAD").trim()} ${git("rev-parse", "main~1").trim()}\n`);
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "unsigned" }]);
    await fixes();
  });

  it("a graft cannot move the merge base onto an unsigned change", async () => {
    await write(".warden/notes.txt", "evil\n");
    git("commit", "-q", "-am", "agent change");
    const [u, n, before] = ["HEAD", "main", "main~1"].map((r) => git("rev-parse", r).trim()) as [string, string, string];
    const x = git("commit-tree", `${u}^{tree}`, "-p", before, "-m", "stand-in").trim();
    await writeFile(join(root, ".git/info/grafts"), `${n} ${before} ${x}\n${u} ${x}\n`);
    expect(git("merge-base", "main", "HEAD").trim()).toBe(x);
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "unsigned" }]);
    await fixes();
  });

  it("a forged commit-graph cannot give an unsigned commit the base tree", async () => {
    await write(".warden/notes.txt", "evil\n");
    git("commit", "-q", "-am", "agent change");
    const [u, tree] = [git("rev-parse", "HEAD").trim(), git("rev-parse", "main^{tree}").trim()];
    git("commit-graph", "write", "--reachable");
    const file = join(root, ".git/objects/info/commit-graph");
    const b = await readFile(file);
    const chunk = new Map(Array.from({ length: (b[6] as number) + 1 }, (_, i) => [b.subarray(8 + 12 * i, 12 + 12 * i).toString("latin1"), Number(b.readBigUInt64BE(12 + 12 * i))]));
    const [oidl, cdat] = [chunk.get("OIDL") as number, chunk.get("CDAT") as number];
    let i = 0;
    while (b.subarray(oidl + 20 * i, oidl + 20 * i + 20).toString("hex") !== u) i++;
    Buffer.from(tree, "hex").copy(b, cdat + 36 * i);
    createHash("sha1").update(b.subarray(0, b.length - 20)).digest().copy(b, b.length - 20);
    await chmod(file, 0o644);
    await writeFile(file, b);
    expect(git("diff", "main", "HEAD", "--", ".warden")).toBe("");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "unsigned" }]);
    await fixes();
  });


  it("a replace ref cannot stand a base-tree commit in for an unsigned change", async () => {
    await write(".warden/notes.txt", "two\n");
    git("commit", "-q", "-am", "agent change");
    git("replace", "HEAD", git("commit-tree", "main^{tree}", "-p", "main", "-m", "stand-in").trim());
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "unsigned" }]);
    await fixes();
  });

  it("an unsigned merge that changes .warden itself is unsigned", async () => {
    git("checkout", "-q", "-b", "side");
    await write(".warden/side.txt", "side\n");
    git("add", "-A");
    commitSigned("ryan", "side");
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-ff", "--no-commit", "side");
    await write(".warden/notes.txt", "evil\n");
    git("add", "-A");
    git("commit", "-q", "-m", "merge side");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "unsigned" }]);
    await fixes();
  });

  it("a signed merge does not vouch for an unsigned commit it brings in", async () => {
    git("checkout", "-q", "-b", "side");
    await write(".warden/side.txt", "side\n");
    git("add", "-A");
    git("commit", "-q", "-m", "side");
    git("checkout", "-q", "feature");
    git("-c", "gpg.format=ssh", "-c", "gpg.ssh.program=ssh-keygen", "-c", `user.signingkey=${join(keys, "ryan")}`, "merge", "-q", "--no-ff", "-S", "-m", "merge side", "side");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/side.txt", detail: "unsigned" }]);
    await fixes();
  });

  it("a clean unsigned merge of a signed commit passes", async () => {
    git("checkout", "-q", "-b", "side");
    await write(".warden/side.txt", "side\n");
    git("add", "-A");
    commitSigned("ryan", "side");
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-ff", "-m", "merge side", "side");
    expect((await check()).code).toBe(0);
  });

  it("a signed merge that changes .warden itself passes", async () => {
    git("checkout", "-q", "-b", "side");
    await write(".warden/side.txt", "side\n");
    git("add", "-A");
    commitSigned("ryan", "side");
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-ff", "--no-commit", "side");
    await write(".warden/notes.txt", "merged\n");
    git("add", "-A");
    commitSigned("ryan", "merge side");
    expect((await check()).code).toBe(0);
    expect(await tampered()).toEqual([]);
  });

  it("a signed rename under .warden passes", async () => {
    git("mv", ".warden/notes.txt", ".warden/moved.txt");
    commitSigned("ryan", "rename notes");
    expect((await check()).code).toBe(0);
    expect(await tampered()).toEqual([]);
  });

  it("an unsigned deletion under .warden is unsigned", async () => {
    git("rm", "-q", ".warden/notes.txt");
    git("commit", "-q", "-m", "delete notes");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "unsigned" }]);
    await fixes();
  });

  it.each([
    [".warden/moved.txt", [".warden/moved.txt", ".warden/notes.txt"]],
    ["notes.txt", [".warden/notes.txt"]],
  ])("an unsigned rename to %s reports every .warden path it touches", async (to, files) => {
    git("mv", ".warden/notes.txt", to);
    git("commit", "-q", "-m", "rename notes");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual(files.map((file) => ({ file, detail: "unsigned" })));    await fixes();
  });

  it("a file name that holds the old record separator cannot mark another file signed", async () => {
    const odd = ".warden/a\x01G\n";
    await write(odd, "odd\n");
    await write(".warden/notes.txt", "two\n");
    git("add", "-A");
    git("commit", "-q", "-m", "odd name");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([
      { file: odd, detail: "unsigned" },
      { file: ".warden/notes.txt", detail: "unsigned" },
    ]);
    await fixes();
  });

  it("a key outside the packaged allowed signers is untrusted, whatever the repository config says", async () => {
    await write(".warden/notes.txt", signers("ryan", "agent"));
    await writeFile(join(keys, "agent_signers"), signers("agent"));
    git("config", "gpg.ssh.allowedSignersFile", join(keys, "agent_signers"));
    git("add", "-A");
    commitSigned("agent", "add my key");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "untrusted-signature" }]);
    await fixes();
  });

  it("a .warden change signed by an allowed key passes", async () => {
    await write(".warden/notes.txt", signers("ryan", "agent"));
    git("add", "-A");
    commitSigned("ryan", "add the agent key");
    expect((await check()).code).toBe(0);
    expect(await tampered()).toEqual([]);
  });

  it("reverting an unsigned .warden change clears it once the revert is committed, not before", async () => {
    await write(".warden/notes.txt", signers("ryan", "agent"));
    git("commit", "-q", "-am", "add my key");
    await write(".warden/notes.txt", "one\n");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "unsigned" }]);
    git("commit", "-q", "-m", "revert my key");
    expect((await check()).code).toBe(0);
  });

  it("an unsigned commit stays unsigned while its file has other uncommitted edits", async () => {
    await write(".warden/notes.txt", signers("ryan", "agent"));
    git("commit", "-q", "-am", "add my key");
    await write(".warden/notes.txt", `${signers("ryan", "agent")} `);
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "unsigned" }]);
    await fixes();
  });

  it("a later signed commit does not vouch for an earlier unsigned one", async () => {
    await write(".warden/notes.txt", signers("ryan", "agent"));
    git("commit", "-q", "-am", "add my key");
    await write(".warden/notes.txt", `${signers("ryan", "agent")}\n`);
    git("add", "-A");
    commitSigned("ryan", "tidy");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "unsigned" }]);
    await fixes();
  });

  it.each(["openpgp", "x509"])("a %s program in the repository config cannot vouch for a change", async (format) => {
    const fake = join(keys, `fake-${format}`);
    const armor = format === "x509" ? "SIGNED MESSAGE" : "PGP SIGNATURE";
    await writeFile(fake, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "--verify" ]; then printf "[GNUPG:] NEWSIG\\n[GNUPG:] GOODSIG ABCDEF ryan\\n[GNUPG:] VALIDSIG ABCDEF 2026-01-01 0 4 0 1 8 00 ABCDEF\\n[GNUPG:] TRUST_ULTIMATE 0 pgp\\n"; exit 0; fi; done\ncat >/dev/null\necho "[GNUPG:] SIG_CREATED " >&2\nprintf -- "-----BEGIN ${armor}-----\\nfake\\n-----END ${armor}-----\\n"\n`);
    await chmod(fake, 0o755);
    git("config", "gpg.program", fake);
    git("config", "gpg.x509.program", fake);
    await write(".warden/notes.txt", signers("ryan", "agent"));
    git("add", "-A");
    git("-c", `gpg.format=${format}`, "commit", "-q", "-S", "-m", "add my key");
    expect(git("log", "-1", "--format=%G?").trim()).toBe("G");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "unsigned" }]);
    await fixes();
  });

  it("an ssh program in the repository config cannot vouch for a key", async () => {
    const fake = join(keys, "fakessh");
    await writeFile(fake, '#!/bin/sh\ncat >/dev/null\ncase "$*" in *find-principals*) echo ryan ;; *) echo \'Good "git" signature for ryan with ED25519 key SHA256:x\' ;; esac\n');
    await chmod(fake, 0o755);
    await write(".warden/notes.txt", signers("ryan", "agent"));
    git("add", "-A");
    commitSigned("agent", "add my key");
    git("config", "gpg.ssh.program", fake);
    expect(git("-c", `gpg.ssh.allowedSignersFile=${join(keys, "none")}`, "log", "-1", "--format=%G?").trim()).toBe("G");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "untrusted-signature" }]);
    await fixes();
  });

  it("a replace ref cannot stand a signed commit in for an unsigned one", async () => {
    await write(".warden/notes.txt", signers("ryan", "agent"));
    git("commit", "-q", "-am", "add my key");
    const unsigned = git("rev-parse", "HEAD").trim();
    git("-c", "gpg.format=ssh", "-c", "gpg.ssh.program=ssh-keygen", "-c", `user.signingkey=${join(keys, "ryan")}`, "commit", "-q", "--amend", "-S", "--no-edit");
    const signed = git("rev-parse", "HEAD").trim();
    git("reset", "-q", "--hard", unsigned);
    git("replace", unsigned, signed);
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "unsigned" }]);
    await fixes();
  });

  it("a signed change checked without ssh-keygen on PATH says to install it, not to revert", async () => {
    await write(".warden/notes.txt", signers("ryan", "agent"));
    git("add", "-A");
    commitSigned("ryan", "add the agent key");
    const bin = await mkdtemp(join(tmpdir(), "warden-bin-"));
    await symlink(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
    vi.stubEnv("PATH", bin);
    const { code, out, err } = await check().finally(() => rm(bin, { recursive: true, force: true }));
    expect(code).toBe(2);
    expect(`${out}${err}`.match(/Next action:/g)).toHaveLength(1);
    expect(err).toContain("Next action: install OpenSSH so ssh-keygen is on PATH, then run warden check again.");
  });

  it("an allowed_signers file in the repository cannot vouch for a key", async () => {
    await write(".warden/allowed_signers", signers("ryan", "agent"));
    git("add", "-A");
    commitSigned("ryan", "list the agent key in the repository");
    git("branch", "-f", "main", "HEAD");
    await write(".warden/notes.txt", "two\n");
    git("add", "-A");
    commitSigned("agent", "change notes");
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: ".warden/notes.txt", detail: "untrusted-signature" }]);
    await fixes();
  });

  it.each([["missing", null], ["empty", " \n"]])("a %s packaged allowed-signers list fails every .warden change with one next action", async (_, text) => {
    if (text === null) await rm(join(wardenRoot, "allowed_signers"));
    else await writeFile(join(wardenRoot, "allowed_signers"), text);
    await write(".warden/notes.txt", "two\n");
    await write(".warden/more.txt", "two\n");
    git("add", "-A");
    commitSigned("ryan", "change notes");
    const { code, out, err } = await check();
    expect(code).toBe(1);
    expect((await tampered()).filter((t) => t.detail === "no-allowed-signers")).toEqual([
      { file: ".warden/more.txt", detail: "no-allowed-signers" },
      { file: ".warden/notes.txt", detail: "no-allowed-signers" },
    ]);
    expect(`${out}${err}`.match(/Next action:/g)).toHaveLength(1);
    expect(out).toContain("Next action: reinstall Warden from a release that ships its allowed_signers file, then run warden check again.");
  });

  it("the packaged allowed-signers list is a hashed input of the lock", async () => {
    expect(readLock(root).sources.allowed_signers).toBe(sha256(signers("ryan")));
    await writeFile(join(wardenRoot, "allowed_signers"), signers("ryan", "agent"));
    expect((await check()).code).toBe(1);
    expect(await tampered()).toEqual([{ file: "allowed_signers", detail: "source-drift" }]);
  });

  it("a lowered baseline needs no signature", async () => {
    await write("a.ts", "const a = 1;\n");
    expect((await check()).code).toBe(0);
    git("commit", "-q", "-m", "fix a.ts");
    expect((await check()).code).toBe(0);
    expect(await tampered()).toEqual([]);
  });
});
