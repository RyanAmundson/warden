import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireNode25 } from "../../src/cli/node-version.js";

describe("requireNode25", () => {
  it.each(["25.0.0", "25.2.1", "26.1.0", "100.0.0"])("accepts Node %s", (version) => {
    expect(() => requireNode25(version)).not.toThrow();
  });

  it.each(["24.9.0", "22.11.0", "20.18.1", "9.0.0", "v25.0.0"])("refuses Node %s with one next action", (version) => {
    expect(() => requireNode25(version)).toThrow(
      `Warden needs Node 25 or newer; this is Node ${version}. Next action: install Node 25 or newer, then run warden again`,
    );
  });
});

const main = resolve(import.meta.dirname, "../../dist/src/cli/main.js");
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "warden-node-"));
  await writeFile(join(scratch, "fake.cjs"), "Object.defineProperty(process, 'versions', { value: { ...process.versions, node: process.env.FAKE_NODE } });\n");
});

afterAll(() => rm(scratch, { recursive: true, force: true }));

const bin = resolve(import.meta.dirname, "../../bin/warden.js");

const run = (fake: string, entry = main): { code: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, [entry, "--version"], { encoding: "utf8", env: { ...process.env, WARDEN_HOME: scratch, NODE_OPTIONS: `--require ${join(scratch, "fake.cjs")}`, FAKE_NODE: fake } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("the warden entry", () => {
  it("refuses an older Node before any work, exit 2 with the one next action", () => {
    const r = run("22.11.0");
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toBe("Warden needs Node 25 or newer; this is Node 22.11.0. Next action: install Node 25 or newer, then run warden again\n");
  });

  it("runs on Node 25", () => {
    expect(run("25.0.0").code).toBe(0);
  });

  it("the bin wrapper refuses an older Node with only the refusal line", () => {
    const r = run("22.11.0", bin);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toBe("Warden needs Node 25 or newer; this is Node 22.11.0. Next action: install Node 25 or newer, then run warden again\n");
  });

  it("the bin wrapper runs warden on Node 25", () => {
    const r = run("25.0.0", bin);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});
