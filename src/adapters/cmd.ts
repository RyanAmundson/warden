import { spawn } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { Worker } from "node:worker_threads";
import { RecordError } from "../records/load.js";
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

const BOOT = [
  'const { workerData } = require("node:worker_threads");',
  "process.cwd = () => workerData.cwd;",
  "process.argv[1] = workerData.script;",
  'import(require("node:url").pathToFileURL(workerData.script).href);',
].join("\n");

const SEGMENT = /'((?:[^']|'\\'')*)'|([\w./=:@%+,-]+)|( )/y;

export const nodeScript = (command: string): string[] | undefined => {
  if (!command.startsWith("node ")) return undefined;
  const words = [""];
  SEGMENT.lastIndex = 5;
  while (SEGMENT.lastIndex < command.length) {
    const m = SEGMENT.exec(command);
    if (m === null) return undefined;
    if (m[3] !== undefined) words.push("");
    else words[words.length - 1] += m[1] === undefined ? (m[2] as string) : m[1].replaceAll("'\\''", "'");
  }
  return words.every((w) => w !== "") && !(words[0] as string).startsWith("-") ? words : undefined;
};

export const runInProcess = (words: string[], cwd: string, budgetMs: number | undefined, signal?: AbortSignal): Promise<Pick<Spawned, "output" | "code" | "killed" | "ms">> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const start = performance.now();
    const [script, ...argv] = words as [string, ...string[]];
    const w = new Worker(BOOT, { eval: true, argv, stdout: true, stderr: true, workerData: { script: resolvePath(cwd, script), cwd } });
    let output = "";
    let killed = false;
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
    };
    w.stdout.on("data", collect);
    w.stderr.on("data", collect);
    w.on("error", (cause: Error) => collect(Buffer.from(`${cause.stack ?? cause.message}\n`)));
    const stop = (): void => {
      w.unref();
      void w.terminate();
    };
    const timer =
      budgetMs === undefined
        ? undefined
        : setTimeout(() => {
            killed = true;
            stop();
          }, budgetMs);
    const abort = (): void => {
      clearTimeout(timer);
      stop();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const ended = Promise.all([new Promise((r) => w.stdout.on("end", r)), new Promise((r) => w.stderr.on("end", r))]);
    w.on("exit", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void ended.then(() => resolve({ output, code, killed, ms: performance.now() - start }));
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
  const budgetMs = ctx.unbudgeted === true ? undefined : g.budgetMs;
  const words = nodeScript(command);
  const { code, killed, ms, output } = await (words === undefined ? spawnBudgeted(command, [], ctx.root, budgetMs, true, ctx.signal) : runInProcess(words, ctx.root, budgetMs, ctx.signal));
  if (killed) return { guardrail: g.id, status: "killed", violations: [], ms, command };
  if (code === 0) return { guardrail: g.id, status: "pass", violations: [], ms };
  if (code === 2) {
    const last = tail(output).at(-1) ?? "";
    const said = last.includes("Next action:") ? last : `${last === "" ? "it printed nothing" : last}. Next action: run \`${command}\` and fix what it reports.`;
    throw new RecordError("", `/guardrails/${g.id}/implementation`, `${command} exited with 2, an error in its environment or usage, not a violation: ${said}`);
  }
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
