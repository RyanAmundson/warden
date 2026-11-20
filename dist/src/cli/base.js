import { existsSync } from "node:fs";
import { join } from "node:path";
import { LOCK_PATH, readLock } from "../compiler/lock.js";
import { RecordError } from "../records/load.js";
import { checkBaseAction, containsHead, verifyBase } from "../runner/changed.js";
import { recordedBases } from "../runner/tamper.js";
const requireBase = (base, configured) => {
    if (base !== undefined)
        return base;
    throw new RecordError("", "/base", `--base is missing; Warden takes the base branch from the command, never from the editable config. Next action: run warden check --base ${configured}`);
};
const refuseOwnBranch = (root, comparison) => {
    if (!containsHead(root, comparison))
        return;
    const base = comparison.name;
    const recorded = recordedBases(root);
    if (recorded.every((b) => b === base))
        return;
    const original = recorded.at(-1);
    const working = existsSync(join(root, LOCK_PATH)) ? readLock(root).config?.base : undefined;
    if (original === base && working === base)
        return;
    const next = original === base
        ? `the lock's base changed in this branch's history and now reads ${working}. Next action: revert base in .warden/config.yaml to ${original} and run warden compile`
        : `the lock first recorded base ${original}. Next action: run warden check --base ${original}`;
    throw new RecordError("", "/base", `--base ${base} already contains this work, so the merge-base lock would compare with itself; ${next}`);
};
export function verifyCheckBase(root, requested, configured) {
    const comparison = verifyBase(root, requireBase(requested, configured), checkBaseAction);
    refuseOwnBranch(root, comparison);
    return comparison;
}
