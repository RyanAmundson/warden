import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { RecordError } from "../records/load.js";
import { wardenHome, writeAtomic } from "./evidence.js";

export interface WatchSettings {
  added: { project: string; root: string }[];
  paused: string[];
}

const settingsFile = (): string => join(wardenHome(), "daemon", "watch-settings.json");

export const isProjectName = (name: unknown): name is string =>
  typeof name === "string" && name.length > 0;

export function readWatchSettings(): WatchSettings {
  const file = settingsFile();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { added: [], paused: [] };
    throw cause;
  }
  let settings: Partial<WatchSettings> | null;
  const invalid = (): RecordError => new RecordError(file, "", "contains invalid watch settings. Next action: restore the last valid watch settings and restart the daemon");
  try {
    settings = JSON.parse(text) as Partial<WatchSettings> | null;
  } catch {
    throw invalid();
  }
  if (!settings || !Array.isArray(settings.added) || !Array.isArray(settings.paused) ||
      !settings.added.every((row) => row && isProjectName(row.project) && typeof row.root === "string" && isAbsolute(row.root)) ||
      !settings.paused.every(isProjectName)) throw invalid();
  return { added: settings.added, paused: settings.paused };
}

export const writeWatchSettings = (settings: WatchSettings): void => writeAtomic(settingsFile(), `${JSON.stringify(settings)}\n`);
