import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packs = resolve(import.meta.dirname, "../../packs");

type World = { charges: Record<string, number>; receipts: string[] };
type Step = () => Promise<void> | void;
type Request = { id: string; amount: number };

const idempotency = async () => await import(join(packs, "idempotency/check.js")) as {
  checkSpec: (file: string, spec: object, settings: { runs: number; seed: number }) => Promise<string[]>;
};
const proofs = async () => await import(join(packs, "proofs/check.js")) as {
  escapes: (file: string, text: string) => string[];
  interpretBuild: (project: string, result: { status: number; stdout: string; stderr: string; error?: Error }) => string[];
};
const conformance = async () => await import(join(packs, "proofs/conformance.js")) as {
  checkSpec: (file: string, spec: object, root: string, settings: { project: string; runs: number; seed: number }) => Promise<string[]>;
};

const charge = (run: (world: World, request: Request, step: Step) => Promise<void>) => ({
  setup: (): World => ({ charges: {}, receipts: [] }),
  run,
  snapshot: (world: World) => world,
  inputs: (random: () => number) => ({ id: `r${Math.floor(random() * 1000)}`, amount: 1 + Math.floor(random() * 100) }),
});

it("keeps the shared case runner identical in both packs", () => {
  expect(readFileSync(join(packs, "proofs/cases.js"), "utf8")).toBe(readFileSync(join(packs, "idempotency/cases.js"), "utf8"));
});

describe("idempotency", () => {
  const settings = { runs: 20, seed: 1 };

  it("passes an operation that is safe to replay and to retry", async () => {
    const { checkSpec } = await idempotency();
    const spec = charge(async (world, { id, amount }, step) => {
      world.charges[id] ??= amount;
      await step();
      if (!world.receipts.includes(id)) world.receipts.push(id);
    });
    expect(await checkSpec("charge.idempotency.mjs", spec, settings)).toEqual([]);
  });

  it("reports a replay that sends a second receipt", async () => {
    const { checkSpec } = await idempotency();
    const spec = charge(async (world, { id, amount }, step) => {
      world.charges[id] ??= amount;
      await step();
      world.receipts.push(id);
    });
    expect(await checkSpec("charge.idempotency.mjs", spec, settings)).toEqual([expect.stringMatching(/running twice left .*receipts: \[ 'r\d+', 'r\d+' \]/)]);
  });

  it("reports a retry that skips the write the crash interrupted", async () => {
    const { checkSpec } = await idempotency();
    const spec = charge(async (world, { id, amount }, step) => {
      if (id in world.charges) return;
      world.charges[id] = amount;
      await step();
      world.receipts.push(id);
    });
    expect(await checkSpec("charge.idempotency.mjs", spec, settings)).toEqual([expect.stringContaining("a crash at step 1 of 1 and a retry left")]);
  });

  it("reports a snapshot that changes between identical runs instead of a false replay finding", async () => {
    const { checkSpec } = await idempotency();
    let clock = 0;
    const spec = { setup: () => ({}), run: () => undefined, snapshot: () => ({ at: (clock += 1) }), inputs: [1] };
    expect(await checkSpec("clock.idempotency.mjs", spec, settings)).toEqual([expect.stringContaining("one run from a fresh setup gave two different snapshots")]);
  });

  it("refuses a spec without the required functions as a setup error", async () => {
    const { checkSpec } = await idempotency();
    await expect(checkSpec("broken.idempotency.mjs", { setup: () => ({}), inputs: [1] }, settings)).rejects.toThrow("export run as a function");
  });
});

