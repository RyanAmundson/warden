import { join } from "node:path";
import { unmappedFlag } from "../adapters/tsc.js";
import { ESLINT_PASS, RUN_TOTAL } from "../runner/evidence.js";
import { folderOf } from "../records/paths.js";
const CODES = [
    "duplicate-term",
    "duplicate-practice",
    "duplicate-guardrail",
    "reserved-id",
    "cmd-lint",
    "unmapped-tsc-flag",
    "prose-only",
    "conflict-overlap",
    "conflict-scope",
    "conflict-same-pack",
    "undefined-conflict",
    "undefined-term",
    "banned-synonym",
    "layer-order",
];
const contains = (outer, inner) => inner === outer || inner.startsWith(`${outer}/`);
const overlaps = (a, b) => contains(a, b) || contains(b, a);
const packPaths = (set, pack) => set.config.packs.find((p) => p.id === pack)?.paths ?? [];
const effectiveFolders = (set, practice) => {
    const packFolders = packPaths(set, practice.pack).flatMap((g) => folderOf(g) ?? []);
    if (practice.paths.length === 0)
        return packFolders;
    return packFolders.flatMap((f) => practice.paths.flatMap((p) => {
        const g = folderOf(p);
        if (g === undefined)
            return [f];
        return contains(f, g) ? [g] : contains(g, f) ? [f] : [];
    }));
};
const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const duplicates = (ids) => ids.filter((id, i) => ids.indexOf(id) !== i);
export function checkConsistency(set, elsewhere = new Map()) {
    const findings = [];
    const add = (code, record, message) => {
        findings.push({ code, record, message });
    };
    const terms = set.packs.flatMap((p) => p.terms);
    const practices = set.packs.flatMap((p) => p.practices);
    const guardrails = practices.flatMap((p) => p.guardrails);
    for (const id of duplicates(terms.map((t) => t.id)))
        add("duplicate-term", id, `Term ${id} is defined more than once.`);
    for (const id of duplicates(practices.map((p) => p.id)))
        add("duplicate-practice", id, `Practice ${id} is defined more than once.`);
    for (const id of duplicates(guardrails.map((g) => g.id)))
        add("duplicate-guardrail", id, `Guardrail ${id} is defined more than once.`);
    for (const pack of set.packs) {
        for (const g of pack.practices.flatMap((p) => p.guardrails)) {
            if (g.id === RUN_TOTAL || g.id === ESLINT_PASS) {
                add("reserved-id", g.id, `Guardrail id ${g.id} is reserved for Warden's own cost and scaling rows. Next action: rename Guardrail ${g.id} in ${pack.file}, then run warden compile.`);
            }
            const unmapped = unmappedFlag(g);
            if (unmapped !== undefined)
                add("unmapped-tsc-flag", g.id, `Guardrail ${g.id} in ${pack.file}: ${unmapped}`);
        }
        for (const g of pack.practices.flatMap((p) => p.guardrails)) {
            if (g.kind === "lint" && g.implementation.startsWith("cmd:")) {
                add("cmd-lint", g.id, `Guardrail ${g.id} has kind lint but runs a cmd command, whose one project-wide result warden check never reports as a lint failure. Next action: set kind to runtime on Guardrail ${g.id} in ${pack.file}, then run warden compile.`);
            }
        }
        for (const p of pack.practices) {
            if (!p.guardrails.some((g) => g.kind !== "instruction")) {
                add("prose-only", p.id, `Practice ${p.id} has no Guardrail that a tool enforces. Next action: add a Guardrail whose kind is not instruction, with mustFail and mustPass examples, to Practice ${p.id} in ${pack.file}, then run warden compile.`);
            }
        }
    }
    const byId = new Map(practices.map((p) => [p.id, p]));
    const config = join(set.root, ".warden", "config.yaml");
    const scoped = new Set();
    const checkScope = (packId, p, q) => {
        if (scoped.has(packId))
            return;
        scoped.add(packId);
        const paths = packPaths(set, packId);
        const why = `and Practice ${p} conflicts with ${q}, so its paths must be folder scopes.`;
        if (paths.length === 0) {
            add("conflict-scope", packId, `Pack ${packId} has no paths in ${config}, ${why} Next action: add a folder scope such as src/** to the paths of pack ${packId} in ${config}, then run warden compile.`);
        }
        for (const glob of paths.filter((g) => folderOf(g) === undefined)) {
            add("conflict-scope", packId, `Pack ${packId} has path ${glob} in ${config}, ${why} Next action: replace ${glob} in the paths of pack ${packId} in ${config} with folder scopes such as src/ui/**, then run warden compile.`);
        }
    };
    const seen = new Set();
    for (const p of practices) {
        for (const otherId of p.conflictsWith) {
            checkScope(p.pack, p.id, otherId);
            const other = byId.get(otherId);
            const key = [p.id, otherId].sort().join("\0");
            if (!other) {
                if (elsewhere.has(otherId))
                    continue;
                const file = set.packs.find((pack) => pack.id === p.pack)?.file;
                add("undefined-conflict", p.id, `Practice ${p.id} conflicts with ${otherId}, which no pack defines. Next action: remove ${otherId} from conflictsWith of Practice ${p.id} in ${file}, then run warden compile.`);
                continue;
            }
            checkScope(other.pack, p.id, otherId);
            if (seen.has(key))
                continue;
            seen.add(key);
            const [first, second] = p.id < otherId ? [p, other] : [other, p];
            if (first.pack === second.pack) {
                const file = set.packs.find((pack) => pack.id === first.pack)?.file;
                add("conflict-same-pack", first.id, `Practices ${first.id} and ${second.id} are both in pack ${first.pack} and conflict, so the pack contradicts itself. Next action: remove the conflictsWith entries between Practices ${first.id} and ${second.id} in ${file}, or move one of them into its own pack, then run warden compile.`);
                continue;
            }
            const right = effectiveFolders(set, second);
            const pair = effectiveFolders(set, first).flatMap((a) => right.filter((b) => overlaps(a, b)).map((b) => [a, b]))[0];
            if (pair) {
                add("conflict-overlap", first.id, `Practices ${first.id} and ${second.id} conflict and both apply under ${pair[0]} and ${pair[1]}. Next action: change the paths of pack ${second.pack} in ${config} so that no folder contains or is inside ${pair[0]}, then run warden compile.`);
            }
        }
    }
    const termIds = new Set(terms.map((t) => t.id));
    for (const p of practices) {
        for (const t of p.terms) {
            if (!termIds.has(t))
                add("undefined-term", p.id, `Practice ${p.id} names Term ${t}, which is not defined. Next action: enable the pack that defines Term ${t} before pack ${p.pack} in .warden/config.yaml, then run warden compile.`);
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
    let free = Math.max(...set.packs.map((p) => p.layer));
    for (const pack of set.packs) {
        const first = set.packs.find((p) => p.layer === pack.layer);
        if (first === pack)
            continue;
        const local = (p) => p.file.startsWith(join(set.root, ".warden"));
        const [keep, move] = local(first) && !local(pack) ? [pack, first] : [first, pack];
        add("layer-order", move.id, `Packs ${keep.id} and ${move.id} both have layer ${pack.layer}. Next action: set layer to ${++free} in ${move.file}, then run warden compile.`);
    }
    return findings.sort((a, b) => CODES.indexOf(a.code) - CODES.indexOf(b.code) || (a.record < b.record ? -1 : a.record > b.record ? 1 : 0));
}
