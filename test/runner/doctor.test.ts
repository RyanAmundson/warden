import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordSet } from "../../src/records/types.js";
import { doctor } from "../../src/runner/doctor.js";
import { skillPath } from "../../src/compiler/skills.js";

const missing = vi.hoisted((): { name: string | undefined } => ({ name: undefined }));

vi.mock("node:module", async (original) => {
  const actual = await original<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: (from: string | URL) => {
      const real = actual.createRequire(from);
      return Object.assign((id: string) => real(id), {
        resolve: (id: string) => {
          if (id === missing.name) throw new Error(`Cannot find module '${id}'`);
          return real.resolve(id);
        },
      });
    },
  };
});

let root: string;

const setWith = (...commands: string[]): RecordSet => setIn(undefined, ...commands);

const setIn = (packDir: string | undefined, ...commands: string[]): RecordSet => ({
  root,
  config: { project: "p", base: "main", packs: [], tierBudgetMs: { edit: 1000, commit: 1000, boundary: 1000 }, loopBreakerRepeats: 3 },
  packs: [
    {
      id: "local",
      file: join(root, "packs/local/pack.yaml"),
      layer: 1,
      terms: [],
      capabilities: [],
      practices: [
        {
          id: "scripts-pass",
          pack: "local",
          statement: "The scripts pass.",
          terms: [],
          paths: [],
          conflictsWith: [],
          guardrails: commands.map((command, i) => ({ id: `script-${i}`, kind: "legacy", runs: ["commit"], budgetMs: 1000, version: 1, implementation: `cmd:${command}`, packDir })),
        },
      ],
    },
  ],
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-doctor-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("doctor", () => {
  it("passes with one line per bundled tool and per cmd Guardrail", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { "test:changed": "true", test: "true" } }));
    const result = await doctor(setWith("npm run test:changed", "npm test", "test ! -e broken"));
    expect(result.next).toBeUndefined();
    expect(result.lines).toEqual([
      "ok    tool eslint",
      "ok    tool typescript-eslint",
      "ok    tool typescript",
      "ok    tool warden eslint plugin",
      "ok    cmd script-0: npm run test:changed",
      "ok    cmd script-1: npm test",
      "ok    cmd script-2: test ! -e broken  (shell)",
    ]);
  });

  it("names a missing npm script and says to add it, once, for the first failure", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {} }));
    const result = await doctor(setWith("npm run test:changed", "npm test"));
    expect(result.lines.filter((l) => l.startsWith("FAIL"))).toEqual([
      'FAIL  cmd script-0: npm run test:changed  package.json has no "test:changed" script',
      'FAIL  cmd script-1: npm test  package.json has no "test" script',
    ]);
    expect(result.next).toBe('add a "test:changed" script to package.json, then run warden doctor');
  });

  it("treats a project without package.json as having no scripts", async () => {
    expect((await doctor(setWith("npm test"))).next).toBe('add a "test" script to package.json, then run warden doctor');
  });

  it("fails a command whose first word is not on PATH, and finds one that is", async () => {
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "mytool"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "mytool"), 0o755);
    vi.stubEnv("PATH", bin);
    const result = await doctor(setWith("mytool --all", "othertool"));
    expect(result.lines.slice(4)).toEqual(["ok    cmd script-0: mytool --all", "FAIL  cmd script-1: othertool  othertool is not on PATH"]);
    expect(result.next).toBe("install othertool so it is on PATH, then run warden doctor");
  });

  it("cuts a long command to 200 characters on its line", async () => {
    const long = `echo ${"x".repeat(300)}`;
    const result = await doctor(setWith(long));
    expect(result.lines.slice(4)).toEqual([`ok    cmd script-0: ${long.slice(0, 200)} …  (shell)`]);
  });

  it("skips leading assignments and treats builtins, keywords, and compound commands as the shell's", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {} }));
    const result = await doctor(setWith("FOO=1 test ! -e broken", "cd src && true", "( true )", "if true; then true; fi", "FOO=1 BAR=2 npm run lint"));
    expect(result.lines.slice(4)).toEqual([
      "ok    cmd script-0: FOO=1 test ! -e broken  (shell)",
      "ok    cmd script-1: cd src && true  (shell)",
      "ok    cmd script-2: ( true )  (shell)",
      "ok    cmd script-3: if true; then true; fi  (shell)",
      'FAIL  cmd script-4: FOO=1 BAR=2 npm run lint  package.json has no "lint" script',
    ]);
    expect(result.next).toBe('add a "lint" script to package.json, then run warden doctor');
  });

  it("reports a bundled tool that does not resolve, with its next action", async () => {
    missing.name = "typescript";
    try {
      const result = await doctor(setWith());
      expect(result.lines[2]).toMatch(/^FAIL {2}tool typescript {2}/);
      expect(result.next).toBe("reinstall Warden so its bundled typescript loads, then run warden doctor");
    } finally {
      missing.name = undefined;
    }
  });

  it("resolves WARDEN_PACK_DIR to the Guardrail's pack folder and names a pack script that is missing", async () => {
    const pack = join(root, "pack");
    await mkdir(join(pack, "bin"), { recursive: true });
    await writeFile(join(pack, "bin/ok.mjs"), "");
    await writeFile(join(pack, "bin/run.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(pack, "bin/run.sh"), 0o755);
    const result = await doctor(setIn(pack, 'node "$WARDEN_PACK_DIR/bin/ok.mjs"', '"${WARDEN_PACK_DIR}/bin/run.sh"', "node $WARDEN_PACK_DIR/bin/gone.mjs"));
    expect(result.lines.slice(4)).toEqual([
      'ok    cmd script-0: node "$WARDEN_PACK_DIR/bin/ok.mjs"',
      'ok    cmd script-1: "${WARDEN_PACK_DIR}/bin/run.sh"',
      `FAIL  cmd script-2: node $WARDEN_PACK_DIR/bin/gone.mjs  ${pack}/bin/gone.mjs does not exist in the pack`,
    ]);
    expect(result.next).toBe(`create ${pack}/bin/gone.mjs, then run warden doctor`);
  });

  it("finds a pack file named inside an option or before shell punctuation", async () => {
    const pack = join(root, "pack");
    await mkdir(join(pack, "bin"), { recursive: true });
    await writeFile(join(pack, "bin/ok.mjs"), "");
    const result = await doctor(setIn(pack, "node --import=$WARDEN_PACK_DIR/bin/ok.mjs -e 0", 'node "$WARDEN_PACK_DIR/bin/ok.mjs"; true'));
    expect(result.lines.slice(4)).toEqual(["ok    cmd script-0: node --import=$WARDEN_PACK_DIR/bin/ok.mjs -e 0", 'ok    cmd script-1: node "$WARDEN_PACK_DIR/bin/ok.mjs"; true']);
  });

  it("finds a pack file when the quote closes before the rest of the path", async () => {
    const pack = join(root, "pack");
    await mkdir(join(pack, "bin"), { recursive: true });
    await writeFile(join(pack, "bin/ok.mjs"), "");
    const result = await doctor(setIn(pack, 'node "$WARDEN_PACK_DIR"/bin/ok.mjs'));
    expect(result.lines.slice(4)).toEqual(['ok    cmd script-0: node "$WARDEN_PACK_DIR"/bin/ok.mjs']);
  });

  it("resolves a command given as a path from the project root", async () => {
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts/check.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(root, "scripts/check.sh"), 0o755);
    const result = await doctor(setWith("./scripts/check.sh", "./scripts/missing.sh"));
    expect(result.lines.slice(4)).toEqual(["ok    cmd script-0: ./scripts/check.sh", "FAIL  cmd script-1: ./scripts/missing.sh  ./scripts/missing.sh is not an executable file in the project"]);
    expect(result.next).toBe("create ./scripts/missing.sh as an executable file, then run warden doctor");
  });

  it.each([
    ["claude", ".claude/skills", "Claude Code", "warden doctor"],
    ["codex", ".agents/skills", "Codex", "warden doctor --harness codex"],
  ] as const)("checks the %s skill link and prints a working repair", async (harness, skillsDir, harnessName, retry) => {
    const set = setWith();
    (set.packs[0] as RecordSet["packs"][number]).capabilities = [
      { id: "review-gate", kind: "skill", serves: "review", purpose: "p", when: "w", upholds: [], commands: [], replaces: [], pack: "local" },
      { id: "where", kind: "tool", serves: "lookup", purpose: "p", when: "w", upholds: [], commands: [], replaces: [], pack: "local" },
    ];
    await mkdir(join(root, skillPath("review-gate"), ".."), { recursive: true });
    await writeFile(join(root, skillPath("review-gate")), "---\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "core.hooksPath", ".warden/generated/hooks"], { cwd: root });
    await mkdir(join(root, ".warden/generated/hooks"), { recursive: true });
    await writeFile(join(root, ".warden/generated/hooks/pre-commit"), "", { mode: 0o755 });
    const skillLines = (lines: string[]) => lines.filter((line) => line.includes("skill review-gate"));
    const automatic = await doctor(set);
    expect(automatic.next).toBeUndefined();
    expect(skillLines(automatic.lines)).toEqual([]);
    const before = await doctor(set, true, harness);
    expect(skillLines(before.lines)).toEqual([`FAIL  skill review-gate  ${skillsDir}/review-gate does not link to .warden/generated/skills/review-gate, so ${harnessName} cannot load the skill`]);
    const nested = join(root, "nested folder");
    await mkdir(nested);
    const linkCommand = `mkdir -p ${skillsDir} && ln -s ../../.warden/generated/skills/review-gate ${skillsDir}/review-gate`;
    const command = `(cd "$(git rev-parse --show-toplevel)" && ${linkCommand})`;
    expect(before.next).toBe(`run ${command}, then run ${retry}`);
    execFileSync("sh", ["-c", command], { cwd: nested });
    const after = await doctor(set, true, harness);
    expect(after.next).toBeUndefined();
    expect(skillLines(after.lines)).toEqual(["ok    skill review-gate"]);
    const link = join(root, skillsDir, "review-gate");
    await unlink(link);
    await symlink("missing", link);
    const stale = await doctor(set, true, harness);
    expect(skillLines(stale.lines)).toEqual([expect.stringMatching(/^FAIL  skill review-gate  /)]);
    const repair = `(cd "$(git rev-parse --show-toplevel)" && unlink ${skillsDir}/review-gate && ${linkCommand})`;
    expect(stale.next).toBe(`run ${repair}, then run ${retry}`);
    execFileSync("sh", ["-c", repair], { cwd: nested });
    expect((await doctor(set, true, harness)).next).toBeUndefined();
  });

  it("explicit doctor detects a stale installed Claude plugin and accepts its updated version", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "core.hooksPath", ".warden/generated/hooks"], { cwd: root });
    await mkdir(join(root, ".warden/generated/hooks"), { recursive: true });
    await writeFile(join(root, ".warden/generated/hooks/pre-commit"), "", { mode: 0o755 });
    const config = join(root, "claude-config");
    const bin = join(root, "bin");
    await mkdir(config);
    await mkdir(bin);
    await writeFile(join(config, "settings.json"), '{"enabledPlugins":{"warden@warden":true}}');
    await writeFile(join(bin, "claude"), `#!/bin/sh
case "$*" in
  'plugin list --json') cat "$CLAUDE_CONFIG_DIR/plugins.json" ;;
  'plugin marketplace update warden'|'plugin marketplace add RyanAmundson/warden') exit 0 ;;
  'plugin update warden@warden --scope user'|'plugin install warden@warden --scope project') cp "$CLAUDE_CONFIG_DIR/current.json" "$CLAUDE_CONFIG_DIR/plugins.json" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
    vi.stubEnv("CLAUDE_CONFIG_DIR", config);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const inventory = (version: string) => JSON.stringify([{ id: "warden@warden", version, scope: "user", enabled: true }]);
    await writeFile(join(config, "plugins.json"), inventory("0.0.1"));
    const current = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    await writeFile(join(config, "current.json"), inventory(current.version));
    const automatic = await doctor(setWith());
    expect(automatic.next).toBeUndefined();
    const stale = await doctor(setWith(), true);
    expect(stale.lines).toContain(`FAIL  Claude plugin warden@warden  installed version 0.0.1 is older than Warden CLI ${current.version}`);
    const action = "run claude plugin marketplace update warden, then claude plugin update warden@warden --scope user, and restart Claude Code, then run warden doctor";
    expect(stale.next).toBe(action);
    const [, marketplace, update] = /^run (.*), then (.*), and restart Claude Code/.exec(stale.next!) ?? [];
    execFileSync("sh", ["-c", `${marketplace} && ${update}`], { cwd: root });
    const updated = await doctor(setWith(), true);
    expect(updated.lines).toContain(`ok    Claude plugin warden@warden ${current.version}`);
    expect(updated.next).toBeUndefined();

    await mkdir(join(root, ".claude"));
    await writeFile(join(root, ".claude/settings.json"), '{"enabledPlugins":{"warden@warden":true}}');
    await writeFile(join(config, "plugins.json"), "[]");
    await writeFile(join(config, "current.json"), JSON.stringify([{ id: "warden@warden", version: current.version, scope: "project", enabled: true, projectPath: root }]));
    const absent = await doctor(setWith(), true);
    const expected = "run claude plugin marketplace add RyanAmundson/warden, then claude plugin install warden@warden --scope project, then run warden doctor";
    expect(absent.next).toBe(expected);
    const [, add, install] = /^run (.*), then (.*), then run warden doctor$/.exec(absent.next!) ?? [];
    execFileSync("sh", ["-c", `${add} && ${install}`], { cwd: root });
    expect((await doctor(setWith(), true)).next).toBeUndefined();
  });

});
