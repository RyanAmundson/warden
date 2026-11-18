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
  layer,
  terms,
  practices,
});

const build = (packs: Pack[], paths: Record<string, string[]> = {}): RecordSet => ({
  root: "/w",
  packs,
  config: {
    warden: "1",
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
    expect(codes(set)).toEqual(["prose-only"]);
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
