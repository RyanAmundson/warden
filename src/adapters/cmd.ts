import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { Guardrail, RecordSet } from "../records/types.js";
import type { Adapter, RunContext, RunResult } from "./types.js";

export interface Spawned {
  stdout: string;
  stderr: string;
  output: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  ms: number;
}

const killGroup = (pid: number): void => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
  }
};

export const spawnBudgeted = (file: string, args: string[], cwd: string, budgetMs: number | undefined, shell = false, signal?: AbortSignal): Promise<Spawned> =>
  new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(file, args, { cwd, shell, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let output = "";
    let killed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      output += chunk.toString();
    });
    const timer =
      budgetMs === undefined
        ? undefined
        : setTimeout(() => {
            killed = true;
            killGroup(child.pid as number);
          }, budgetMs);
    const abort = (): void => killGroup(child.pid as number);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(err);
    });
    child.on("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ stdout, stderr, output, code, signal: exitSignal, killed, ms: performance.now() - start });
    });
  });

export const OUTPUT_LINES = 20;

const tail = (output: string): string[] => output.trimEnd().split("\n").filter((l) => l !== "").slice(-OUTPUT_LINES);

export const PACK_TOKEN = "{pack}";

export const packDirs = (set: RecordSet): Map<string, string> =>
  new Map(set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.map((g): [string, string] => [g.id, dirname(p.file)]))));

const shellWord = (path: string): string => (/^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`);

export const commandOf = (g: Guardrail, packDir: string | undefined): string => {
  const command = g.implementation.slice(g.implementation.indexOf(":") + 1);
  if (!command.includes(PACK_TOKEN)) return command;
  if (packDir === undefined) throw new Error(`Guardrail ${g.id} names ${PACK_TOKEN} but was run without its pack directory`);
  return command.replaceAll(PACK_TOKEN, shellWord(packDir));
};

const runOne = async (g: Guardrail, ctx: RunContext): Promise<RunResult> => {
  const command = commandOf(g, ctx.packDirs?.get(g.id));
  const { code, killed, ms, output } = await spawnBudgeted(command, [], ctx.root, ctx.unbudgeted === true ? undefined : g.budgetMs, true, ctx.signal);
  if (killed) return { guardrail: g.id, status: "killed", violations: [], ms, command };
  if (code === 0) return { guardrail: g.id, status: "pass", violations: [], ms };
  return {
    guardrail: g.id,
    status: "fail",
    violations: [{ guardrail: g.id, file: "", line: 0, message: [`${command} exited with ${code}`, ...tail(output)].join("\n") }],
    ms,
  };
};

export const cmdAdapter: Adapter = {
  id: "cmd",
  emit: () => ({}),
  run: (gs, _files, ctx) => Promise.all(gs.map((g) => runOne(g, ctx))),
};
