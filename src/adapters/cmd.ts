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

export const spawnBudgeted = (file: string, args: string[], cwd: string, budgetMs: number | undefined, shell = false, env: Record<string, string> = {}): Promise<Spawned> =>
  new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(file, args, { cwd, shell, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, output, code, signal, killed, ms: performance.now() - start });
    });
  });

export const OUTPUT_LINES = 20;

export const PACK_DIR = "WARDEN_PACK_DIR";

export const withPackDir = (command: string, packDir: string | undefined): string => (packDir === undefined ? command : command.replace(/\$\{?WARDEN_PACK_DIR\}?/g, () => packDir));

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
  const run = commandOf(g, ctx.packDirs?.get(g.id));
  const command = withPackDir(run, g.packDir);
  const { code, killed, ms, output } = await spawnBudgeted(run, [], ctx.root, ctx.unbudgeted === true ? undefined : g.budgetMs, true, g.packDir === undefined ? {} : { [PACK_DIR]: g.packDir });
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
