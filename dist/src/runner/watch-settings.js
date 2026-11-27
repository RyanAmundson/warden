import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { RecordError } from "../records/load.js";
import { wardenHome, writeAtomic } from "./evidence.js";
const settingsFile = () => join(wardenHome(), "daemon", "watch-settings.json");
export const isProjectName = (name) => typeof name === "string" && name.length > 0;
export function readWatchSettings() {
    const file = settingsFile();
    let text;
    try {
        text = readFileSync(file, "utf8");
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return { added: [], paused: [] };
        throw cause;
    }
    let settings;
    const invalid = () => new RecordError(file, "", "contains invalid watch settings. Next action: restore the last valid watch settings and restart the daemon");
    try {
        settings = JSON.parse(text);
    }
    catch {
        throw invalid();
    }
    if (!settings || !Array.isArray(settings.added) || !Array.isArray(settings.paused) ||
        !settings.added.every((row) => row && isProjectName(row.project) && typeof row.root === "string" && isAbsolute(row.root)) ||
        !settings.paused.every(isProjectName))
        throw invalid();
    return { added: settings.added, paused: settings.paused };
}
export const writeWatchSettings = (settings) => writeAtomic(settingsFile(), `${JSON.stringify(settings)}\n`);
