import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { RecordError } from "../records/load.js";
const NEXT = ". Next action: update Claude Code, then retry the tool call";
const parseInput = (input) => {
    try {
        return (JSON.parse(input) ?? {});
    }
    catch {
        throw new RecordError("hook input", "", `is not JSON${NEXT}`);
    }
};
const real = (path) => (existsSync(path) ? realpathSync(path) : join(real(dirname(path)), basename(path)));
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
const CODEX_NEXT = ". Next action: update Codex, then retry the tool call";
const editedFiles = (parsed) => {
    if (parsed.tool_name !== "apply_patch") {
        const file = parsed.tool_input?.file_path;
        if (typeof file !== "string")
            throw new RecordError("hook input", "/tool_input/file_path", `is missing${NEXT}`);
        return [file];
    }
    const patch = parsed.tool_input?.command;
    if (typeof patch !== "string")
        throw new RecordError("hook input", "/tool_input/command", `is missing${CODEX_NEXT}`);
    const files = [...patch.matchAll(PATCH_FILE)].map((m) => m[1].trim());
    if (files.length === 0)
        throw new RecordError("hook input", "/tool_input/command", `names no file to patch${CODEX_NEXT}`);
    return files;
};
export const hookTriggers = (root, input) => editedFiles(parseInput(input)).map((file) => relative(root, real(resolve(root, file))));
const SEPARATORS = ";&|\n()`";
export function shellCommands(source) {
    const commands = [];
    let words = [];
    let word;
    const endWord = () => {
        if (word !== undefined)
            words.push(word);
        word = undefined;
    };
    const endCommand = () => {
        endWord();
        if (words.length > 0)
            commands.push(words);
        words = [];
    };
    for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (c === "\\") {
            if (source[i + 1] !== "\n")
                word = (word ?? "") + (source[i + 1] ?? "");
            i++;
        }
        else if (c === "'") {
            const end = source.indexOf("'", i + 1);
            const stop = end === -1 ? source.length : end;
            word = (word ?? "") + source.slice(i + 1, stop);
            i = stop;
        }
        else if (c === '"') {
            let depth = 0;
            let text = "";
            for (i++; i < source.length; i++) {
                const d = source[i];
                if (d === "\\")
                    text += source[++i] ?? "";
                else if (d === "$" && source[i + 1] === "(") {
                    depth++;
                    text += "$(";
                    i++;
                }
                else if (d === ")" && depth > 0) {
                    depth--;
                    text += d;
                }
                else if (d === '"' && depth === 0)
                    break;
                else
                    text += d;
            }
            word = (word ?? "") + text;
        }
        else if (c === "#" && word === undefined) {
            const end = source.indexOf("\n", i);
            i = end === -1 ? source.length : end - 1;
        }
        else if (c === " " || c === "\t")
            endWord();
        else if (SEPARATORS.includes(c))
            endCommand();
        else if (c === "$" && source[i + 1] === "(") {
            endCommand();
            i++;
        }
        else
            word = (word ?? "") + c;
    }
    endCommand();
    return commands;
}
const WRAPPERS = new Set(["env", "command", "exec", "nohup", "time", "sudo"]);
const GIT_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const COMMIT_VALUE_SHORT = new Set(["m", "F", "C", "c", "t"]);
const COMMIT_VALUE_LONG = new Set(["--message", "--file", "--author", "--date", "--reuse-message", "--reedit-message", "--fixup", "--squash", "--cleanup", "--template", "--trailer", "--pathspec-from-file"]);
export function skipsCommitHook(words) {
    let i = 0;
    while (i < words.length && (WRAPPERS.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])))
        i++;
    if (basename(words[i] ?? "") !== "git")
        return undefined;
    for (i++; i < words.length && words[i].startsWith("-"); i++)
        if (GIT_VALUE.has(words[i]))
            i++;
    if (words[i] !== "commit")
        return undefined;
    for (i++; i < words.length; i++) {
        const w = words[i];
        if (w === "--")
            return undefined;
        if (w.startsWith("--")) {
            const name = w.split("=")[0];
            if (name.length > "--no-".length && "--no-verify".startsWith(name))
                return w;
            if (COMMIT_VALUE_LONG.has(name) && !w.includes("="))
                i++;
        }
        else if (w.startsWith("-")) {
            for (let j = 1; j < w.length; j++) {
                if (w[j] === "n")
                    return w;
                if (w[j] === "u" || w[j] === "S")
                    break;
                if (COMMIT_VALUE_SHORT.has(w[j])) {
                    if (j === w.length - 1)
                        i++;
                    break;
                }
            }
        }
    }
    return undefined;
}
const withoutFlag = (flag) => flag.startsWith("--") || flag === "-n" ? `without ${flag}` : `with ${flag.replace("n", "")} in place of ${flag}`;
export function refusal(root, input) {
    const parsed = parseInput(input);
    if (parsed.tool_name === "Bash") {
        const command = parsed.tool_input?.command;
        if (typeof command !== "string")
            throw new RecordError("hook input", "/tool_input/command", `is missing${NEXT}`);
        for (const words of shellCommands(command)) {
            const flag = skipsCommitHook(words);
            if (flag !== undefined)
                return `${flag} skips the pre-commit hook that runs Warden's commit check. Next action: run the git commit again ${withoutFlag(flag)}.`;
        }
        return undefined;
    }
    if (!["Edit", "Write", "MultiEdit", "apply_patch"].includes(parsed.tool_name))
        return undefined;
    const file = hookTriggers(root, input).find((f) => f === ".warden" || f.startsWith(".warden/"));
    if (file === undefined)
        return undefined;
    return `${file} is a Warden record, and only a person changes Warden's records. Next action: tell the user what to change in ${file}, so they edit it and run warden compile.`;
}
