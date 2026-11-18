import { spawn } from "node:child_process";
import type { Guardrail } from "../records/types.js";
import type { Adapter, RunContext, RunResult } from "./types.js";

const runOne = (g: Guardrail, ctx: RunContext): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const command = g.implementation.slice(g.implementation.indexOf(":") + 1);
    const start = performance.now();
    const child = spawn(command, { shell: true, cwd: ctx.root, detached: true, stdio: "ignore" });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      process.kill(-(child.pid as number), "SIGKILL");
    }, g.budgetMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const ms = performance.now() - start;
      if (killed) return resolve({ guardrail: g.id, status: "over-budget", violations: [], ms });
      if (code === 0) return resolve({ guardrail: g.id, status: "pass", violations: [], ms });
      resolve({
        guardrail: g.id,
        status: "fail",
        violations: [{ guardrail: g.id, file: "", line: 0, message: `${command} exited with ${code}` }],
        ms,
      });
    });
  });

export const cmdAdapter: Adapter = {
  id: "cmd",
  emit: () => ({}),
  run: (gs, _files, ctx) => Promise.all(gs.map((g) => runOne(g, ctx))),
};
