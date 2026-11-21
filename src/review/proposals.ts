import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../compiler/lock.js";
import { linkRecord, wardenHome } from "../runner/evidence.js";
import type { ReviewSeries } from "./history.js";

type Scope = Pick<ReviewSeries, "repository"> & Partial<Omit<ReviewSeries, "repository">>;

interface Proposal {
  action: string;
  practice: string;
  evidence: readonly unknown[];
}

export function recordProposals(scope: Scope, proposals: Proposal[]) {
  return proposals.map((proposal) => {
    const content = JSON.parse(JSON.stringify({ scope, proposal })) as { scope: Scope; proposal: Proposal };
    const id = sha256(canonicalJson(content));
    const path = join(wardenHome(), "review", "proposals", sha256(scope.repository), `${id}.json`);
    const record = { schema: 1, id, recordedAt: new Date().toISOString(), ...content };
    try {
      linkRecord(path, record);
      return record;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      try {
        const existing = JSON.parse(readFileSync(path, "utf8")) as typeof record;
        const { schema, id: saved, recordedAt, ...payload } = existing;
        if (schema === 1 && saved === id && Number.isFinite(Date.parse(recordedAt)) &&
            canonicalJson(payload) === canonicalJson(content)) return existing;
      } catch (error) {
        throw new Error(`Invalid proposal record at ${path}. Restore it from backup before recording proposals again.`, { cause: error });
      }
      throw new Error(`Invalid proposal record at ${path}. Restore it from backup before recording proposals again.`);
    }
  });
}
