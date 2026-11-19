import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadRecords } from "../records/load.js";
import { pathCaseKey } from "../records/paths.js";
import { loadUnits } from "../records/units.js";
const relativeWithin = (root, path) => {
    const projectPath = relative(root, path).split(sep).join("/");
    return isAbsolute(projectPath) || projectPath === ".." || projectPath.startsWith("../") ? undefined : projectPath;
};
const unitPath = (root, query) => {
    const path = resolve(query);
    const direct = relativeWithin(root, path);
    if (direct !== undefined)
        return direct;
    const suffix = [];
    let prefix = path;
    for (;;) {
        try {
            return relativeWithin(root, join(realpathSync(prefix), ...suffix));
        }
        catch (cause) {
            const { code } = cause;
            if (code !== "ENOENT" && code !== "ENOTDIR")
                throw cause;
            const parent = dirname(prefix);
            if (parent === prefix)
                return undefined;
            suffix.unshift(basename(prefix));
            prefix = parent;
        }
    }
};
export async function runWhere(root, wardenRoot, query) {
    const records = await loadRecords(root, wardenRoot);
    const units = await loadUnits(records, wardenRoot);
    const named = units.filter((unit) => unit.id === query || unit.term === query);
    if (named.length > 1) {
        process.stderr.write(`More than one Unit matches ${query}. Next action: run warden where with a path under one of these folders: ${named.map(({ folder }) => folder).sort().join(", ")}.\n`);
        return 2;
    }
    const projectPath = named.length === 0 ? unitPath(root, query) : undefined;
    const ownershipKey = (path) => pathCaseKey(path, records.unitIgnoreCase === true);
    const pathKey = projectPath === undefined ? undefined : ownershipKey(projectPath);
    const unit = named[0] ?? (pathKey !== undefined ? units
        .filter(({ folder }) => {
        if (folder === ".")
            return true;
        const key = ownershipKey(folder);
        return pathKey === key || pathKey.startsWith(`${key}/`);
    })
        .sort((a, b) => b.folder.length - a.folder.length)[0] : undefined);
    process.stdout.write(unit === undefined ? `No Unit for ${query}.\n` : `${unit.id}\t${unit.document}\n`);
    return 0;
}
