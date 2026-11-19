import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname } from "node:path";
import { createInterface } from "node:readline";
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
  proc: ChildProcessWithoutNullStreams;
  dirs: Set<string>;
  stderr: string[];
  onReply?: (reply: Reply) => void;
  onExit?: () => void;
  queue: Promise<unknown>;
}

let box: Box | undefined;

const both = (dir: string): string[] => [dir, realpathSync(dir)];

const installDirs = (): string[] => {
  const toolDir = dirname(dirname(createRequire(import.meta.url).resolve("eslint/package.json")));
  return [findWardenRoot(), toolDir].flatMap(both);
};

const idle = (b: Box, quiet: boolean): void => {
  for (const handle of [b.proc, b.proc.stdin, b.proc.stdout, b.proc.stderr] as unknown as { ref(): void; unref(): void }[]) {
    if (quiet) handle.unref();
    else handle.ref();
  }
};

const live = new Set<Box>();

const stop = (b: Box): void => {
  if (box === b) box = undefined;
  live.delete(b);
  b.proc.kill("SIGKILL");
};

process.on("exit", () => {
  for (const b of live) stop(b);
});

const start = (dirs: Set<string>): Box => {
  const proc = spawn(process.execPath, ["--permission", ...[...dirs].map((d) => `--allow-fs-read=${d}`), CHILD], { stdio: ["pipe", "pipe", "pipe"], env: {} });
  const b: Box = { proc, dirs, stderr: [], queue: Promise.resolve() };
  createInterface({ input: proc.stdout }).on("line", (line) => {
    let reply: Reply;
    try {
      reply = JSON.parse(line) as Reply;
    } catch {
      reply = { crash: `it wrote a line that is not a reply: ${line.slice(0, 200)}` };
    }
    b.onReply?.(reply);
  });
  createInterface({ input: proc.stderr }).on("line", (line) => {
    b.stderr.push(line);
    if (b.stderr.length > STDERR_LINES) b.stderr.shift();
  });
  proc.stdin.on("error", () => undefined);
  proc.on("exit", () => {
    if (box === b) box = undefined;
    live.delete(b);
    b.onExit?.();
  });
  live.add(b);
  idle(b, true);
  return b;
};

const boxFor = (packDirs: string[]): Box => {
  const wanted = [...installDirs(), ...packDirs.flatMap(both)];
  if (box !== undefined && wanted.every((d) => box?.dirs.has(d))) return box;
  const dirs = new Set([...(box?.dirs ?? []), ...wanted]);
  const old = box;
  if (old !== undefined) void old.queue.then(() => old.proc.stdin.end());
  box = start(dirs);
  return box;
};

const crashed = (entry: PackEntry, detail: string): RecordError =>
  new RecordError(entry.packFile, entry.pointer, `Guardrail ${entry.guardrail}: ${entry.implementation} in ${entry.file} stopped Warden's sandbox: ${detail.replace(/\.$/, "")}. Next action: fix ${entry.name} in ${entry.file}, then run warden compile.`);

export function inSandbox<T>(entries: PackEntry[], job: object, read: (file: string) => string, signal?: AbortSignal): Promise<T> {
  const b = boxFor(entries.map((e) => e.packDir));
  const blamed = entries[0] as PackEntry;
  const run = (): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      signal?.throwIfAborted();
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
      b.onReply = (reply) => {
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
        else if (reply.crash !== undefined) reject(crashed(blamed, reply.crash.split("\n")[0] as string));
        else resolve(reply.done as T);
      };
      idle(b, false);
      b.proc.stdin.write(`${JSON.stringify(job)}\n`);
    });
  const next = b.queue.then(run, run);
  b.queue = next.catch(() => undefined);
  return next;
}
