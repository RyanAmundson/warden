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
const FOLDER_SEGMENT = /^(?:[^*?{}[\]!\\]|\[\[\]|\])+$/;
export const literalOf = (glob) => {
    let out = "";
    for (let i = 0; i < glob.length; i++) {
        if (glob.startsWith("[[]", i)) {
            out += "[";
            i += 2;
        }
        else if ("*?{[!".includes(glob[i]))
            return out;
        else
            out += glob[i];
    }
    return out;
};
export const folderOf = (glob) => {
    if (!glob.endsWith("/**"))
        return undefined;
    const segments = glob.slice(0, -3).split("/");
    if (!segments.every((s) => s !== "." && s !== ".." && FOLDER_SEGMENT.test(s)))
        return undefined;
    return segments.map((s) => s.replaceAll("[[]", "[")).join("/");
};
export const backslashFix = (glob) => glob.replace(/\\([[\]])|\\/g, (_, c) => (c === "[" ? "[[]" : (c ?? "")));
