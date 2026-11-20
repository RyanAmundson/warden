import { join } from "node:path";
import { runMutations } from "../compiler/examples.js";
import { LOCK_PATH, bundledTools, canonicalJson, readLock, sha256 } from "../compiler/lock.js";
import { RecordError, loadRecords } from "../records/load.js";
import { appendEvidence } from "../runner/evidence.js";
import { findTampering } from "../runner/tamper.js";
import { verifyCheckBase } from "./base.js";

export async function runMutationReview(
  root: string,
  wardenRoot: string,
  requestedBase: string,
  rule: string | undefined,
  format: "json" | "text",
): Promise<number> {
  const set = await loadRecords(root, wardenRoot);
  const base = verifyCheckBase(root, requestedBase, set.config.base);
  const assertPolicy = async () => {
    const current = await loadRecords(root, wardenRoot);
    const drift = await findTampering(current, wardenRoot, base, false);
    if (drift.length > 0) {
      throw new RecordError(join(root, LOCK_PATH), "", `Warden could not verify the policy (${drift[0]?.detail}). Next action: resolve the reported policy change with warden check --base ${base.name} --tier boundary before measuring mutations.`);
    }
    const lock = readLock(root);
    if (canonicalJson(lock.tools) !== canonicalJson(bundledTools())) {
      throw new RecordError(join(root, LOCK_PATH), "/tools", "The installed tools differ from the lock. Next action: compile with the installed Warden release and activate the updated policy before measuring mutations.");
    }
    return { records: current, policy: sha256(canonicalJson(lock)) };
  };
  const { records, policy } = await assertPolicy();
  const rows = await runMutations(records, rule);
  if (rows.length > 0 && (await assertPolicy()).policy !== policy) {
    throw new RecordError(join(root, LOCK_PATH), "", "The policy changed while the examples ran. Next action: measure the mutations again with the current policy.");
  }
  const at = new Date().toISOString();
  for (const { pack, guardrail, caught, missed } of rows) {
    appendEvidence(records.config.project, { at, kind: missed.length === 0 ? "mutation" : "hollow", root, pack, guardrail, policy, mutations: { caught, missed } });
  }
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) process.stdout.write("No enabled Guardrail declares must-fail variants.\n");
  for (const { pack, guardrail, caught, missed } of rows) {
    process.stdout.write(`${pack}/${guardrail} caught ${caught.length}/${caught.length + missed.length}${missed.length === 0 ? "" : `  missed ${missed.join(", ")}`}\n`);
  }
  if (rows.some(({ missed }) => missed.length > 0)) process.stdout.write("Next action: inspect the missed variants and confirm each one expresses the same required behavior.\n");
  return 0;
}
