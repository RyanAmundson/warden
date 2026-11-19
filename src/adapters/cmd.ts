import { spawn } from "node:child_process";
import type { Guardrail } from "../records/types.js";
import type { Adapter, RunContext, RunResult, Violation } from "./types.js";

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

const LOCATED = /^(.+?):(\d+)(?:-(\d+))?: (.+)$/;

const NEXT = /Next action: (.+)$/;

const located = (g: Guardrail, stdout: string): Violation[] | undefined => {
  const lines = stdout.trimEnd().split("\n");
  const next = NEXT.exec(lines.at(-1) ?? "")?.[1];
  const found = lines.slice(0, -1).map((l) => LOCATED.exec(l));
  if (next === undefined || found.length === 0 || found.some((m) => m === null)) return undefined;
  return (found as RegExpExecArray[]).map(([, file, line, end, message]) => ({ guardrail: g.id, file: file as string, line: Number(line), ...(end === undefined ? {} : { endLine: Number(end) }), message: message as string, doThis: next }));
};

const runOne = async (g: Guardrail, ctx: RunContext): Promise<RunResult> => {
  const run = g.implementation.slice(g.implementation.indexOf(":") + 1);
  const command = withPackDir(run, g.packDir);
  const { code, killed, ms, output, stdout } = await spawnBudgeted(run, [], ctx.root, ctx.unbudgeted === true ? undefined : g.budgetMs, true, g.packDir === undefined ? {} : { [PACK_DIR]: g.packDir });
  if (killed) return { guardrail: g.id, status: "killed", violations: [], ms, command };
  if (code === 0) return { guardrail: g.id, status: "pass", violations: [], ms };
  const perFile = code === 1 && output === stdout ? located(g, stdout) : undefined;
  if (perFile !== undefined) return { guardrail: g.id, status: "fail", violations: perFile, ms };
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
