import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PackEntry } from "../../src/adapters/pack-code.js";
import { inSandbox } from "../../src/adapters/sandbox.js";

const code = [
  'import net from "node:net";',
  "export default {",
  "  connect: ({ settings }) => { net.connect(settings.path); return []; },",
  "  listen: ({ settings }) => { net.createServer().listen(settings.path); return []; },",
  "  kill: () => { process.kill(process.ppid, 0); return []; },",
  "  rawKill: () => { process._kill(process.ppid, 0); return []; },",
  "  crash: () => { console.error(`pid ${process.pid}`); process.exit(3); },",
  "  fine: () => [],",
  "};",
  "",
].join("\n");

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "warden-sandbox-")));
  await writeFile(join(dir, "pack.js"), code);
});

afterEach(() => rm(dir, { recursive: true, force: true }));

const entry = (name: string): PackEntry => ({ file: "pack.js", real: join(dir, "pack.js"), name, namespace: "local", guardrail: "g", implementation: name, packDir: dir, packFile: join(dir, "pack.yaml"), pointer: "" });

const job = (name: string, settings: Record<string, unknown> = {}): Promise<unknown> => {
  const e = entry(name);
  return inSandbox(e, { kind: "tree", entry: e, input: { files: [], all: [], settings, options: null, terms: [] } }, () => "");
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const within = <T>(ms: number, p: Promise<T>): Promise<T | "hung"> => Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), ms).unref())]);

describe("sandbox child crash", () => {
  it("rejects the running job and every queued job with the next action, leaves no child, and gives a later job a fresh child", async () => {
    const jobs = [job("crash"), job("fine"), job("fine")];
    const settled = await within(4000, Promise.allSettled(jobs));
    expect(settled).not.toBe("hung");
    const results = settled as PromiseSettledResult<unknown>[];
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason.message).toMatch(/stopped Warden's sandbox: .*Next action: fix \w+ in pack\.js, then run warden compile\.$/);
    }
    const pid = Number(/pid (\d+)/.exec((results[0] as PromiseRejectedResult).reason.message)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
    await expect(within(4000, job("fine"))).resolves.toEqual({ found: [], ms: expect.any(Number) });
  });
});

const refusal = (name: string, what: string): RegExp => new RegExp(`^Guardrail g: ${name} in pack\\.js threw: Warden's sandbox refuses ${what}[^]*Next action: fix ${name} in pack\\.js, then run warden compile\\.$`);

describe("sandbox refuses what --permission leaves open", () => {
  let server: Server;
  let reached: number;

  beforeEach(async () => {
    reached = 0;
    server = createServer((s) => {
      reached += 1;
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(join(dir, "s.sock"), r));
  });

  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it("refuses a Unix socket connection with one next action, and the socket hears nothing", async () => {
    await expect(job("connect", { path: join(dir, "s.sock") })).rejects.toThrow(refusal("connect", "socket connections"));
    await new Promise((r) => setTimeout(r, 100));
    expect(reached).toBe(0);
  });

  it("refuses listening on a Unix socket path with one next action, and creates no file", async () => {
    await expect(job("listen", { path: join(dir, "l.sock") })).rejects.toThrow(refusal("listen", "socket servers"));
    expect(existsSync(join(dir, "l.sock"))).toBe(false);
  });

  it("refuses process.kill with one next action", async () => {
    await expect(job("kill")).rejects.toThrow(refusal("kill", "process signals"));
  });

  it("refuses the raw process._kill with one next action", async () => {
    await expect(job("rawKill")).rejects.toThrow(refusal("rawKill", "process signals"));
  });
});
