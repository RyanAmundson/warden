import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join, resolve } from "node:path";
import { commandOf, packDirs, withPackDir } from "../adapters/cmd.js";
import { TOOLS, firstLine } from "../compiler/lock.js";
const wardenRequire = createRequire(import.meta.url);
const executable = (file) => {
    try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
    }
    catch {
        return false;
    }
};
const scriptsOf = (root) => {
    const file = join(root, "package.json");
    if (!existsSync(file))
        return {};
    return JSON.parse(readFileSync(file, "utf8")).scripts ?? {};
};
const SHELL_WORDS = new Set([
    "!", "{", "}", "[[", ".", ":", "[", "alias", "bg", "break", "case", "cd", "command", "continue", "declare", "do", "done", "echo", "elif", "else", "esac", "eval", "exec", "exit", "export", "false", "fg", "fi", "for", "function", "getopts", "hash", "if", "jobs", "kill", "let", "local", "printf", "pwd", "read", "readonly", "return", "select", "set", "shift", "source", "test", "then", "time", "times", "trap", "true", "type", "typeset", "ulimit", "umask", "unalias", "unset", "until", "wait", "while",
]);
const commandItem = (id, command, root, scripts, packDir) => {
    const name = `cmd ${id}: ${command}`;
    const raw = command.trim().split(/\s+/);
    const words = raw.map((w) => {
        const expanded = withPackDir(w, packDir ?? "");
        return expanded === w ? w : expanded.slice(expanded.indexOf(packDir ?? "")).replace(/["']/g, "").replace(/;+$/, "");
    });
    const absent = words.find((w, i) => w !== raw[i] && !existsSync(w));
    if (absent !== undefined)
        return { name, problem: `${absent} does not exist in the pack`, fix: `create ${absent}` };
    while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))
        words.shift();
    const word = words[0];
    const rest = words.join(" ");
    const script = /^npm test(\s|$)/.test(rest) ? "test" : /^npm run ([^\s-]\S*)/.exec(rest)?.[1];
    if (word.includes("/")) {
        return executable(resolve(root, word)) ? { name } : { name, problem: `${word} is not an executable file in the project`, fix: `create ${word} as an executable file` };
    }
    if (SHELL_WORDS.has(word) || !/^[A-Za-z0-9_.+-]+$/.test(word))
        return { name: `${name}  (shell)` };
    if (!(process.env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && executable(join(dir, word)))) {
        return { name, problem: `${word} is not on PATH`, fix: `install ${word} so it is on PATH` };
    }
    if (script !== undefined && !(script in scripts)) {
        return { name, problem: `package.json has no "${script}" script`, fix: `add a "${script}" script to package.json` };
    }
    return { name };
};
const toolItem = async (name, load) => {
    try {
        await load();
        return { name: `tool ${name}` };
    }
    catch (cause) {
        return { name: `tool ${name}`, problem: firstLine(cause.message), fix: `reinstall Warden so its bundled ${name} loads` };
    }
};
export async function doctor(set) {
    const items = [];
    for (const tool of TOOLS)
        items.push(await toolItem(tool, () => wardenRequire.resolve(tool)));
    items.push(await toolItem("warden eslint plugin", () => import("../../eslint-plugin/index.js")));
    const scripts = scriptsOf(set.root);
    const dirs = packDirs(set);
    for (const g of set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails))) {
        if (g.implementation.startsWith("cmd:"))
            items.push(commandItem(g.id, commandOf(g, dirs.get(g.id)), set.root, scripts, g.packDir));
    }
    const failed = items.find((i) => i.fix !== undefined);
    return {
        lines: items.map((i) => (i.problem === undefined ? `ok    ${i.name}` : `FAIL  ${i.name}  ${i.problem}`)),
        next: failed === undefined ? undefined : `${failed.fix}, then run warden doctor`,
    };
}
export const formatDoctor = ({ lines, next }) => [...lines, ...(next === undefined ? [] : [`Next action: ${next}`])].join("\n");
