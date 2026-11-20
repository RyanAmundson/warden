import { existsSync } from "node:fs";
import { join } from "node:path";
import { expectedOutputs } from "../compiler/compile.js";
import { LOCK_PATH, canonicalJson, readLock, sha256 } from "../compiler/lock.js";
import { RecordError, loadRecords } from "../records/load.js";
import { listDisputeRulings } from "../runner/disputes.js";
import { type Evidence, readEvidence } from "../runner/evidence.js";
import { listRepositoryEscapeRounds, reviewHistoryState, reviewRepository } from "./history.js";

export async function learningScorecard(root: string, wardenRoot: string) {
  const set = await loadRecords(root, wardenRoot);
  const { project } = set.config;
  const resolved = new Map<string, Set<string>>();
  const stalls = new Map<string, Set<string>>();
  const upheld = new Map<string, number>();
  const escaped = new Map<string, number>();
  const recorded = readEvidence(project);
  const measurements = recorded.filter((event) =>
    (event.kind === "mutation" || event.kind === "hollow") && event.root === root && event.mutations !== undefined &&
    event.pack !== undefined && event.guardrail !== undefined);
  let currentPolicy: string | undefined;
  let mutationPolicyIssue: string | undefined;
  if (measurements.length > 0 && existsSync(join(root, LOCK_PATH))) {
    try {
      const actual = canonicalJson(readLock(root));
      const expected = await expectedOutputs(set, root, wardenRoot);
      if (actual === canonicalJson(expected.lock)) currentPolicy = sha256(actual);
    } catch (error) {
      if (!(error instanceof RecordError || error instanceof SyntaxError)) throw error;
      mutationPolicyIssue = error.message;
    }
  }
  const measuredGuardrails = new Set(measurements.map(({ pack, guardrail }) => JSON.stringify([pack, guardrail])));
  const strength = new Map<string, NonNullable<Evidence["mutations"]>>();
  for (const event of measurements) {
    if (currentPolicy !== undefined && event.policy === currentPolicy && event.mutations !== undefined) {
      strength.set(JSON.stringify([event.pack, event.guardrail]), event.mutations);
    }
  }
  for (const e of recorded) {
    if ((e.kind !== "resolved" && e.kind !== "stalled") || e.root !== root || e.guardrail === undefined || e.pack === undefined ||
        e.file === undefined || e.tier === undefined || e.sourceRun === undefined) continue;
    const key = JSON.stringify([e.pack, e.guardrail]);
    const evidence = e.kind === "resolved" ? resolved : stalls;
    const events = evidence.get(key) ?? new Set<string>();
    events.add(JSON.stringify([e.tier, e.sourceRun, e.file]));
    evidence.set(key, events);
  }
  for (const ruling of listDisputeRulings(project, root)) {
    if (ruling.status !== "upheld") continue;
    const key = JSON.stringify([ruling.pack, ruling.guardrail]);
    upheld.set(key, (upheld.get(key) ?? 0) + 1);
  }
  for (const round of listRepositoryEscapeRounds(reviewRepository(root))) {
    for (const { practice } of reviewHistoryState(round).escapes) {
      escaped.set(practice, (escaped.get(practice) ?? 0) + 1);
    }
  }
  return set.packs.flatMap((pack) => pack.practices.flatMap((practice) => practice.guardrails.map((guardrail) => {
    const key = JSON.stringify([pack.id, guardrail.id]);
    const resolutions = resolved.get(key)?.size ?? 0;
    const disputes = upheld.get(key) ?? 0;
    const total = resolutions + disputes;
    const measurement = strength.get(key);
    const variants = measurement === undefined ? 0 : measurement.caught.length + measurement.missed.length;
    return {
      pack: pack.id,
      practice: practice.id,
      guardrail: guardrail.id,
      resolved: resolutions,
      stalls: stalls.get(key)?.size ?? 0,
      upheldDisputes: disputes,
      precision: total === 0 ? null : resolutions / total,
      confirmedPracticeEscapes: escaped.get(practice.id) ?? 0,
      mutationStrength: measurement === undefined || variants === 0 ? null : measurement.caught.length / variants,
      ...(measurement === undefined ? {} : { mutations: measurement }),
      ...(mutationPolicyIssue !== undefined && measuredGuardrails.has(key) ? { mutationPolicyIssue } : {}),
    };
  })));
}
