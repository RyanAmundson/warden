import { RecordError, loadRecords } from "../records/load.js";
import type { Guardrail, Practice } from "../records/types.js";
import { readEvidence } from "../runner/evidence.js";

const EVIDENCE_LINES = 20;

const fenced = (label: string, source: string | undefined): string[] =>
  source === undefined ? [] : [`    ${label}:`, ...source.replace(/\n+$/, "").split("\n").map((l) => `      ${l}`)];

const describeGuardrail = (g: Guardrail): string[] => [
  `  Guardrail ${g.id}  kind: ${g.kind}  tiers: ${g.runs.join(", ")}  budget: ${g.budgetMs} ms`,
  ...fenced("Compliant example (mustPass)", g.mustPass),
  ...fenced("Violating example (mustFail)", g.mustFail),
];

export async function runExplain(root: string, wardenRoot: string, id: string): Promise<number> {
  const set = await loadRecords(root, wardenRoot);
  const practices = set.packs.flatMap((p) => p.practices);
  const hit = practices.find((x) => x.id === id);
  const guardrail = practices.flatMap((x) => x.guardrails).find((g) => g.id === id);
  if (hit === undefined && guardrail === undefined) throw new RecordError("", "", `no Practice or Guardrail has id "${id}"`);

  const owner = hit ?? (practices.find((x) => x.guardrails.some((g) => g.id === id)) as Practice);
  const terms = set.packs.flatMap((p) => p.terms).filter((t) => owner.terms.includes(t.id));
  const guardrails = hit === undefined ? [guardrail as Guardrail] : hit.guardrails;
  const ids = new Set([id, ...guardrails.map((g) => g.id)]);
  const lines = [`Practice ${owner.id}`, `  ${owner.statement}`];
  if (terms.length > 0) lines.push("Terms:", ...terms.map((t) => `  ${t.id}: ${t.definition}`));
  lines.push("Guardrails:", ...guardrails.flatMap(describeGuardrail));
  const evidence = readEvidence(set.config.project)
    .filter((e) => e.guardrail !== undefined && ids.has(e.guardrail))
    .slice(-EVIDENCE_LINES);
  lines.push(`Evidence (last ${EVIDENCE_LINES}):`, ...(evidence.length === 0 ? ["  none"] : evidence.map((e) => `  ${JSON.stringify(e)}`)));
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
