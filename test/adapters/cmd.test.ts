import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cmdAdapter } from "../../src/adapters/cmd.js";
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

  it("prints the command with its pack folder shell-quoted, so a folder with a space runs as printed", async () => {
    const pack = await mkdtemp(join(tmpdir(), "warden pack's "));
    await writeFile(join(pack, "x.sh"), "echo ran\nexit 1\n");
    const commands = ["sh $WARDEN_PACK_DIR/x.sh", 'sh "$WARDEN_PACK_DIR/x.sh"', 'sh "${WARDEN_PACK_DIR}"/x.sh'];
    const results = await cmdAdapter.run(commands.map((c) => ({ ...legacy(`cmd:${c}`), packDir: pack })), [], ctx);
    const printed = results.map((r) => (r.violations[0]?.message.split("\n")[0] ?? "").replace(/ exited with \d+$/, ""));
    expect(printed[0]).toBe(`sh '${pack.replaceAll("'", "'\\''")}'/x.sh`);
    for (const command of printed) expect(spawnSync("sh", ["-c", command], { encoding: "utf8" })).toMatchObject({ status: 1, stdout: "ran\n" });
    await rm(pack, { recursive: true });
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
