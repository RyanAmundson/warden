import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { cmdAdapter } from "../../src/adapters/cmd.js";
import { runGuardrails } from "../../src/runner/run.js";
import type { Guardrail } from "../../src/records/types.js";

const legacy = (implementation: string, budgetMs = 5000): Guardrail => ({
  id: "g",
  kind: "legacy",
  runs: ["edit"],
  budgetMs,
  version: 1,
  implementation,
});

const ctx = { root: process.cwd(), generatedDir: "" };

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
    const [r] = await runGuardrails([legacy("cmd:sleep 5", 200)], [], ctx);
    expect(r?.status).toBe("killed");
    expect(r?.command).toBe("sleep 5");
    expect(r?.ms).toBeLessThan(1000);
    expect(spawnSync("pgrep", ["-f", "sleep 5"]).status).toBe(1);
  });

  it("a process group that is already gone at the budget is still reported as killed", async () => {
    const orphan = `node -e "require('child_process').spawn('sleep', ['1'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref()"`;
    const [r] = await runGuardrails([legacy(`cmd:${orphan}`, 300)], [], ctx);
    expect(r?.status).toBe("killed");
  });

  it("a failure carries the last 20 lines of stdout and stderr", async () => {
    const [r] = await cmdAdapter.run([legacy("cmd:for i in $(seq 1 30); do echo out$i; done; echo err >&2; exit 3")], [], ctx);
    const lines = r?.violations[0]?.message.split("\n") ?? [];
    expect(lines[0]).toBe("for i in $(seq 1 30); do echo out$i; done; echo err >&2; exit 3 exited with 3");
    expect(lines.slice(1)).toEqual([...Array.from({ length: 19 }, (_, i) => `out${i + 12}`), "err"]);
  });

  it("emits nothing", () => {
    expect(cmdAdapter.emit([legacy("cmd:true")], { root: "", packs: [], config: {} as never })).toEqual({});
  });
});
