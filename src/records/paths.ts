import { matchesGlob } from "node:path";

export const pathGroups = (practicePaths: string[], configPaths: string[]): string[][] => {
  if (practicePaths.length === 0) return configPaths.map((c) => [c]);
  if (configPaths.length === 0) return practicePaths.map((p) => [p]);
  return practicePaths.flatMap((p) => configPaths.map((c) => [p, c]));
};

const matched = new Map<string, Map<string, boolean>>();

const matches = (file: string, glob: string): boolean => {
  const byFile = matched.get(glob) ?? new Map<string, boolean>();
  matched.set(glob, byFile);
  const known = byFile.get(file);
  if (known !== undefined) return known;
  const result = matchesGlob(file, glob);
  byFile.set(file, result);
  return result;
};

export const matchesPath = (file: string, glob: string): boolean => (glob.startsWith("!") ? !matches(file, glob.slice(1)) : matches(file, glob));

export const enabledOn = (file: string, groups: string[][]): boolean => groups.length === 0 || groups.some((g) => g.every((glob) => matchesPath(file, glob)));
