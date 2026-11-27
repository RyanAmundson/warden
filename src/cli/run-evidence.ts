import { loadRecords, RecordError } from "../records/load.js";
import type { Evidence } from "../runner/evidence.js";
import { describeRules, recordedRuleIds } from "../runner/rule-details.js";
import { runRecords } from "./runs.js";

type Finding = { file: string; guardrail: string; line?: number; practice?: string; doThis?: string };
type Source = { run?: string; at: string; root?: string; tier?: Evidence["tier"]; trigger?: Evidence["trigger"]; ref?: string };
type CurrentFinding = Finding & { source: Source; policy?: string; unverified?: boolean };

const findingKey = ({ guardrail, file }: Finding): string => JSON.stringify([guardrail, file]);
const sourceRoot = (run: Evidence): string | undefined => run.root ?? run.attemptedRoot;
const sourceOf = (run: Evidence): Source => ({ run: run.run, at: run.at, root: sourceRoot(run), tier: run.tier, trigger: run.trigger, ref: run.ref });
const audit = (run: Evidence): boolean => ["main audit", "audit", "continuous audit"].some((trigger) => trigger === run.trigger);

function firedByRun(evidence: Evidence[]): Map<string, Evidence[]> {
  const fired = new Map<string, Evidence[]>();
  for (const event of evidence) {
    if (event.kind !== "fired" || event.status !== "fail" || event.run === undefined) continue;
    const events = fired.get(event.run) ?? [];
    events.push(event);
    fired.set(event.run, events);
  }
  return fired;
}

function findingsOf(run: Evidence, fired: Evidence[]): Finding[] {
  const recorded = run.failures ?? [];
  const keys = new Set(recorded.map(findingKey));
  const additional: Finding[] = [];
  for (const { guardrail, file } of fired) {
    if (guardrail === undefined || file === undefined) continue;
    const key = findingKey({ guardrail, file });
    if (keys.has(key)) continue;
    keys.add(key);
    additional.push({ guardrail, file });
  }
  return [...recorded, ...additional];
}

export function runEvidence(evidence: Evidence[], id: string, limit: number) {
  const runs = runRecords(evidence);
  const index = runs.findIndex((run) => run.run === id);
  const run = runs[index];
  if (run === undefined) return undefined;
  const events = evidence.filter((event) => event.run === id);
  return {
    runs: runs.slice(Math.max(0, index - limit + 1), index + 1).reverse(),
    findings: findingsOf(run, firedByRun(events).get(id) ?? []),
    steps: events.filter((event) => event.kind === "step").map(({ at, step, state, ms }) => ({ at, step, state, ms })),
  };
}

export async function currentRuleDetails(run: Evidence, findings: Finding[], project: string, root: string, wardenRoot: string, policyDir?: string) {
  const ids = recordedRuleIds(run, findings);
  if (ids.size === 0 || run.ruleDetails !== undefined) return undefined;

  try {
    const { config, packs } = await loadRecords(root, wardenRoot, undefined, policyDir);
    if (config.project !== project) return undefined;
    const details = describeRules(packs, ids);
    return Object.keys(details).length ? details : undefined;
  } catch (cause) {
    if (cause instanceof RecordError || ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((cause as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw cause;
  }
}

export function projectFailures(evidence: Evidence[], roots: string[]) {
  const fired = firedByRun(evidence);
  const runs = runRecords(evidence).filter((run) => {
    const root = sourceRoot(run);
    return root === undefined || roots.includes(root);
  });
  const included = new Set(runs);
  const open = new Map<string, CurrentFinding[]>();
  const audits = new Map<string, CurrentFinding[]>();
  const attempts = new Map<string, { run: Evidence; findingCount: number }>();
  const keyOf = (root: Source["root"], tier: Source["tier"], finding: Finding): string =>
    JSON.stringify([root, tier, findingKey(finding)]);

  for (const event of evidence) {
    if (event.kind === "resolved" && event.file !== undefined && event.guardrail !== undefined && event.sourceRun !== undefined) {
      const key = keyOf(event.root, event.tier, { file: event.file, guardrail: event.guardrail });
      const current = open.get(key)?.[0];
      if (current?.source.run === event.sourceRun && current.policy === event.policy) open.delete(key);
    }
    if (event.kind === "coverage") {
      const covered = new Set(event.members);
      for (const [key, [finding]] of open) {
        if (finding?.unverified && finding.source.root === event.root && finding.source.tier === event.tier && covered.has(finding.guardrail)) open.delete(key);
      }
    }
    if (!included.has(event) || event.outcome === "empty") continue;
    const source = sourceOf(event);
    const events = event.run === undefined ? [] : fired.get(event.run) ?? [];
    const findings = findingsOf(event, events);
    const scope = JSON.stringify([source.root, source.trigger, source.tier, source.ref]);
    attempts.set(scope, { run: event, findingCount: findings.length });

    if (event.outcome !== "ran") continue;
    if (audit(event)) {
      audits.set(scope, findings.map((finding) => ({ ...finding, source })));
      continue;
    }

    const policies = new Map(events.flatMap(({ file, guardrail, policy }) =>
      file === undefined || guardrail === undefined ? [] : [[findingKey({ file, guardrail }), policy] as const],
    ));
    const groups = new Map<string, CurrentFinding[]>();
    for (const finding of findings) {
      const key = keyOf(source.root, source.tier, finding);
      const group = groups.get(key) ?? [];
      const policy = policies.get(findingKey(finding));
      group.push({ ...finding, source, policy, ...(policy === undefined ? { unverified: true } : {}) });
      groups.set(key, group);
    }
    for (const [key, group] of groups) open.set(key, group);
  }

  const findings = [...open.values(), ...audits.values()].flat()
    .sort((a, b) => b.source.at.localeCompare(a.source.at))
    .map(({ policy: _policy, ...finding }) => finding);
  const problems = [...attempts.values()]
    .filter(({ run, findingCount }) => run.outcome !== "ran" || run.alert !== undefined || (run.result !== "pass" && findingCount === 0))
    .map(({ run }) => run)
    .sort((a, b) => b.at.localeCompare(a.at));
  return { checked: runs.length > 0, findings, problems };
}
