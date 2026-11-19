import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledScript, cmdAdapter, runInProcess, runIt } from "../../src/adapters/cmd.js";
import { findWardenRoot } from "../../src/records/load.js";
import { runGuardrails } from "../../src/runner/run.js";
import type { Guardrail, RecordSet } from "../../src/records/types.js";
import { conformance } from "./conformance.js";

const legacy = (implementation: string, budgetMs = 5000): Guardrail => ({
  id: "g",
  kind: "legacy",
  runs: ["edit"],
  budgetMs,
  version: 1,
  implementation,
});

const ctx = { root: process.cwd(), generatedDir: "" };

const fixtures = resolve(import.meta.dirname, "../fixtures/adapters");

const emptySet: RecordSet = { root: "", packs: [], config: {} as never };

const setOf = (g: Guardrail): RecordSet => ({
  ...emptySet,
  packs: [{ id: "p", file: "pack.yaml", layer: 0, terms: [], practices: [{ id: "x", pack: "p", statement: "s", terms: [], paths: [], conflictsWith: [], guardrails: [g] }] }],
});

describe("cmd adapter", () => {
  it("cmd pass", async () => {
    const [r] = await cmdAdapter.run([legacy("cmd:true")], [], ctx);
    expect(r?.status).toBe("pass");
    expect(r?.violations).toEqual([]);
  });

  it("cmd fail", async () => {
    const [r] = await cmdAdapter.run([legacy("cmd:false")], [], ctx);
    expect(r?.status).toBe("fail");
    expect(r?.violations).toHaveLength(1);
    expect(r?.violations[0]?.file).toBe("");
  });

  it("a long or multi-line command shows only its first line, cut short, before the output", async () => {
    const script = `node -e '\nconsole.log("${"x".repeat(150)}");\nprocess.exit(3)\n'`;
    const [r] = await cmdAdapter.run([legacy(`cmd:${script}`)], [], ctx);
    const [first, ...rest] = (r?.violations[0]?.message ?? "").split("\n");
    expect(first).toBe("node -e ' … exited with 3");
    expect(rest).toEqual(["x".repeat(150)]);
    const [long] = await cmdAdapter.run([legacy(`cmd:test -z ${"y".repeat(220)}`)], [], ctx);
    expect(long?.violations[0]?.message).toBe(`test -z ${"y".repeat(192)} … exited with 1`);
  });

  it("cmd killed at its budget names the command", async () => {
    const killed = legacy("cmd:sleep 4.731", 200);
    const [r] = await runGuardrails(setOf(killed), [killed], [], ctx);
    expect(r?.status).toBe("killed");
    expect(r?.command).toBe("sleep 4.731");
    expect(r?.ms).toBeLessThan(1000);
    expect(spawnSync("pgrep", ["-f", "sleep 4.731"]).status).toBe(1);
  });

  it("a process group that is already gone at the budget is still reported as killed", async () => {
    const orphan = `node -e "require('child_process').spawn('sleep', ['1'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref()"`;
    const gone = legacy(`cmd:${orphan}`, 300);
    const [r] = await runGuardrails(setOf(gone), [gone], [], ctx);
    expect(r?.status).toBe("killed");
  });

  it("a failure carries the last 20 lines of stdout and stderr", async () => {
    const [r] = await cmdAdapter.run([legacy("cmd:for i in $(seq 1 30); do echo out$i; done; echo err >&2; exit 3")], [], ctx);
    const lines = r?.violations[0]?.message.split("\n") ?? [];
    expect(lines[0]).toBe("for i in $(seq 1 30); do echo out$i; done; echo err >&2; exit 3 exited with 3");
    expect(lines.slice(1)).toEqual([...Array.from({ length: 19 }, (_, i) => `out${i + 12}`), "err"]);
  });

  it("runs a Guardrail with WARDEN_PACK_DIR set to its pack's folder", async () => {
    const [r] = await cmdAdapter.run([{ ...legacy('cmd:test "$WARDEN_PACK_DIR" = /packs/p'), packDir: "/packs/p" }], [], ctx);
    expect(r?.status).toBe("pass");
  });

  it("prints the command after an export of its shell-quoted pack folder, so every quoting runs as printed", async () => {
    const pack = await mkdtemp(join(tmpdir(), "warden pack's $(x) "));
    await writeFile(join(pack, "x.sh"), "echo ran\nexit 1\n");
    const commands = ["sh $WARDEN_PACK_DIR/x.sh", 'sh "$WARDEN_PACK_DIR/x.sh"', 'sh "${WARDEN_PACK_DIR}"/x.sh', "sh -c 'sh \"$WARDEN_PACK_DIR/x.sh\"'", 'sh "$(echo "$WARDEN_PACK_DIR")/x.sh"'];
    const results = await cmdAdapter.run(commands.map((c) => ({ ...legacy(`cmd:${c}`), packDir: pack })), [], ctx);
    const printed = results.map((r) => (r.violations[0]?.message.split("\n")[0] ?? "").replace(/ exited with \d+$/, ""));
    expect(printed).toEqual(commands.map((c) => `export WARDEN_PACK_DIR='${pack.replaceAll("'", "'\\''")}'; ${c}`));
    const codes = results.map((r) => Number(/ exited with (\d+)$/.exec(r.violations[0]?.message.split("\n")[0] ?? "")?.[1]));
    expect(codes).toEqual([127, 1, 1, 1, 1]);
    printed.forEach((command, i) => expect(spawnSync("sh", ["-c", command], { encoding: "utf8" }).status).toBe(codes[i]));
    await rm(pack, { recursive: true });
  });

  it("runs a node script inside Warden's process, in the project root, with its arguments, output, exit code, and pack folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warden-it's here-"));
    try {
      await writeFile(join(dir, "s.cjs"), 'console.log(process.pid, process.cwd(), process.argv.slice(2).join(","), process.env.WARDEN_PACK_DIR);\nconsole.error("to stderr");\nprocess.exit(3);\n');
      const r = await runInProcess([join(dir, "s.cjs"), "a", "b"], dir, undefined, undefined, { WARDEN_PACK_DIR: "/p" });
      expect(r).toMatchObject({ code: 3, killed: false, output: `${process.pid} ${dir} a,b /p\nto stderr\n` });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops a node script at its budget and when the run is aborted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warden-node-"));
    try {
      await writeFile(join(dir, "spin.cjs"), "setInterval(() => {}, 1000);\n");
      const r = await runInProcess([join(dir, "spin.cjs")], dir, 200);
      expect(r.killed).toBe(true);
      expect(r.ms).toBeLessThan(1000);
      const controller = new AbortController();
      const run = runInProcess([join(dir, "spin.cjs")], dir, undefined, controller.signal);
      controller.abort();
      await expect(run).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs in a worker only a script in a pack Warden ships, named through WARDEN_PACK_DIR with plain arguments", async () => {
    const shipped = join(findWardenRoot(), "packs", "collection-folders");
    expect(bundledScript('node "$WARDEN_PACK_DIR/a.cjs" x --y=1', shipped)).toEqual([join(shipped, "a.cjs"), "x", "--y=1"]);
    expect(bundledScript('node "$WARDEN_PACK_DIR/a.cjs"', "/project/.warden/packs/local")).toBeUndefined();
    expect(bundledScript('node "$WARDEN_PACK_DIR/a.cjs"', undefined)).toBeUndefined();
    expect(bundledScript('node "$WARDEN_PACK_DIR/a.cjs"; rm -rf b', shipped)).toBeUndefined();
    expect(bundledScript('node "$WARDEN_PACK_DIR/a.cjs"  b', shipped)).toBeUndefined();
    expect(bundledScript("node -e 1", shipped)).toBeUndefined();
  });

  it("runs a local pack's script as node would, so a require.main guard still runs its check", async () => {
    const pack = await mkdtemp(join(tmpdir(), "warden-local-pack-"));
    try {
      await writeFile(join(pack, "main.cjs"), "if (require.main === module) process.exit(1);\n");
      const [r] = await cmdAdapter.run([{ ...legacy('cmd:node "$WARDEN_PACK_DIR/main.cjs"'), packDir: pack }], [], ctx);
      expect(r?.status).toBe("fail");
    } finally {
      await rm(pack, { recursive: true, force: true });
    }
  });

  it("names a short command in its next action, and points a cut-off command at its pack.yaml", () => {
    expect(runIt(legacy("cmd:npm test"))).toBe("run `npm test` and fix what it reports.");
    const long = { ...legacy(`cmd:echo ${"x".repeat(300)}`), packDir: "/p/.warden/packs/local" };
    expect(runIt(long)).toBe("run the implementation command of Guardrail g in /p/.warden/packs/local/pack.yaml, from the project root with WARDEN_PACK_DIR=/p/.warden/packs/local, and fix what it reports.");
    expect(runIt({ ...long, packDir: "/p/a b" })).toContain("with WARDEN_PACK_DIR='/p/a b', and");
    expect(runIt({ ...legacy('cmd:sh "${WARDEN_PACK_DIR:-.}/x.sh"'), packDir: "/p/a b" })).toBe(`run \`export WARDEN_PACK_DIR='/p/a b'; sh "\${WARDEN_PACK_DIR:-.}/x.sh"\` and fix what it reports.`);
  });

  it("a command that exits 2 is an environment or usage error that keeps its last line's next action, or names one", async () => {
    await expect(cmdAdapter.run([legacy("cmd:echo noise; echo 'no git. Next action: install git.'; exit 2")], [], ctx)).rejects.toMatchObject({
      name: "RecordError",
      pointer: "/guardrails/g/implementation",
      message: "echo noise; echo 'no git. Next action: install git.'; exit 2 exited with 2, an error in its environment or usage, not a violation: no git. Next action: install git.",
    });
    await expect(cmdAdapter.run([legacy("cmd:exit 2")], [], ctx)).rejects.toMatchObject({
      message: "exit 2 exited with 2, an error in its environment or usage, not a violation: it printed nothing. Next action: run `exit 2` and fix what it reports.",
    });
  });

  it("emits nothing", () => {
    expect(cmdAdapter.emit([legacy("cmd:true")], emptySet)).toEqual({});
  });

  it("cmd conformance: a command that exits zero in the project has no violations", async () => {
    await conformance(cmdAdapter, resolve(fixtures, "cmd-clean"), [legacy("cmd:test ! -e broken")], emptySet, [], []);
  });

  it("cmd conformance: a command that exits non-zero is one project-wide violation", async () => {
    await conformance(cmdAdapter, resolve(fixtures, "cmd-broken"), [legacy("cmd:test ! -e broken")], emptySet, [], [
      { guardrail: "g", file: "", line: 0, message: "test ! -e broken exited with 1" },
    ]);
  });
});
