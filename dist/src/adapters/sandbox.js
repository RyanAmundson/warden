import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { RecordError, findWardenRoot } from "../records/load.js";
const CHILD = fileURLToPath(new URL(`./sandbox-child${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
const STDERR_LINES = 20;
let box;
const both = (dir) => [dir, realpathSync(dir)];
const installDirs = () => {
    const toolDir = dirname(dirname(createRequire(import.meta.url).resolve("eslint/package.json")));
    return [findWardenRoot(), toolDir].flatMap(both);
};
const idle = (b, quiet) => {
    for (const handle of [b.proc, b.proc.stdin, b.proc.stdout, b.proc.stderr]) {
        if (quiet)
            handle.unref();
        else
            handle.ref();
    }
};
const live = new Set();
const stop = (b) => {
    if (box === b)
        box = undefined;
    live.delete(b);
    b.proc.kill("SIGKILL");
};
process.on("exit", () => {
    for (const b of live)
        stop(b);
});
const start = (dirs) => {
    const proc = spawn(process.execPath, ["--permission", ...[...dirs].map((d) => `--allow-fs-read=${d}`), CHILD], { stdio: ["pipe", "pipe", "pipe"], env: {} });
    const b = { proc, dirs, stderr: [], queue: Promise.resolve() };
    createInterface({ input: proc.stdout }).on("line", (line) => {
        let reply;
        try {
            reply = JSON.parse(line);
        }
        catch {
            reply = { crash: `it wrote a line that is not a reply: ${line.slice(0, 200)}` };
        }
        b.onReply?.(reply);
    });
    createInterface({ input: proc.stderr }).on("line", (line) => {
        b.stderr.push(line);
        if (b.stderr.length > STDERR_LINES)
            b.stderr.shift();
    });
    proc.stdin.on("error", () => undefined);
    proc.on("exit", () => {
        if (box === b)
            box = undefined;
        live.delete(b);
        b.onExit?.();
    });
    live.add(b);
    idle(b, true);
    return b;
};
const boxFor = (packDirs) => {
    const wanted = [...installDirs(), ...packDirs.flatMap(both)];
    if (box !== undefined && wanted.every((d) => box?.dirs.has(d)))
        return box;
    const dirs = new Set([...(box?.dirs ?? []), ...wanted]);
    const old = box;
    if (old !== undefined)
        void old.queue.then(() => old.proc.stdin.end());
    box = start(dirs);
    return box;
};
const crashed = (entry, detail) => new RecordError(entry.packFile, entry.pointer, `Guardrail ${entry.guardrail}: ${entry.implementation} in ${entry.file} stopped Warden's sandbox: ${detail.replace(/\.$/, "")}. Next action: fix ${entry.name} in ${entry.file}, then run warden compile.`);
export function inSandbox(entries, job, read, signal) {
    const b = boxFor(entries.map((e) => e.packDir));
    const blamed = entries[0];
    const run = () => new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const finish = () => {
            b.onReply = undefined;
            b.onExit = undefined;
            signal?.removeEventListener("abort", abort);
            idle(b, true);
        };
        const abort = () => {
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
                let answer;
                try {
                    answer = { text: read(reply.read) };
                }
                catch (cause) {
                    answer = { error: cause.message };
                }
                b.proc.stdin.write(`${JSON.stringify(answer)}\n`);
                return;
            }
            finish();
            if (reply.failure !== undefined)
                reject(new RecordError(reply.failure.file, reply.failure.pointer, reply.failure.message));
            else if (reply.crash !== undefined)
                reject(crashed(blamed, reply.crash.split("\n")[0]));
            else
                resolve(reply.done);
        };
        idle(b, false);
        b.proc.stdin.write(`${JSON.stringify(job)}\n`);
    });
    const next = b.queue.then(run, run);
    b.queue = next.catch(() => undefined);
    return next;
}
