import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { commandSources } from "../../src/compiler/command-sources.js";

it("requires a resolvable program even when the command names no files", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-unresolved-command-"));
  const owner = { file: ".warden/packs/local/pack.yaml", id: "format-check" };
  try {
    expect(() => commandSources(root, "warden-fixture-format-check", [], {}, owner)).toThrow(expect.objectContaining({
      file: owner.file,
      pointer: "/guardrails/format-check/implementation",
      message: expect.stringContaining("an unrecognized program"),
    }));
    const script = "printf 'checked\\n'\n";
    await writeFile(join(root, "format-check.sh"), script);
    expect(commandSources(root, "sh format-check.sh", [], {}, owner)).toEqual({ "./format-check.sh": script });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("locks the script Node actually executes with an extensionless entry path", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-node-entry-"));
  try {
    await mkdir(join(root, "scripts"));
    const entry = 'process.stdout.write(require("./message.cjs"));\n';
    const dependency = 'module.exports = "checked\\n";\n';
    await writeFile(join(root, "scripts/verify.js"), entry);
    await writeFile(join(root, "scripts/message.cjs"), dependency);
    expect(execFileSync(process.execPath, ["scripts/verify"], { cwd: root, encoding: "utf8" })).toBe("checked\n");
    expect(commandSources(root, "node scripts/verify", [])).toEqual({
      "./scripts/verify.js": entry,
      "./scripts/message.cjs": dependency,
    });

    const exact = 'process.stdout.write(require("./exact-message.cjs"));\n';
    const exactDependency = 'module.exports = "exact\\n";\n';
    await writeFile(join(root, "scripts/verify"), exact);
    await writeFile(join(root, "scripts/exact-message.cjs"), exactDependency);
    expect(execFileSync(process.execPath, ["scripts/verify"], { cwd: root, encoding: "utf8" })).toBe("exact\n");
    const exactSources = {
      "./scripts/verify": exact,
      "./scripts/exact-message.cjs": exactDependency,
    };
    expect(commandSources(root, "node scripts/verify", [])).toEqual(exactSources);

    const prepare = 'require("./verify");\n';
    await writeFile(join(root, "scripts/prepare.cjs"), prepare);
    const combinedSources = { ...exactSources, "./scripts/prepare.cjs": prepare };
    expect(commandSources(root, "node scripts/prepare.cjs && node scripts/verify", [])).toEqual(combinedSources);
    expect(commandSources(root, "node scripts/verify && node scripts/prepare.cjs", [])).toEqual(combinedSources);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("locks the entry and imports of a tsx watch command", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-tsx-watch-"));
  try {
    const entry = 'import "./message.js";\n';
    const dependency = 'export const message = "checked";\n';
    await writeFile(join(root, "verify.ts"), entry);
    await writeFile(join(root, "message.ts"), dependency);
    const sources = { "./verify.ts": entry, "./message.ts": dependency };
    expect(commandSources(root, "tsx watch ./verify.ts", [])).toEqual(sources);
    expect(commandSources(root, 'npx tsx watch --clear-screen=false --include "data/**/*.json" --exclude=./output.ts ./verify.ts --verbose', [])).toEqual(sources);
    expect(() => commandSources(root, "tsx watch --exclude ./output.ts", [])).toThrow("which names no script to watch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("locks modules used by inline Node eval and print commands from their working directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-node-eval-"));
  try {
    const cwd = join(root, "scripts");
    await mkdir(cwd);
    const entry = 'module.exports = require("./message.cjs");\n';
    const message = 'module.exports = "checked";\n';
    await writeFile(join(cwd, "verify.cjs"), entry);
    await writeFile(join(cwd, "message.cjs"), message);
    const sources = { "./scripts/verify.cjs": entry, "./scripts/message.cjs": message };
    const program = 'require("./verify.cjs")';
    for (const [invocation, args] of [
      [`node -e 'console.log(${program})'`, ["-e", `console.log(${program})`]],
      [`node --eval='console.log(${program})'`, [`--eval=console.log(${program})`]],
      [`node --print '${program}'`, ["--print", program]],
      [`node -pe '${program}'`, ["-pe", program]],
      [`node -p --eval='${program}'`, ["-p", `--eval=${program}`]],
    ] as const) {
      expect(execFileSync(process.execPath, args, { cwd, encoding: "utf8" })).toBe("checked\n");
      expect(commandSources(root, `cd scripts && ${invocation}`, []), invocation).toEqual(sources);
    }
    const esm = 'import result from "./verify.cjs"; console.log(result)';
    expect(execFileSync(process.execPath, ["--input-type=module", "-e", esm], { cwd, encoding: "utf8" })).toBe("checked\n");
    expect(commandSources(root, `cd scripts && node --input-type=module -e '${esm}'`, [])).toEqual(sources);
    const preload = 'process.stdout.write("preloaded\\n");\n';
    await writeFile(join(cwd, "preload.cjs"), preload);
    expect(execFileSync(process.execPath, ["-pe", program, "-r", "./preload.cjs"], { cwd, encoding: "utf8" })).toBe("preloaded\nchecked\n");
    expect(commandSources(root, `cd scripts && node -pe '${program}' -r ./preload.cjs`, [])).toEqual({
      ...sources,
      "./scripts/preload.cjs": preload,
    });
    const finalProgram = 'console.log(require("./message.cjs"))';
    for (const [options, args, expected] of [
      ["", [], { "./scripts/message.cjs": message }],
      ["--title fixture", ["--title", "fixture"], { "./scripts/message.cjs": message }],
      ["--no-warnings", ["--no-warnings"], { "./scripts/message.cjs": message }],
      ["--", ["--"], sources],
      ["positional-arg", ["positional-arg"], sources],
    ] as const) {
      const firstProgram = `console.log("first", ${program})`;
      expect(execFileSync(process.execPath, ["-e", firstProgram, ...args, "-e", finalProgram], { cwd, encoding: "utf8" })).toBe(expected === sources ? "first checked\n" : "checked\n");
      expect(commandSources(root, `cd scripts && node -e '${firstProgram}' ${options} -e '${finalProgram}'`, []), options).toEqual(expected);
    }
    expect(() => commandSources(root, `cd scripts && node -e '${program}' --debug-port 9229 -e '${finalProgram}'`, []))
      .toThrow("with the node option --debug-port");
    expect(commandSources(root, "node --print", [])).toEqual({});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("locks root package scripts and their sources when run through pnpm or Yarn", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-package-command-"));
  try {
    const scripts = {
      preverify: "sh prepare.sh",
      verify: "node verify.js",
      postverify: "sh clean.sh",
      "test:unit.v2": "node verify.js",
    };
    const prepare = "printf 'pre\\n'\n";
    const clean = "printf 'post\\n'\n";
    const verify = 'require("./message.cjs");\n';
    const message = 'process.stdout.write("checked\\n");\n';
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts }));
    await writeFile(join(root, "prepare.sh"), prepare);
    await writeFile(join(root, "clean.sh"), clean);
    await writeFile(join(root, "verify.js"), verify);
    await writeFile(join(root, "message.cjs"), message);
    const expected = {
      "./package.json#scripts/preverify": scripts.preverify,
      "./prepare.sh": prepare,
      "./package.json#scripts/verify": scripts.verify,
      "./verify.js": verify,
      "./message.cjs": message,
      "./package.json#scripts/postverify": scripts.postverify,
      "./clean.sh": clean,
    };
    for (const command of ["pnpm run verify", "pnpm run-script verify", "yarn run verify"]) {
      expect(commandSources(root, command, []), command).toEqual(expected);
    }
    expect(commandSources(root, "yarn run test:unit.v2", [])).toEqual({
      "./package.json#scripts/test:unit.v2": scripts["test:unit.v2"],
      "./verify.js": verify,
      "./message.cjs": message,
    });
    await mkdir(join(root, "packages"));
    for (const command of ["pnpm run missing", "yarn run --top-level verify", "yarn run verify --cwd packages", "cd packages && pnpm run verify"]) {
      expect(() => commandSources(root, command, []), command).toThrow("Warden cannot resolve");
    }
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { ...scripts, preverify: "case ready in ready) printf 'ready\\n';; esac" },
    }));
    expect(() => commandSources(root, "yarn run verify", [])).toThrow("Warden cannot trace package.json script preverify");
    expect(() => commandSources(root, 'pnpm run "$SCRIPT_NAME"', [])).toThrow("must run a literal pnpm script name");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("accepts entry files from the current pack's source inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-pack-entry-"));
  const packSources = new Map([
    ["bin/verify.sh", ""], ["bin/verify.js", ""], ["bin/preload.js", ""],
    ["index.js", ""], ["checks/index.js", ""], ["formatter/package.json", '{"main":"bin/format"}'], ["formatter/bin/format.js", ""],
  ]);
  const owner = { file: ".warden/packs/local/pack.yaml", id: "format-check", packSources };
  try {
    expect(commandSources(root, 'sh "$WARDEN_PACK_DIR/bin/verify.sh"', [], {}, owner)).toEqual({});
    expect(commandSources(root, 'node -r "$WARDEN_PACK_DIR/bin/preload.js" "${WARDEN_PACK_DIR}/bin/verify"', [], {}, owner)).toEqual({});
    expect(commandSources(root, 'node "$WARDEN_PACK_DIR/checks"', [], {}, owner)).toEqual({});
    expect(commandSources(root, 'node "$WARDEN_PACK_DIR/."', [], {}, owner)).toEqual({});
    expect(commandSources(root, 'node "$WARDEN_PACK_DIR/"', [], {}, owner)).toEqual({});
    expect(commandSources(root, 'node "$WARDEN_PACK_DIR/formatter"', [], {}, owner)).toEqual({});
    const worker = { ...owner, exactNodeEntry: true };
    expect(commandSources(root, 'node "$WARDEN_PACK_DIR/bin/verify.js"', [], {}, worker)).toEqual({});
    expect(() => commandSources(root, 'node "$WARDEN_PACK_DIR/."', [], {}, worker)).toThrow("does not resolve to a file");
    expect(() => commandSources(root, 'sh "$WARDEN_PACK_DIR/bin/missing.sh"', [], {}, owner)).toThrow(expect.objectContaining({
      file: owner.file,
      pointer: "/guardrails/format-check/implementation",
      message: expect.stringContaining("does not resolve to a file in its signed pack sources"),
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("validates the program before examples and compiles the suggested shell form", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-command-compile-"));
  const cli = resolve(import.meta.dirname, "../../bin/warden.js");
  const packFile = join(root, ".warden/packs/local/pack.yaml");
  const pack = (program: string) => String.raw`id: local
layer: 1
terms: []
practices:
  - id: required-product
    statement: The project includes the product file.
    terms: []
    paths: []
    conflictsWith: []
    guardrails:
      - id: local-product
        kind: runtime
        runs: [boundary]
        budgetMs: 5000
        version: 1
        implementation: 'cmd:${program}'
        mustPass: { "check-product.sh": "test -f product.txt\n", "product.txt": "Product\n" }
        mustFail: { "check-product.sh": "test -f product.txt\n" }
`;
  const compile = () => spawnSync(process.execPath, [cli, "compile"], { cwd: root, encoding: "utf8" });
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    await mkdir(dirname(packFile), { recursive: true });
    await writeFile(join(root, ".warden/config.yaml"), `project: command-compile
base: main
packs: [{ id: local, paths: [] }]
tierBudgetMs: { edit: 5000, commit: 10000, boundary: 120000 }
loopBreakerRepeats: 3
bench: { baseFiles: 1, maxFiles: 4, minMarginalMs: 1000 }
`);
    await writeFile(packFile, pack("warden-fixture-check-product"));
    const refused = compile();
    expect(refused.status, refused.stderr + refused.stdout).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("/guardrails/local-product/implementation:");
    expect(refused.stderr).toContain("Next action: rewrite");

    await writeFile(join(root, "check-product.sh"), "test -f product.txt\n");
    await writeFile(packFile, pack("sh check-product.sh"));
    const compiled = compile();
    expect(compiled.status, compiled.stderr + compiled.stdout).toBe(0);
    const lock = JSON.parse(await readFile(join(root, ".warden/lock.json"), "utf8"));
    expect(lock.sources["./check-product.sh"]).toMatch(/^[0-9a-f]{64}$/);
    await writeFile(packFile, pack('sh "$WARDEN_PACK_DIR/bin/check-product.sh"'));
    const unpackaged = compile();
    expect(unpackaged.status, unpackaged.stderr).toBe(2);
    expect(unpackaged.stderr).toContain("does not resolve to a file in its signed pack sources");

    await mkdir(join(dirname(packFile), "bin"));
    await writeFile(join(dirname(packFile), "bin/check-product.sh"), "test -f product.txt\n");
    const packed = compile();
    expect(packed.status, packed.stderr + packed.stdout).toBe(0);
    const packedLock = JSON.parse(await readFile(join(root, ".warden/lock.json"), "utf8"));
    expect(packedLock.sources[".warden/packs/local/bin/check-product.sh"]).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
