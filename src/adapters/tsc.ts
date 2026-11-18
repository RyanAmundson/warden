import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { RecordError } from "../records/load.js";
import type { Guardrail, RecordSet } from "../records/types.js";
import type { Adapter, RunContext, RunResult, Violation } from "./types.js";

const BASELINE = "baseline-errors";
const BASELINE_ID = `tsc:${BASELINE}`;
const CONFIG_PATH = ".warden/generated/tsconfig.json";
const DIAGNOSTIC = /^(.+)\((\d+),\d+\): error TS(\d+): (.*)$/;

const FLAG_CODES: Record<string, number[]> = {
  strictNullChecks: [2531, 2532, 2533, 18047, 18048],
  noImplicitAny: [7005, 7006, 7031],
};

const flagOf = (g: Guardrail): string => g.implementation.slice(g.implementation.indexOf(":") + 1);

const emit = (gs: Guardrail[], _set: RecordSet): Record<string, string> => {
  const compilerOptions: Record<string, unknown> = { noEmit: true };
  for (const g of gs) {
    if (flagOf(g) !== BASELINE) compilerOptions[flagOf(g)] = g.options === undefined ? true : g.options;
  }
  const config = { extends: "../../tsconfig.json", compilerOptions };
  return { [CONFIG_PATH]: `${JSON.stringify(config, null, 2)}\n` };
};

const resolveTsc = (root: string): string => {
  try {
    return createRequire(join(root, "package.json")).resolve("typescript/bin/tsc");
  } catch {
    throw new RecordError("", "/guardrails", `cannot resolve typescript from project root ${root}`);
  }
};

interface Spawned {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  ms: number;
}

const spawnTsc = (tsc: string, ctx: RunContext, budgetMs: number): Promise<Spawned> =>
  new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, [tsc, "-p", join(relative(ctx.root, ctx.generatedDir), "tsconfig.json"), "--pretty", "false"], {
      cwd: ctx.root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      killed = true;
      process.kill(-(child.pid as number), "SIGKILL");
    }, budgetMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, signal, killed, ms: performance.now() - start });
    });
  });

const run = async (gs: Guardrail[], _files: string[], ctx: RunContext): Promise<RunResult[]> => {
  const tsc = resolveTsc(ctx.root);
  const budgetMs = Math.min(...gs.map((g) => g.budgetMs));
  const { stdout, stderr, code, signal, killed, ms } = await spawnTsc(tsc, ctx, budgetMs);
  if (!killed && (signal !== null || (code !== 0 && code !== 1 && code !== 2))) {
    throw new Error(`tsc ended with ${signal ?? `exit code ${code}`}: ${stderr.trim()}`);
  }
  const owners = new Map<number, string>();
  for (const g of gs) for (const code of FLAG_CODES[flagOf(g)] ?? []) owners.set(code, g.id);
  const baseline = gs.find((g) => flagOf(g) === BASELINE)?.id ?? BASELINE_ID;
  const byGuardrail = new Map<string, Violation[]>([[baseline, []], ...gs.map((g) => [g.id, []] as [string, Violation[]])]);
  if (!killed) {
    for (const line of stdout.split("\n")) {
      if (line.trim() === "" || /^\s/.test(line)) continue;
      const m = DIAGNOSTIC.exec(line);
      if (m === null) throw new Error(`tsc printed an unparsable line: ${line}`);
      const guardrail = owners.get(Number(m[3])) ?? baseline;
      (byGuardrail.get(guardrail) as Violation[]).push({
        guardrail,
        file: m[1] as string,
        line: Number(m[2]),
        message: `TS${m[3]}: ${m[4]}`,
      });
    }
  }
  const parsed = [...byGuardrail.values()].some((v) => v.length > 0);
  if (!killed && code !== 0 && !parsed) {
    throw new Error(`tsc exited with ${code} and printed no diagnostics: ${stderr.trim()}`);
  }
  return [...byGuardrail].map(([guardrail, violations]) => ({
    guardrail,
    status: killed ? "over-budget" : violations.length > 0 ? "fail" : "pass",
    violations,
    ms,
  }));
};

export const tscAdapter: Adapter = { id: "tsc", emit, run };