describe("proofs", () => {
  it("finds escapes in code but not in comments or strings", async () => {
    const { escapes } = await proofs();
    const text = [
      "-- sorry in a comment",
      "/- admit /- nested sorry -/ still a comment -/",
      'def s := "sorry"',
      "theorem a : 1 = 1 := by sorry",
      "theorem b : 1 = 1 := by admit",
      "private axiom cheat : False",
    ].join("\n");
    expect(escapes("P.lean", text)).toEqual([
      "P.lean:4: leaves a proof unfinished with sorry",
      "P.lean:5: leaves a proof unfinished with admit",
      "P.lean:6: assumes an unproved axiom",
    ]);
  });

  it("reports Lean errors with their detail and the build's sorry warnings", async () => {
    const { interpretBuild } = await proofs();
    const stdout = [
      "✖ [2/4] Building Proofs",
      "error: Proofs.lean:6:2: omega could not prove the goal:",
      "a possible counterexample may satisfy the constraints",
      "  a - b ≥ 1",
      "warning: ././Proofs.lean:9:8: declaration uses `sorry`",
      "warning: Proofs.lean:12:4: unused variable `h`",
      "Some required targets logged failures:",
      "- Proofs",
      "error: build failed",
    ].join("\n");
    expect(interpretBuild("proofs", { status: 1, stdout, stderr: "" })).toEqual([
      "proofs/Proofs.lean:6: omega could not prove the goal: a possible counterexample may satisfy the constraints a - b ≥ 1",
      "proofs/Proofs.lean:9: declaration uses `sorry`",
    ]);
    expect(interpretBuild("proofs", { status: 1, stdout: "Proofs.lean:3:0: error: unknown identifier 'x'\n", stderr: "" })).toEqual(["proofs/Proofs.lean:3: unknown identifier 'x'"]);
  });

  it("treats a failed build without a Lean diagnostic as a setup error", async () => {
    const { interpretBuild } = await proofs();
    expect(interpretBuild("proofs", { status: 0, stdout: "Build completed successfully.\n", stderr: "" })).toEqual([]);
    expect(() => interpretBuild("proofs", { status: 1, stdout: "", stderr: "error: toolchain not installed\n" })).toThrow("stopped without a Lean diagnostic: error: toolchain not installed");
  });
});

describe("conformance", () => {
  const settings = { project: ".", runs: 30, seed: 1 };
  const model = [
    'import { createInterface } from "node:readline";',
    "for await (const line of createInterface({ input: process.stdin })) {",
    "  const { lo, hi, x } = JSON.parse(line);",
    "  console.log(JSON.stringify(Math.max(lo, Math.min(hi, x))));",
    "}",
  ].join("\n");
  const inputs = (random: () => number) => {
    const lo = Math.floor(random() * 50);
    return { lo, hi: lo + Math.floor(random() * 50), x: Math.floor(random() * 120) };
  };

  const inProject = async (fn: (root: string) => Promise<void>) => {
    const root = await mkdtemp(join(tmpdir(), "warden-conformance-"));
    try {
      await writeFile(join(root, "model.mjs"), model);
      await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  it("passes an implementation that agrees with the model and reports one that does not", async () => {
    const { checkSpec } = await conformance();
    await inProject(async (root) => {
      const spec = (implementation: (c: { lo: number; hi: number; x: number }) => number) => ({ model: ["node", "model.mjs"], implementation, inputs });
      expect(await checkSpec("clamp.conformance.mjs", spec(({ lo, hi, x }) => (x < lo ? lo : x > hi ? hi : x)), root, settings)).toEqual([]);
      const findings = await checkSpec("clamp.conformance.mjs", spec(({ lo, hi, x }) => (x < lo ? lo : x >= hi ? hi - 1 : x)), root, settings);
      expect(findings).toHaveLength(4);
      expect(findings[0]).toMatch(/the implementation returned \d+, but the proved model returns \d+ \(generated case \d+ of seed 1/);
      expect(findings[3]).toMatch(/^clamp\.conformance\.mjs: \d+ more cases differ from the proved model$/);
    });
  });

  it("refuses a model that answers a different number of cases", async () => {
    const { checkSpec } = await conformance();
    await inProject(async (root) => {
      const spec = { model: ["node", "-e", "process.stdin.resume(); process.stdin.on('end', () => console.log(1))"], implementation: () => 1, inputs: [1, 2] };
      await expect(checkSpec("short.conformance.mjs", spec, root, settings)).rejects.toThrow("the model printed 1 results for 2 cases");
    });
  });
});
