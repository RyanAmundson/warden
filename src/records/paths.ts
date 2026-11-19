import { execFileSync } from "node:child_process";
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

const FOLDER_SEGMENT = /^(?:[^*?{}[\]!\\]|\[\[\]|\])+$/;

export const literalOf = (glob: string): string => {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith("[[]", i)) {
      out += "[";
      i += 2;
    } else if ("*?{[!".includes(glob[i] as string)) return out;
    else out += glob[i];
  }
  return out;
};

export const folderOf = (glob: string): string | undefined => {
  if (!glob.endsWith("/**")) return undefined;
  const segments = glob.slice(0, -3).split("/");
  if (!segments.every((s) => s !== "." && s !== ".." && FOLDER_SEGMENT.test(s))) return undefined;
  return segments.map((s) => s.replaceAll("[[]", "[")).join("/");
};

export const backslashFix = (glob: string): string => glob.replace(/\\([[\]])|\\/g, (_, c: string | undefined) => (c === "[" ? "[[]" : (c ?? "")));


export function ignoresPathCase(root: string): boolean {
  try {
    return execFileSync("git", ["config", "--bool", "--get", "core.ignorecase"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() === "true";
  } catch (cause) {
    if ((cause as { status?: number }).status === 1) return false;
    throw cause;
  }
}

export const pathCaseKey = (path: string, ignoreCase: boolean): string => ignoreCase ? path.normalize("NFC").toLowerCase() : path;
