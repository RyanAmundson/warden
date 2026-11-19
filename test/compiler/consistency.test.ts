import { describe, expect, it } from "vitest";
import { checkConsistency } from "../../src/compiler/consistency.js";
import type { Guardrail, Pack, Practice, RecordSet, Term } from "../../src/records/types.js";

const guardrail = (id: string, kind: Guardrail["kind"] = "lint"): Guardrail => ({
  id,
  kind,
  runs: ["edit"],
  budgetMs: 100,
  version: 1,
  implementation: "eslint:no-var",
});

const practice = (id: string, pack: string, over: Partial<Practice> = {}): Practice => ({
  id,
  pack,
  statement: "Declare with const.",
  terms: [],
  paths: [],
  conflictsWith: [],
  guardrails: [guardrail(`g-${id}`)],
  ...over,
});

const pack = (id: string, layer: number, practices: Practice[] = [], terms: Term[] = []): Pack => ({
  id,
  file: `packs/${id}/pack.yaml`,
  layer,
  terms,
  practices,
});

const build = (packs: Pack[], paths: Record<string, string[]> = {}): RecordSet => ({
  root: "/w",
  packs,
  config: {
    project: "p",
    base: "main",
    packs: packs.map((p) => ({ id: p.id, paths: paths[p.id] ?? ["src/**"] })),
    tierBudgetMs: { edit: 1000, commit: 1000, boundary: 1000 },
    loopBreakerRepeats: 3,
  },
});

const codes = (set: RecordSet) => checkConsistency(set).map((f) => f.code);

