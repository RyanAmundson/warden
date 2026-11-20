import { type ChildProcess, type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { RecordError, findWardenRoot } from "../records/load.js";
import type { PackEntry } from "./pack-code.js";

const CHILD = fileURLToPath(new URL(`./sandbox-child${extname(fileURLToPath(import.meta.url))}`, import.meta.url));

const STDERR_LINES = 20;

interface Reply {
  read?: string;
  done?: unknown;
  failure?: { file: string; pointer: string; message: string };
  crash?: string;
}

interface Box {
  proc: ChildProcessByStdio<Writable, null, Readable>;
  replies: Readable;
  guard: ChildProcess;
  packDir: string;
  stderr: string[];
  exited: boolean;
  onReply?: (line: string) => void;
  onExit?: () => void;
  queue: Promise<unknown>;
}

const GUARD = 'process.stdin.on("end", () => { try { process.kill(Number(process.argv[1]), "SIGKILL"); } catch {} process.exit(0); }); process.stdin.resume();';

const boxes = new Map<string, Box>();

const hops = (path: string): string[] => {
  const seen = [path];
  for (let at = path; lstatSync(at).isSymbolicLink(); ) {
    at = resolve(dirname(at), readlinkSync(at));
    seen.push(at);
  }
  return [...seen, realpathSync(path)];
};

const TOOLS = ["eslint", "typescript-eslint", "typescript", "marked"];

const installDirs = (): string[] => {
  const root = findWardenRoot();
  const require = createRequire(import.meta.url);
  const modules = join(root, "node_modules");
  const toolDirs = TOOLS.map((name) => dirname(dirname(require.resolve(`${name}/package.json`))));
  return [root, ...(existsSync(modules) ? [modules] : []), ...toolDirs].flatMap(hops);
};

const idle = (b: Box, quiet: boolean): void => {
  for (const handle of [b.proc, b.proc.stdin, b.replies, b.proc.stderr] as unknown as { ref(): void; unref(): void }[]) {
    if (quiet) handle.unref();
    else handle.ref();
  }
};

const stop = (b: Box): void => {
  if (boxes.get(b.packDir) === b) boxes.delete(b.packDir);
  b.exited = true;
  b.guard.kill("SIGKILL");
  b.proc.kill("SIGKILL");
};

process.on("exit", () => {
  for (const b of boxes.values()) stop(b);
});

const start = (packDir: string): Box => {
  const dirs = new Set([...installDirs(), ...hops(packDir)]);
  const proc = spawn(process.execPath, ["--permission", "--no-experimental-sqlite", ...[...dirs].map((d) => `--allow-fs-read=${d}`), CHILD], { stdio: ["pipe", "ignore", "pipe", "pipe"], env: {} }) as ChildProcessByStdio<Writable, null, Readable>;
  const replies = proc.stdio[3];
  if (!(replies instanceof Readable)) {
    proc.kill("SIGKILL");
    throw new Error("Warden could not open the sandbox reply pipe");
  }
  const guard = spawn(process.execPath, ["-e", GUARD, String(proc.pid)], { stdio: ["pipe", "ignore", "ignore"], env: {} });
  guard.unref();
  (guard.stdin as unknown as { unref(): void }).unref();
  guard.stdin.on("error", () => undefined);
  const b: Box = { proc, replies, guard, packDir, stderr: [], exited: false, queue: Promise.resolve() };
  createInterface({ input: replies }).on("line", (line) => b.onReply?.(line)).on("close", () => {
    if (!b.exited) stop(b);
  });
  createInterface({ input: proc.stderr }).on("line", (line) => {
    b.stderr.push(line);
    if (b.stderr.length > STDERR_LINES) b.stderr.shift();
  });
  proc.stdin.on("error", () => undefined);
  proc.on("close", () => {
    if (boxes.get(packDir) === b) boxes.delete(packDir);
    b.exited = true;
    guard.kill("SIGKILL");
    b.onExit?.();
  });
  boxes.set(packDir, b);
  idle(b, true);
  return b;
};

const boxFor = (packDir: string): Box => boxes.get(packDir) ?? start(packDir);

const crashed = (entry: PackEntry, detail: string): RecordError =>
  new RecordError(entry.packFile, entry.pointer, `Guardrail ${entry.guardrail}: ${entry.implementation} in ${entry.file} stopped Warden's sandbox: ${oneLine(detail)}. Next action: fix ${entry.name} in ${entry.file}, then run warden compile.`);

const oneLine = (text: string): string => text.trim().replace(/\s*\n\s*/g, " ").replace(/\.$/, "");

const decodeReply = (line: string, tag: string): Reply | undefined => {
  const prefix = `${tag} `;
  if (!line.startsWith(prefix)) return undefined;
  try {
    const reply = JSON.parse(line.slice(prefix.length)) as Reply | null;
    if (reply === null || typeof reply !== "object" || Object.keys(reply).length !== 1) return undefined;
    if (typeof reply.read === "string" || typeof reply.crash === "string" || Object.hasOwn(reply, "done")) return reply;
    const failure = reply.failure;
    return typeof failure?.file === "string" && typeof failure.pointer === "string" && typeof failure.message === "string" ? reply : undefined;
  } catch {
    return undefined;
  }
};

export function inSandbox<T>(blamed: PackEntry, job: object, read: (file: string) => string, signal?: AbortSignal): Promise<T> {
  const b = boxFor(realpathSync(blamed.packDir));
  const run = (): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      signal?.throwIfAborted();
      if (b.exited) {
        reject(crashed(blamed, b.stderr.at(-1) ?? "it exited"));
        return;
      }
      const finish = (): void => {
        b.onReply = undefined;
        b.onExit = undefined;
        signal?.removeEventListener("abort", abort);
        idle(b, true);
      };
      const abort = (): void => {
        finish();
        stop(b);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      b.onExit = () => {
        finish();
        reject(crashed(blamed, b.stderr.at(-1) ?? "it exited"));
      };
      const tag = randomUUID();
      b.onReply = (line) => {
        const reply = decodeReply(line, tag);
        if (reply === undefined) {
          finish();
          stop(b);
          reject(crashed(blamed, "it sent an invalid reply for the active request"));
          return;
        }
        if (reply.read !== undefined) {
          let answer: { text: string } | { error: string };
          try {
            answer = { text: read(reply.read) };
          } catch (cause) {
            answer = { error: (cause as Error).message };
          }
          b.proc.stdin.write(`${JSON.stringify(answer)}\n`);
          return;
        }
        finish();
        if (reply.failure !== undefined) reject(new RecordError(reply.failure.file, reply.failure.pointer, reply.failure.message));
        else if (reply.crash !== undefined) reject(crashed(blamed, reply.crash));
        else resolve(reply.done as T);
      };
      idle(b, false);
      b.proc.stdin.write(`${JSON.stringify({ tag, job })}\n`);
    });
  const next = b.queue.then(run, run);
  b.queue = next.catch(() => undefined);
  return next;
}
