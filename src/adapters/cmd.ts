import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { RecordError, findWardenRoot } from "../records/load.js";
import type { Guardrail } from "../records/types.js";
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

export const spawnBudgeted = (file: string, args: string[], cwd: string, budgetMs: number | undefined, shell = false, env: Record<string, string> = {}, signal?: AbortSignal): Promise<Spawned> =>
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

export const runInProcess = (words: string[], cwd: string, budgetMs: number | undefined, signal?: AbortSignal, env: Record<string, string> = {}): Promise<Pick<Spawned, "output" | "code" | "killed" | "ms">> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const start = performance.now();
    const [script, ...argv] = words as [string, ...string[]];
    const w = new Worker(BOOT, { eval: true, argv, env: { ...process.env, ...env }, stdout: true, stderr: true, workerData: { script, cwd } });
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

const PACK_SCRIPT = /^node "\$WARDEN_PACK_DIR\/([\w.-]+)"((?: [\w./=:@%+,-]+)*)$/;

export const bundledScript = (command: string, packDir: string | undefined): string[] | undefined => {
  const m = PACK_SCRIPT.exec(command);
  if (m === null || packDir === undefined || dirname(packDir) !== join(findWardenRoot(), "packs")) return undefined;
  return [join(packDir, m[1] as string), ...(m[2] as string).split(" ").slice(1)];
};

export const OUTPUT_LINES = 20;

export const PACK_DIR = "WARDEN_PACK_DIR";

export const PACK_VAR = /\$(?:\{WARDEN_PACK_DIR\}|WARDEN_PACK_DIR(?![A-Za-z0-9_]))/g;

const shellWord = (path: string): string => (/^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`);

export const withPackDir = (command: string, packDir: string | undefined): string => {
  if (packDir === undefined) return command;
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < command.length; ) {
    const rest = command.slice(i);
    const found = quote === "'" ? null : new RegExp(`^${PACK_VAR.source}`).exec(rest);
    if (found !== null) {
      out += quote === '"' ? packDir.replace(/["\\$`]/g, "\\$&") : shellWord(packDir);
      i += found[0].length;
      continue;
    }
    const c = command[i] as string;
    if (c === "\\" && quote !== "'") {
      out += rest.slice(0, 2);
      i += 2;
      continue;
    }
    if ((c === '"' || c === "'") && (quote === undefined || quote === c)) quote = quote === undefined ? c : undefined;
    out += c;
    i += 1;
  }
  return out;
};

const tail = (output: string): string[] => output.trimEnd().split("\n").filter((l) => l !== "").slice(-OUTPUT_LINES);

const runOne = async (g: Guardrail, ctx: RunContext): Promise<RunResult> => {
  const run = g.implementation.slice(g.implementation.indexOf(":") + 1);
  const command = withPackDir(run, g.packDir);
  const budgetMs = ctx.unbudgeted === true ? undefined : g.budgetMs;
  const env: Record<string, string> = g.packDir === undefined ? {} : { [PACK_DIR]: g.packDir };
  const words = bundledScript(run, g.packDir);
  const { code, killed, ms, output } = await (words === undefined ? spawnBudgeted(run, [], ctx.root, budgetMs, true, env, ctx.signal) : runInProcess(words, ctx.root, budgetMs, ctx.signal, env));
  if (killed) return { guardrail: g.id, status: "killed", violations: [], ms, command };
  if (code === 0) return { guardrail: g.id, status: "pass", violations: [], ms };
  if (code === 2) {
    const last = tail(output).at(-1) ?? "";
    const said = last.includes("Next action:") ? last : `${last === "" ? "it printed nothing" : last}. Next action: run \`${command}\` and fix what it reports.`;
    throw new RecordError(g.packDir === undefined ? "" : join(g.packDir, "pack.yaml"), `/guardrails/${g.id}/implementation`, `${command} exited with 2, an error in its environment or usage, not a violation: ${said}`);
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
