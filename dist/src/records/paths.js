import { matchesGlob } from "node:path";
export const pathGroups = (practicePaths, configPaths) => {
    if (practicePaths.length === 0)
        return configPaths.map((c) => [c]);
    if (configPaths.length === 0)
        return practicePaths.map((p) => [p]);
    return practicePaths.flatMap((p) => configPaths.map((c) => [p, c]));
};
export const matchesPath = (file, glob) => (glob.startsWith("!") ? !matchesGlob(file, glob.slice(1)) : matchesGlob(file, glob));
export const enabledOn = (file, groups) => groups.length === 0 || groups.some((g) => g.every((glob) => matchesPath(file, glob)));
