import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { projectFiles } from "../runner/baseline.js";
import { matchesPath } from "./paths.js";
export async function loadUnits(set, wardenRoot) {
    const { units: declared, unitKinds } = set.config;
    if (declared !== undefined) {
        return declared.map((unit) => ({ ...unit, document: posix.join(unit.folder, unitKinds[unit.kind].document) }));
    }
    const architecture = set.config.packs.find((pack) => pack.id === "architecture");
    const collections = (architecture?.settings?.groupCollections ?? []);
    if (architecture === undefined || collections.length === 0)
        return [];
    const { groupsIn, kebab } = await import(pathToFileURL(join(wardenRoot, "packs/architecture/fs.js")).href);
    const files = projectFiles(set.root, ["**"]);
    const inScope = (file) => architecture.paths.length === 0 || architecture.paths.some((glob) => matchesPath(file, glob));
    const terms = new Map(set.packs.flatMap((pack) => pack.terms.map(({ id }) => [kebab(id), id])));
    const units = new Map();
    for (const collection of collections) {
        for (const group of groupsIn(files, { groupCollections: [collection] }, { allAncestors: true })) {
            if (units.has(group.dir) || (!inScope(group.port) && !group.files.some(inScope)))
                continue;
            const term = group.term === undefined ? undefined : terms.get(group.term);
            units.set(group.dir, { id: group.name, kind: collection.collection, folder: group.dir, document: `${group.dir}/CONTRACT.md`, ...(term === undefined ? {} : { term }) });
        }
    }
    return [...units.values()];
}
