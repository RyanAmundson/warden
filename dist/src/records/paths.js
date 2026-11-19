import { matchesGlob } from "node:path";
export const pathGroups = (practicePaths, configPaths) => {
    if (practicePaths.length === 0)
        return configPaths.map((c) => [c]);
    if (configPaths.length === 0)
        return practicePaths.map((p) => [p]);
    return practicePaths.flatMap((p) => configPaths.map((c) => [p, c]));
};
const matched = new Map();
const matches = (file, glob) => {
    const byFile = matched.get(glob) ?? new Map();
    matched.set(glob, byFile);
    const known = byFile.get(file);
    if (known !== undefined)
        return known;
    const result = matchesGlob(file, glob);
    byFile.set(file, result);
    return result;
};
export const matchesPath = (file, glob) => (glob.startsWith("!") ? !matches(file, glob.slice(1)) : matches(file, glob));
export const enabledOn = (file, groups) => groups.length === 0 || groups.some((g) => g.every((glob) => matchesPath(file, glob)));