describe("checkConsistency", () => {
  it("clean set has no findings", () => {
    const set = build([
      pack("a", 1, [practice("p1", "a", { terms: ["t"] })], [{ id: "t", definition: "d", bans: ["foo"] }]),
      pack("b", 2, [practice("p2", "b")]),
    ]);
    expect(checkConsistency(set)).toEqual([]);
  });

  it("refuses a Guardrail id that Warden reserves for its own cost rows", () => {
    const set = build([pack("a", 1, [practice("p1", "a", { guardrails: [guardrail("run")] }), practice("p2", "a", { guardrails: [guardrail("eslint-pass")] })])]);
    const found = checkConsistency(set).filter((f) => f.code === "reserved-id");
    expect(found.map((f) => f.record)).toEqual(["eslint-pass", "run"]);
    expect(found[0]?.message).toBe("Guardrail id eslint-pass is reserved for Warden's own cost and scaling rows. Next action: rename Guardrail eslint-pass in packs/a/pack.yaml, then run warden compile.");
  });

  it("refuses a cmd Guardrail of kind lint, which warden check would never fail", () => {
    const cmd = { ...guardrail("g-cmd"), implementation: "cmd:true" };
    const set = build([pack("a", 1, [practice("p1", "a", { guardrails: [cmd, { ...cmd, id: "g-ok", kind: "runtime" }] })])]);
    expect(checkConsistency(set)).toEqual([
      {
        code: "cmd-lint",
        record: "g-cmd",
        message: "Guardrail g-cmd has kind lint but runs a cmd command, whose one project-wide result warden check never reports as a lint failure. Next action: set kind to runtime on Guardrail g-cmd in packs/a/pack.yaml, then run warden compile.",
      },
    ]);
  });

  it("flags a tsc Guardrail whose flag has no known diagnostic codes, with one next action", () => {
    const set = build([pack("a", 1, [practice("p", "a", { guardrails: [{ ...guardrail("g-mapped"), implementation: "tsc:noUnusedLocals" }, { ...guardrail("g-unmapped"), implementation: "tsc:noUnusedParameters" }] })])]);
    const found = checkConsistency(set).filter((f) => f.code === "unmapped-tsc-flag");
    expect(found.map((f) => f.record)).toEqual(["g-unmapped"]);
    expect(found[0]?.message).toContain("Guardrail g-unmapped in packs/a/pack.yaml: tsc:noUnusedParameters has no known diagnostic codes");
    expect(found[0]?.message).toMatch(/Next action: change the implementation to one of [^.]*tsc:noUnusedLocals[^.]*, then run warden compile\.$/);
  });

  it("flags duplicate-term at the second occurrence", () => {
    const term = { id: "t", definition: "d", bans: [] };
    const set = build([pack("a", 1, [], [term]), pack("b", 2, [], [term])]);
    expect(codes(set)).toEqual(["duplicate-term"]);
  });

  it("flags duplicate-practice", () => {
    const set = build([pack("a", 1, [practice("p", "a")]), pack("b", 2, [practice("p", "b", { guardrails: [guardrail("g-other")] })])]);
    const findings = checkConsistency(set);
    expect(findings.map((f) => f.code)).toEqual(["duplicate-practice"]);
    expect(findings[0]?.record).toBe("p");
  });

  it("flags duplicate-guardrail", () => {
    const set = build([pack("a", 1, [practice("p1", "a", { guardrails: [guardrail("g")] }), practice("p2", "a", { guardrails: [guardrail("g")] })])]);
    expect(codes(set)).toEqual(["duplicate-guardrail"]);
  });

  it("flags prose-only", () => {
    const set = build([pack("a", 1, [practice("p", "a", { guardrails: [guardrail("g", "instruction")] })])]);
    expect(checkConsistency(set)).toEqual([
      {
        code: "prose-only",
        record: "p",
        message: "Practice p has no Guardrail that a tool enforces. Next action: add a Guardrail whose kind is not instruction, with mustFail and mustPass examples, to Practice p in packs/a/pack.yaml, then run warden compile.",
      },
    ]);
  });

  it("flags conflict-overlap once per pair", () => {
    const set = build([
      pack("a", 1, [practice("p1", "a", { conflictsWith: ["p2"] }), practice("p2", "a", { conflictsWith: ["p1"] })]),
    ]);
    expect(codes(set)).toEqual(["conflict-overlap"]);
  });

  it("does not flag conflicts on disjoint paths", () => {
    const set = build(
      [pack("a", 1, [practice("p1", "a", { conflictsWith: ["p2"] })]), pack("b", 2, [practice("p2", "b")])],
      { a: ["src/**"], b: ["docs/**"] },
    );
    expect(codes(set)).toEqual([]);
  });

  it("narrows conflict paths by a practice's own paths", () => {
    const set = build(
      [
        pack("a", 1, [practice("p1", "a", { conflictsWith: ["p2"], paths: ["src/x/**"] })]),
        pack("b", 2, [practice("p2", "b", { paths: ["src/y/**"] })]),
      ],
      { a: ["src/**"], b: ["src/**"] },
    );
    expect(codes(set)).toEqual([]);
  });

  it("flags undefined-conflict", () => {
    const set = build([pack("a", 1, [practice("p", "a", { conflictsWith: ["ghost"] })])]);
    const findings = checkConsistency(set);
    expect(findings.map((f) => f.code)).toEqual(["undefined-conflict"]);
    expect(findings[0]?.record).toBe("p");
  });

  it("flags undefined-term", () => {
    const set = build([pack("a", 1, [practice("p", "a", { terms: ["missing"] })])]);
    expect(codes(set)).toEqual(["undefined-term"]);
  });

  it("flags banned-synonym whole-word and case-insensitive", () => {
    const terms = [{ id: "t", definition: "d", bans: ["Foo"] }];
    const hit = build([pack("a", 1, [practice("p", "a", { statement: "Never use FOO here." })], terms)]);
    const miss = build([pack("a", 1, [practice("p", "a", { statement: "Use foobar here." })], terms)]);
    expect(codes(hit)).toEqual(["banned-synonym"]);
    expect(codes(miss)).toEqual([]);
  });

  it("flags layer-order", () => {
    const set = build([pack("a", 2, [practice("p1", "a")]), pack("b", 2, [practice("p2", "b")])]);
    expect(codes(set)).toEqual(["layer-order"]);
  });

  it("orders findings by code then record id", () => {
    const set = build([
      pack("a", 1, [
        practice("z", "a", { terms: ["m"] }),
        practice("b", "a", { terms: ["m"] }),
        practice("c", "a", { guardrails: [guardrail("gc", "instruction")] }),
      ]),
    ]);
    expect(checkConsistency(set).map((f) => `${f.code}:${f.record}`)).toEqual([
      "prose-only:c",
      "undefined-term:b",
      "undefined-term:z",
    ]);
  });
});
