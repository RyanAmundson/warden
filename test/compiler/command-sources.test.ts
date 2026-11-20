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
    expect(commandSources(root, "node scripts/verify", [])).toEqual({
      "./scripts/verify": exact,
      "./scripts/exact-message.cjs": exactDependency,
    });
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
        implementation: "cmd:${program}"
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
