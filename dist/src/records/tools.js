import { closeSync, constants, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";
import { RecordError } from "./load.js";
const safeName = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
const quoteName = (name) => safeName.test(name) ? name : "'" + name.replaceAll("'", "'\\''") + "'";
const pathPattern = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const relativePath = (file) => !/[\\:\p{Cc}]/u.test(file) && file.split("/").every((part) => part !== "" && part !== "." && part !== "..");
export const toolPath = (file) => pathPattern.test(file) && relativePath(file);
const commandOf = (folder, name) => `${folder === "." ? "npm" : `npm --prefix ${folder}`} run ${name.startsWith("-") ? "-- " : ""}${quoteName(name)}`;
export const normalToolCommand = (command) => command.replace(/^npm --prefix \.\//, "npm --prefix ");
const declared = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
export function declaredTools(file, text) {
    if (text === undefined)
        return [];
    const fail = (field) => {
        throw new RecordError(file, field, "Use an npm manifest with named scripts or a package-relative bin entry. Next action: correct the reported package.json declaration.");
    };
    let value;
    try {
        value = declared(JSON.parse(text));
    }
    catch {
        return fail("");
    }
    if (value === undefined)
        return fail("");
    const folder = posix.dirname(file);
    const scripts = value.scripts === undefined ? {} : declared(value.scripts) ?? fail("/scripts");
    const found = [];
    for (const [name, script] of Object.entries(scripts)) {
        if (name === "" || /[\p{Cc}]/u.test(name) || typeof script !== "string")
            return fail(`/scripts/${name}`);
        found.push({ kind: "script", name, command: commandOf(folder, name) });
    }
    const packageName = typeof value.name === "string" ? value.name.split("/").at(-1) : undefined;
    const bins = typeof value.bin === "string" && packageName !== undefined
        ? { [packageName]: value.bin }
        : value.bin === undefined ? {} : declared(value.bin) ?? fail("/bin");
    for (const [name, target] of Object.entries(bins)) {
        const local = typeof target === "string" ? target.replace(/^\.\//, "") : "";
        if (name === "" || !toolPath(local))
            return fail(`/bin/${name}`);
        found.push({ kind: "bin", name, file: posix.join(folder, local) });
    }
    return found;
}
export function toolFile(root, file) {
    if (!relativePath(file))
        return undefined;
    const path = join(realpathSync(root), file);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    return stat?.isFile() === true && realpathSync(path) === path ? { path, mode: stat.mode } : undefined;
}
export const LAUNCHER_HEADER_BYTES = 128;
const executable = (mode) => (mode & 0o111) !== 0;
const nodeFile = (file) => /\.[cm]?js$/.test(file);
export function launcherInterpreter(header) {
    const line = header.split("\n", 1)[0] ?? "";
    return /^#!\s*\/(?:usr\/bin\/env\s+(?:-S\s+)?|(?:usr\/)?bin\/)(node|sh|bash)(?:\s|$)/.exec(line)?.[1];
}
export function scriptCommand(root, file, npmBin = false) {
    const entry = toolFile(root, file);
    if (entry === undefined)
        return undefined;
    if (executable(entry.mode))
        return `./${file}`;
    const descriptor = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const header = Buffer.alloc(LAUNCHER_HEADER_BYTES);
        const length = readSync(descriptor, header, 0, header.length, 0);
        const shell = launcherInterpreter(header.toString("utf8", 0, length)) ?? (npmBin && nodeFile(file) ? "node" : undefined);
        return shell === undefined ? undefined : `${shell} ./${file}`;
    }
    finally {
        closeSync(descriptor);
    }
}
export function probeToolCommand(root, command) {
    const normalized = normalToolCommand(command);
    const script = /^npm(?: --prefix (\S+))? run .+$/.exec(normalized);
    if (script !== null) {
        const file = posix.join(script[1] ?? ".", "package.json");
        if (script[1] !== undefined && !toolPath(script[1]))
            return false;
        const manifest = toolFile(root, file);
        return manifest !== undefined && declaredTools(file, readFileSync(manifest.path, "utf8")).some((entry) => entry.kind === "script" && entry.command === normalized);
    }
    const direct = /^(?:(node|sh|bash) )?\.\/(\S+)$/.exec(command);
    if (direct === null)
        return false;
    const file = direct[2];
    if (!toolPath(file))
        return false;
    const entry = toolFile(root, file);
    if (entry === undefined)
        return false;
    if (direct[1] === undefined)
        return executable(entry.mode);
    if (direct[1] === "node" && nodeFile(file))
        return true;
    return scriptCommand(root, file) === command;
}
