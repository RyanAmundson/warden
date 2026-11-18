export const pathGroups = (practicePaths, configPaths) => {
    if (practicePaths.length === 0)
        return configPaths.map((c) => [c]);
    if (configPaths.length === 0)
        return practicePaths.map((p) => [p]);
    return practicePaths.flatMap((p) => configPaths.map((c) => [p, c]));
};
