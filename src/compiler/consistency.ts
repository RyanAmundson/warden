import type { Practice, RecordSet } from "../records/types.js";

export interface Finding {
  code: string;
  record: string;
  message: string;
}

const CODES = [
  "duplicate-term",
  "duplicate-practice",
  "duplicate-guardrail",
  "prose-only",
  "conflict-overlap",
  "undefined-conflict",
  "undefined-term",
  "banned-synonym",
  "layer-order",
];

const prefix = (glob: string): string => glob.split("*", 1)[0] ?? "";

const overlaps = (a: string, b: string): boolean => prefix(a).startsWith(prefix(b)) || prefix(b).startsWith(prefix(a));

const longer = (a: string, b: string): string => (prefix(a).length >= prefix(b).length ? a : b);

const effectiveGlobs = (set: RecordSet, practice: Practice): string[] => {
  const packGlobs = set.config.packs.find((p) => p.id === practice.pack)?.paths ?? [];
  if (practice.paths.length === 0) return packGlobs;
  return packGlobs.flatMap((g) => practice.paths.filter((p) => overlaps(g, p)).map((p) => longer(g, p)));
};

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const duplicates = (ids: string[]): string[] => ids.filter((id, i) => ids.indexOf(id) !== i);

export function checkConsistency(set: RecordSet): Finding[] {
  const findings: Finding[] = [];
  const add = (code: string, record: string, message: string): void => {
    findings.push({ code, record, message });
  };

  const terms = set.packs.flatMap((p) => p.terms);
  const practices = set.packs.flatMap((p) => p.practices);
  const guardrails = practices.flatMap((p) => p.guardrails);

  for (const id of duplicates(terms.map((t) => t.id))) add("duplicate-term", id, `Term ${id} is defined more than once.`);
  for (const id of duplicates(practices.map((p) => p.id))) add("duplicate-practice", id, `Practice ${id} is defined more than once.`);
  for (const id of duplicates(guardrails.map((g) => g.id))) add("duplicate-guardrail", id, `Guardrail ${id} is defined more than once.`);

  for (const p of practices) {
    if (!p.guardrails.some((g) => g.kind !== "instruction")) {
      add("prose-only", p.id, `Practice ${p.id} has no Guardrail that a tool enforces.`);
    }
  }

  const byId = new Map(practices.map((p) => [p.id, p]));
  const seen = new Set<string>();
  for (const p of practices) {
    for (const otherId of p.conflictsWith) {
      const other = byId.get(otherId);
      const key = [p.id, otherId].sort().join("\0");
      if (!other) {
        add("undefined-conflict", p.id, `Practice ${p.id} conflicts with ${otherId}, which is not defined.`);
        continue;
      }
      if (seen.has(key)) continue;
      const left = effectiveGlobs(set, p);
      const right = effectiveGlobs(set, other);
      if (left.some((a) => right.some((b) => overlaps(a, b)))) {
        seen.add(key);
        const first = p.id < otherId ? p.id : otherId;
        const second = first === p.id ? otherId : p.id;
        add("conflict-overlap", first, `Practices ${first} and ${second} conflict and apply to overlapping paths.`);
      }
    }
  }

  const termIds = new Set(terms.map((t) => t.id));
  for (const p of practices) {
    for (const t of p.terms) {
      if (!termIds.has(t)) add("undefined-term", p.id, `Practice ${p.id} names Term ${t}, which is not defined.`);
    }
  }

  for (const p of practices) {
    for (const term of terms) {
      for (const ban of term.bans) {
        if (new RegExp(`(?<!\\w)${escape(ban)}(?!\\w)`, "i").test(p.statement)) {
          add("banned-synonym", p.id, `Practice ${p.id} uses "${ban}", which Term ${term.id} bans.`);
        }
      }
    }
  }

  let highest = -Infinity;
  for (const pack of set.packs) {
    if (pack.layer <= highest) {
      add("layer-order", pack.id, `Pack ${pack.id} layer ${pack.layer} is not above the packs before it.`);
    }
    highest = Math.max(highest, pack.layer);
  }

  return findings.sort(
    (a, b) => CODES.indexOf(a.code) - CODES.indexOf(b.code) || (a.record < b.record ? -1 : a.record > b.record ? 1 : 0),
  );
}
