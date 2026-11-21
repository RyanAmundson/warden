import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../compiler/lock.js";
import { linkRecord, wardenHome } from "../runner/evidence.js";
export function recordProposals(scope, proposals) {
    return proposals.map((proposal) => {
        const content = JSON.parse(JSON.stringify({ scope, proposal }));
        const id = sha256(canonicalJson(content));
        const path = join(wardenHome(), "review", "proposals", sha256(scope.repository), `${id}.json`);
        const record = { schema: 1, id, recordedAt: new Date().toISOString(), ...content };
        try {
            linkRecord(path, record);
            return record;
        }
        catch (cause) {
            if (cause.code !== "EEXIST")
                throw cause;
            try {
                const existing = JSON.parse(readFileSync(path, "utf8"));
                const { schema, id: saved, recordedAt, ...payload } = existing;
                if (schema === 1 && saved === id && Number.isFinite(Date.parse(recordedAt)) &&
                    canonicalJson(payload) === canonicalJson(content))
                    return existing;
            }
            catch (error) {
                throw new Error(`Invalid proposal record at ${path}. Restore it from backup before recording proposals again.`, { cause: error });
            }
            throw new Error(`Invalid proposal record at ${path}. Restore it from backup before recording proposals again.`);
        }
    });
}
