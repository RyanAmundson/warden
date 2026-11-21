import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { systemOneAdapter } from "../../src/adapters/system-one.js";
import { benchSubject, subjectsOf } from "../../src/compiler/bench.js";
import { exampleProjectsRemoved, runExamples } from "../../src/compiler/examples.js";
import { readPack } from "../../src/records/load.js";
import { benchSettings, type Guardrail, type RecordSet } from "../../src/records/types.js";
import { adapters } from "../../src/runner/run.js";
import { conformance } from "./conformance.js";
import { treeSet } from "./tree-pack.js";

it("assesses declared inputs and reuses only the same pinned model request", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-system-one-"));
  const home = join(root, "warden-data");
  const firstModel = "jev-1.13.0";
  const secondModel = "jev-1.14.0";
  const context = { root, generatedDir: join(root, ".warden/generated") };
  const input = join(root, "port.md");
  const question = "Does the port describe one responsibility?";
  const options = { model: firstModel, question, inputs: ["port.md"], failBelow: 0.2, passAt: 0.9 };
  const rule: Guardrail = {
    id: "one-responsibility", implementation: "system-one:noul", scope: "project", kind: "model",
    runs: ["boundary"], budgetMs: 5000, version: 1, options,
  };
  const run = (guardrail = rule) => {
    const adapter = adapters.get("system-one");
    expect(adapter).toBeDefined();
    return adapter!.run([guardrail], ["port.md", "notes.md"], context);
  };
  let response = { model: firstModel, answers: { compliance: { type: "noul", noul: 0.95 } } };
  const endpoint = vi.fn(async (_url: string, _request: RequestInit) => Response.json(response));
  vi.stubGlobal("fetch", endpoint);
  vi.stubEnv("WARDEN_HOME", home);
  vi.stubEnv("TYPESAFE_API_KEY", "fixture-token");
  vi.stubEnv("WARDEN_TYPESAFE", "");
  try {
    await mkdir(home);
    await writeFile(input, "Returns an account total.");
    await writeFile(join(root, "notes.md"), "Unselected notes.");
    await expect(run()).rejects.toThrow("permission");
    expect(endpoint).not.toHaveBeenCalled();

    vi.stubEnv("WARDEN_TYPESAFE", "1");
    const first = await run();
    expect(first).toMatchObject([{ status: "pass", judgment: { model: firstModel, probability: 0.95, verdict: "pass" } }]);
    const [url, request] = endpoint.mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(request).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer fixture-token" } });
    expect(JSON.parse(request.body as string)).toEqual({
      model: firstModel, state: [{ file: "port.md", text: "Returns an account total." }],
      questions: { compliance: { instructions: question, type: "noul" } },
    });
    const { ms: _elapsed, ...initial } = first[0]!;
    expect(initial).toMatchObject({ judgment: { source: "live", liveMs: expect.any(Number) } });
    expect(await run()).toMatchObject([{ status: "pass", judgment: { source: "cache", liveMs: expect.any(Number) } }]);
    await conformance(systemOneAdapter, root, [rule], treeSet(rule), ["port.md"], []);
    expect(endpoint).toHaveBeenCalledTimes(1);

    await writeFile(input, "Returns something and may also import something.");
    response = { model: firstModel, answers: { compliance: { type: "noul", noul: 0.5 } } };
    expect(await run()).toMatchObject([{
      status: "fail", judgment: { verdict: "needs-review" },
      violations: [{ doThis: expect.stringContaining("independent reviewer") }],
    }]);
    const different = { ...rule, options: { ...options, model: secondModel } };
    await expect(run(different)).rejects.toThrow("invalid answer or a model other than");
    response = { model: secondModel, answers: { compliance: { type: "noul", noul: 0.05 } } };
    expect(await run(different)).toMatchObject([{ status: "fail", judgment: { model: secondModel, verdict: "fail" } }]);
    expect(endpoint).toHaveBeenCalledTimes(4);
    for (const file of await readdir(join(home, "system-one"))) {
      const cached = JSON.parse(await readFile(join(home, "system-one", file), "utf8"));
      expect(Object.keys(cached).sort()).toEqual(["input", "liveMs", "model", "probability"]);
    }
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it("requires a conclusive result to prove the model's must-fail example", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-system-one-admission-"));
  const model = "jev-1.13.0";
  const request = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { state: { text: string }[] };
    const oneResponsibility = body.state[0]?.text === "one responsibility";
    await setTimeout(oneResponsibility ? 40 : 210, undefined, { signal: init.signal ?? undefined });
    const noul = oneResponsibility ? 0.95 : 0.5;
    return Response.json({ model, answers: { compliance: { type: "noul", noul } } });
  });
  vi.stubGlobal("fetch", request);
  vi.stubEnv("WARDEN_HOME", root);
  vi.stubEnv("TYPESAFE_API_KEY", "fixture-token");
  vi.stubEnv("WARDEN_TYPESAFE", "1");
  try {
    const rule: Guardrail = {
      id: "single-purpose", implementation: "system-one:noul", scope: "project", kind: "model", version: 1,
      runs: ["boundary"], budgetMs: 5000, benchmark: "fixed-input",
      options: { model, question: "Does the port have one responsibility?", inputs: ["port.md"], failBelow: 0.2, passAt: 0.9 },
      mustPass: { "port.md": "one responsibility" },
      mustFail: { "port.md": "several possible responsibilities" },
    };
    const set: RecordSet = {
      root,
      config: { project: "fixture", base: "main", packs: [{ id: "architecture", paths: [] }], tierBudgetMs: { edit: 1, commit: 1, boundary: 10_000 }, loopBreakerRepeats: 3 },
      packs: [{
        id: "architecture", layer: 1, file: "pack.yaml", terms: [], capabilities: [],
        practices: [{ id: "group-purpose", pack: "architecture", statement: "Each group serves one purpose.", conflictsWith: [], paths: [], terms: [], guardrails: [rule] }],
      }],
    };
    expect(await runExamples(set)).toMatchObject([{ code: "example-failed", record: "single-purpose", message: expect.stringContaining("mustFail") }]);
    const pack = set.packs[0]!;
    const dir = join(root, ".warden", "packs", pack.id);
    await mkdir(dir, { recursive: true });
    const { file: _file, ...packRecord } = pack;
    const practices = pack.practices.map(({ pack: _pack, ...practice }) => practice);
    await writeFile(join(dir, "pack.yaml"), stringify({ ...packRecord, practices }));
    expect(await readPack(root, root, pack.id, "config.yaml")).toMatchObject({ pack: { id: pack.id }, source: "local" });

    const [subject] = subjectsOf(set, [rule]);
    const measurement = await benchSubject(set, subject!, benchSettings(set.config), "warden bench");
    expect(measurement).toMatchObject({ verdict: "fixed-input", timing: "live-model", points: [[1, expect.any(Number)]] });
    expect(measurement.f).toBeGreaterThan(20);
    expect(request).toHaveBeenCalledTimes(2);
    rule.budgetMs = 150;
    expect(await runExamples(set)).toMatchObject([{ code: "over-budget", record: rule.id, message: expect.stringContaining("mustFail") }]);
    expect(request).toHaveBeenCalledTimes(2);

    await writeFile(join(root, "port.md"), "one responsibility");
    const exhausted = { ...rule, id: "deadline", budgetMs: 20, options: { ...rule.options as object, question: "Is this one port?" } };
    expect(await adapters.get("system-one")!.run([exhausted, rule], ["port.md"], { root, generatedDir: join(root, ".warden/generated") }))
      .toMatchObject([{ guardrail: exhausted.id, status: "killed", recovery: expect.stringContaining("Guardrail budget") },
        { guardrail: rule.id, status: "pass", judgment: { source: "cache" } }]);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await exampleProjectsRemoved();
    await rm(root, { recursive: true, force: true });
  }
});
