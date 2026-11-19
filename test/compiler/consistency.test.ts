import { describe, expect, it } from "vitest";
import { checkConsistency } from "../../src/compiler/consistency.js";
import { reviewAdapters } from "../../src/review/adapter.js";
import type { Capability, Guardrail, Pack, Practice, RecordSet, Term } from "../../src/records/types.js";

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

const pack = (id: string, layer: number, practices: Practice[] = [], terms: Term[] = [], capabilities: Capability[] = []): Pack => ({
  id,
  file: `packs/${id}/pack.yaml`,
  layer,
  terms,
  practices,
  capabilities,
});

const capability = (id: string, pack: string, over: Partial<Capability> = {}): Capability => ({
  id,
  kind: "skill",
  serves: "t",
  purpose: "Gate a unit.",
  when: "Before review.",
  upholds: [],
  commands: ["warden gate"],
  replaces: [],
  pack,
  ...over,
});

const term = { id: "t", definition: "d", bans: [] };
const termU = { id: "u", definition: "d", bans: [] };

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

const noOtherPractices: ReadonlyMap<string, string> = new Map();

const codes = (set: RecordSet) => checkConsistency(set, noOtherPractices).map((f) => f.code);

describe("checkConsistency", () => {
  it("clean set has no findings", () => {
    const set = build([
      pack("a", 1, [practice("p1", "a", { terms: ["t"] })], [{ id: "t", definition: "d", bans: ["foo"] }]),
      pack("b", 2, [practice("p2", "b")]),
    ]);
    expect(checkConsistency(set, noOtherPractices)).toEqual([]);
  });

  it("accepts packs listed out of layer order", () => {
    expect(codes(build([pack("b", 2, [practice("p2", "b")]), pack("a", 1, [practice("p1", "a")])]))).toEqual([]);
  });

  it("refuses two packs on one layer and says to move the local one to a free layer", () => {
    const local = { ...pack("mine", 1, [practice("p2", "mine")]), file: "/w/.warden/packs/mine/pack.yaml" };
    const found = checkConsistency(build([local, pack("a", 1, [practice("p1", "a")]), pack("b", 3, [practice("p3", "b")])]), noOtherPractices);
    expect(found).toEqual([{ code: "layer-order", record: "mine", message: "Packs a and mine both have layer 1. Next action: set layer to 4 in /w/.warden/packs/mine/pack.yaml, then run warden compile." }]);
  });

  it("moves the pack listed later when neither pack on a shared layer is local", () => {
    const found = checkConsistency(build([pack("a", 1, [practice("p1", "a")]), pack("b", 1, [practice("p2", "b")])]), noOtherPractices);
    expect(found.map((f) => f.record)).toEqual(["b"]);
  });

  it("names a different free layer for each pack that must move off a shared layer", () => {
    const local = (id: string): Pack => ({ ...pack(id, 1, [practice(`p-${id}`, id)]), file: `/w/.warden/packs/${id}/pack.yaml` });
    const found = checkConsistency(build([pack("a", 1, [practice("p1", "a")]), local("m1"), local("m2")]), noOtherPractices);
    expect(found.map((f) => /set layer to (\d+)/.exec(f.message)?.[1])).toEqual(["2", "3"]);
  });

  it("refuses a Guardrail id that Warden reserves for its own cost rows", () => {
    const set = build([pack("a", 1, [practice("p1", "a", { guardrails: [guardrail("run")] }), practice("p2", "a", { guardrails: [guardrail("eslint-pass")] })])]);
    const found = checkConsistency(set, noOtherPractices).filter((f) => f.code === "reserved-id");
    expect(found.map((f) => f.record)).toEqual(["eslint-pass", "run"]);
    expect(found[0]?.message).toBe("Guardrail id eslint-pass is reserved for Warden's own cost and scaling rows. Next action: rename Guardrail eslint-pass in packs/a/pack.yaml, then run warden compile.");
  });

  it("refuses a cmd Guardrail of kind lint, which warden check would never fail", () => {
    const cmd = { ...guardrail("g-cmd"), implementation: "cmd:true" };
    const set = build([pack("a", 1, [practice("p1", "a", { guardrails: [cmd, { ...cmd, id: "g-ok", kind: "runtime" }] })])]);
    expect(checkConsistency(set, noOtherPractices)).toEqual([
      {
        code: "cmd-lint",
        record: "g-cmd",
        message: "Guardrail g-cmd has kind lint but runs a cmd command, whose one project-wide result warden check never reports as a lint failure. Next action: set kind to runtime on Guardrail g-cmd in packs/a/pack.yaml, then run warden compile.",
      },
    ]);
  });

  it("flags a tsc Guardrail whose flag has no known diagnostic codes, with one next action", () => {
    const set = build([pack("a", 1, [practice("p", "a", { guardrails: [{ ...guardrail("g-mapped"), implementation: "tsc:noUnusedLocals" }, { ...guardrail("g-unmapped"), implementation: "tsc:noUncheckedIndexedAccess" }] })])]);
    const found = checkConsistency(set, noOtherPractices).filter((f) => f.code === "unmapped-tsc-flag");
    expect(found.map((f) => f.record)).toEqual(["g-unmapped"]);
    expect(found[0]?.message).toContain("Guardrail g-unmapped in packs/a/pack.yaml: tsc:noUncheckedIndexedAccess has no known diagnostic codes");
    expect(found[0]?.message).toMatch(/Next action: change the implementation to one of [^.]*tsc:noUnusedLocals[^.]*, then run warden compile\.$/);
  });

  it("flags duplicate-term at the second occurrence", () => {
    const term = { id: "t", definition: "d", bans: [] };
    const set = build([pack("a", 1, [], [term]), pack("b", 2, [], [term])]);
    expect(codes(set)).toEqual(["duplicate-term"]);
  });

  it("flags duplicate-practice", () => {
    const set = build([pack("a", 1, [practice("p", "a")]), pack("b", 2, [practice("p", "b", { guardrails: [guardrail("g-other")] })])]);
    const findings = checkConsistency(set, noOtherPractices);
    expect(findings.map((f) => f.code)).toEqual(["duplicate-practice"]);
    expect(findings[0]?.record).toBe("p");
  });

  it("flags duplicate-guardrail", () => {
    const set = build([pack("a", 1, [practice("p1", "a", { guardrails: [guardrail("g")] }), practice("p2", "a", { guardrails: [guardrail("g")] })])]);
    expect(codes(set)).toEqual(["duplicate-guardrail"]);
  });

  it("flags prose-only", () => {
    const set = build([pack("a", 1, [practice("p", "a", { guardrails: [guardrail("g", "instruction")] })])]);
    expect(checkConsistency(set, noOtherPractices)).toEqual([
      {
        code: "prose-only",
        record: "p",
        message: "Practice p has no Guardrail that a tool enforces. Next action: add a Guardrail whose kind is not instruction, with mustFail and mustPass examples, to Practice p in packs/a/pack.yaml, then run warden compile.",
      },
    ]);
  });

  it("flags a conflict between two Practices of one pack once per pair, as conflict-same-pack", () => {
    const set = build([
      pack("a", 1, [practice("p1", "a", { conflictsWith: ["p2"] }), practice("p2", "a", { conflictsWith: ["p1"] })]),
    ]);
    expect(checkConsistency(set, noOtherPractices)).toEqual([
      {
        code: "conflict-same-pack",
        record: "p1",
        message: "Practices p1 and p2 are both in pack a and conflict, so the pack contradicts itself. Next action: remove the conflictsWith entries between Practices p1 and p2 in packs/a/pack.yaml, or move one of them into its own pack, then run warden compile.",
      },
    ]);
    for (const p of set.packs[0]?.practices ?? []) p.conflictsWith.splice(0);
    expect(checkConsistency(set, noOtherPractices)).toEqual([]);
  });

  it("never reports conflict-overlap for a same-pack pair on disjoint practice paths", () => {
    const set = build([pack("a", 1, [practice("p1", "a", { conflictsWith: ["p2"], paths: ["src/x/**"] }), practice("p2", "a", { paths: ["src/y/**"] })])]);
    expect(codes(set)).toEqual(["conflict-same-pack"]);
  });

  it("does not flag conflicts on disjoint paths", () => {
    const set = build(
      [pack("a", 1, [practice("p1", "a", { conflictsWith: ["p2"] })]), pack("b", 2, [practice("p2", "b")])],
      { a: ["src/**"], b: ["docs/**"] },
    );
    expect(codes(set)).toEqual([]);
  });

  const conflicting = (a: string[], b: string[]): RecordSet =>
    build([pack("a", 1, [practice("p1", "a", { conflictsWith: ["p2"] })]), pack("b", 2, [practice("p2", "b")])], { a, b });

  it("a negated pack path is refused as a conflict scope", () => {
    expect(checkConsistency(conflicting(["!**/sources/**"], ["docs/**"]), noOtherPractices)).toEqual([
      {
        code: "conflict-scope",
        record: "a",
        message: "Pack a has path !**/sources/** in /w/.warden/config.yaml, and Practice p1 conflicts with p2, so its paths must be folder scopes. Next action: replace !**/sources/** in the paths of pack a in /w/.warden/config.yaml with folder scopes such as src/ui/**, then run warden compile.",
      },
    ]);
  });

  it("src/{ui,core}/** against src/ui/** is refused as a conflict scope", () => {
    const found = checkConsistency(conflicting(["src/{ui,core}/**"], ["src/ui/**"]), noOtherPractices);
    expect(found.map((f) => [f.code, f.record])).toEqual([["conflict-scope", "a"]]);
    expect(found[0]?.message.split("Next action:")).toHaveLength(2);
  });

  it("empty pack paths are refused as a conflict scope", () => {
    const message = "Pack a has no paths in /w/.warden/config.yaml, and Practice p1 conflicts with p2, so its paths must be folder scopes. Next action: add a folder scope such as src/** to the paths of pack a in /w/.warden/config.yaml, then run warden compile.";
    const set = conflicting([], ["docs/**"]);
    expect(checkConsistency(set, noOtherPractices)).toEqual([{ code: "conflict-scope", record: "a", message }]);
    const alone = build([pack("a", 1, [practice("p1", "a", { conflictsWith: ["p2"] })])], { a: [] });
    const elsewhere = new Map([["p2", "b"]]);
    expect(checkConsistency(alone, elsewhere)).toEqual([{ code: "conflict-scope", record: "a", message }]);
    alone.config.packs[0]?.paths.push("src/**");
    set.config.packs[0]?.paths.push("src/**");
    expect(checkConsistency(alone, elsewhere)).toEqual([]);
    expect(checkConsistency(set, noOtherPractices)).toEqual([]);
  });

  it("refuses the named Practice's pack scope too", () => {
    expect(checkConsistency(conflicting(["src/**"], ["docs/*.md"]), noOtherPractices).map((f) => [f.code, f.record])).toEqual([["conflict-scope", "b"]]);
  });

  it.each([
    ["src/ui/**", "src/ui/**", true],
    ["src/**", "src/ui/**", true],
    ["src/ui/**", "src/ui-kit/**", false],
    ["src/ui/**", "docs/**", false],
    ["[[]plugins]/a/**", "[[]plugins]/**", true],
  ])("%s against %s overlapping is %s", (a, b, overlapping) => {
    const found = checkConsistency(conflicting([a], [b]), noOtherPractices);
    const folder = (glob: string) => glob.slice(0, -3).replaceAll("[[]", "[");
    expect(found).toEqual(
      overlapping
        ? [
            {
              code: "conflict-overlap",
              record: "p1",
              message: `Practices p1 and p2 conflict and both apply under ${folder(a)} and ${folder(b)}. Next action: change the paths of pack b in /w/.warden/config.yaml so that no folder contains or is inside ${folder(a)}, then run warden compile.`,
            },
          ]
        : [],
    );
  });

  it("the conflict-overlap next action clears it", () => {
    const set = conflicting(["src/**"], ["src/**"]);
    const [finding] = checkConsistency(set, noOtherPractices);
    expect(finding?.code).toBe("conflict-overlap");
    expect(finding?.message.split("Next action:")).toHaveLength(2);
    set.config.packs[1]?.paths.splice(0, 1, "docs/**");
    expect(checkConsistency(set, noOtherPractices)).toEqual([]);
  });

  it("the conflict-scope next action clears it", () => {
    const set = conflicting(["!**/sources/**"], ["docs/**"]);
    expect(codes(set)).toEqual(["conflict-scope"]);
    set.config.packs[0]?.paths.splice(0, 1, "src/**");
    expect(checkConsistency(set, noOtherPractices)).toEqual([]);
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
    const findings = checkConsistency(set, noOtherPractices);
    expect(findings.map((f) => f.code)).toEqual(["undefined-conflict"]);
    expect(findings[0]?.record).toBe("p");
    expect(findings[0]?.message.split("Next action:")).toHaveLength(2);
    expect(findings[0]?.message).toContain("remove ghost from conflictsWith of Practice p in packs/a/pack.yaml");
    set.packs[0]?.practices[0]?.conflictsWith.splice(0);
    expect(codes(set)).toEqual([]);
  });

  it("a conflict with a practice in a disabled pack gives no finding", () => {
    const set = build([pack("a", 1, [practice("p1", "a", { conflictsWith: ["p2"] })])]);
    expect(checkConsistency(set, new Map([["p2", "b"]])).map((f) => f.code)).toEqual([]);
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

  it("two capabilities with one id fail as duplicate-capability", () => {
    const set = build([pack("a", 1, [], [term, termU], [capability("c", "a")]), pack("b", 2, [], [], [capability("c", "b", { serves: "u" })])]);
    const found = checkConsistency(set, noOtherPractices);
    expect(found.map((f) => [f.code, f.record])).toEqual([["duplicate-capability", "c"]]);
    const renamed = build([pack("a", 1, [], [term, termU], [capability("c", "a")]), pack("b", 2, [], [], [capability("c2", "b", { serves: "u" })])]);
    expect(checkConsistency(renamed, noOtherPractices)).toEqual([]);
  });

  it("two capabilities that serve one Term fail as same-purpose", () => {
    const set = build([pack("a", 1, [], [term], [capability("first", "a")]), pack("b", 2, [], [], [capability("second", "b")])]);
    const found = checkConsistency(set, noOtherPractices);
    expect(found.map((f) => [f.code, f.record])).toEqual([["same-purpose", "second"]]);
    expect(found[0]?.message.endsWith("Next action: merge second into first in packs/b/pack.yaml, then run warden compile.")).toBe(true);
    const merged = build([pack("a", 1, [], [term], [capability("first", "a")]), pack("b", 2)]);
    expect(checkConsistency(merged, noOtherPractices)).toEqual([]);
  });

  it("a capability that upholds an undefined Practice fails as undefined-upheld", () => {
    const set = build([pack("a", 1, [], [term], [capability("c", "a", { upholds: ["p"] })])]);
    const found = checkConsistency(set, noOtherPractices);
    expect(found.map((f) => [f.code, f.record])).toEqual([["undefined-upheld", "c"]]);
    const enabled = build([pack("a", 1, [], [term], [capability("c", "a", { upholds: ["p"] })]), pack("b", 2, [practice("p", "b")])]);
    expect(checkConsistency(enabled, noOtherPractices)).toEqual([]);
  });

  it("a capability that serves an undefined Term fails as undefined-serves", () => {
    const set = build([pack("a", 1, [], [], [capability("c", "a")])]);
    const found = checkConsistency(set, noOtherPractices);
    expect(found.map((f) => [f.code, f.record])).toEqual([["undefined-serves", "c"]]);
    const enabled = build([pack("b", 1, [], [term]), pack("a", 2, [], [], [capability("c", "a")])]);
    expect(checkConsistency(enabled, noOtherPractices)).toEqual([]);
  });

  it("an unknown review adapter fails as unknown-review-adapter", () => {
    const set = build([pack("a", 1, [], [term], [capability("c", "a", { review: { adapter: "nope", model: "opus" } })])]);
    const found = checkConsistency(set, noOtherPractices);
    expect(found.map((f) => [f.code, f.record])).toEqual([["unknown-review-adapter", "c"]]);
    const known = [...reviewAdapters.keys()];
    expect(known).toEqual(["superpowers-review"]);
    expect(found[0]?.message).toBe(`Capability c names review adapter nope, which Warden does not have. Next action: set review.adapter to one of ${known.join(", ")} in packs/a/pack.yaml, then run warden compile.`);
    const fixed = build([pack("a", 1, [], [term], [capability("c", "a", { review: { adapter: known[0]!, model: "opus" } })])]);
    expect(checkConsistency(fixed, noOtherPractices)).toEqual([]);
  });

  it("orders findings by code then record id", () => {
    const set = build([
      pack("a", 1, [
        practice("z", "a", { terms: ["m"] }),
        practice("b", "a", { terms: ["m"] }),
        practice("c", "a", { guardrails: [guardrail("gc", "instruction")] }),
      ]),
    ]);
    expect(checkConsistency(set, noOtherPractices).map((f) => `${f.code}:${f.record}`)).toEqual([
      "prose-only:c",
      "undefined-term:b",
      "undefined-term:z",
    ]);
  });
});
