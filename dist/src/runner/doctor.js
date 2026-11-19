import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { RecordError } from "../records/load.js";
import { PACK_VAR, brief } from "../adapters/cmd.js";
import { targetOf } from "../adapters/pack-code.js";
import { COMMIT_HOOK } from "../compiler/emit.js";
import { TOOLS, firstLine, scriptsOf } from "../compiler/lock.js";
import { skillPath, SKILLS_DIR } from "../compiler/skills.js";
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
const SHELL_WORDS = new Set([
    "!", "{", "}", "[[", ".", ":", "[", "alias", "bg", "break", "case", "cd", "command", "continue", "declare", "do", "done", "echo", "elif", "else", "esac", "eval", "exec", "exit", "export", "false", "fg", "fi", "for", "function", "getopts", "hash", "if", "jobs", "kill", "let", "local", "printf", "pwd", "read", "readonly", "return", "select", "set", "shift", "source", "test", "then", "time", "times", "trap", "true", "type", "typeset", "ulimit", "umask", "unalias", "unset", "until", "wait", "while",
]);
const commandItem = (id, command, root, scripts, packDir) => {
    const name = `cmd ${id}: ${brief(command)}`;
    const raw = command.trim().split(/\s+/);
    const words = raw.map((w) => {
        const expanded = packDir === undefined ? w : w.replace(PACK_VAR, () => packDir);
        return expanded === w ? w : expanded.slice(expanded.indexOf(packDir)).replace(/["']/g, "").replace(/;+$/, "");
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
const real = (file) => {
    try {
        return realpathSync(file);
    }
    catch {
        return undefined;
    }
};
const skillItem = (id, root) => {
    const link = `.claude/skills/${id}`;
    const target = real(join(root, SKILLS_DIR, id));
    if (target === undefined || !existsSync(join(root, skillPath(id))))
        return { name: `skill ${id}`, problem: `${skillPath(id)} does not exist`, fix: "run warden compile" };
    if (real(join(root, link)) === target)
        return { name: `skill ${id}` };
    const entry = lstatSync(join(root, link), { throwIfNoEntry: false });
    const prepare = entry?.isSymbolicLink() === true ? `run unlink ${link} && ` : entry === undefined ? "run " : `move ${link} to a different path, then run `;
    return { name: `skill ${id}`, problem: `${link} does not link to ${SKILLS_DIR}/${id}, so Claude Code cannot load the skill`, fix: `${prepare}mkdir -p .claude/skills && ln -s ../../${SKILLS_DIR}/${id} ${link}` };
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
const PLUGIN = "warden@warden";
export const PLUGIN_SETUP = `run claude plugin marketplace add RyanAmundson/warden, then claude plugin install ${PLUGIN}`;
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const settingsOf = (file) => {
    if (!existsSync(file))
        return undefined;
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch (cause) {
        throw new RecordError(file, "", `is not valid JSON (${cause.message}). Next action: fix the JSON in ${file}`);
    }
};
export const pluginAction = (p) => (p.state === "disabled" ? `set enabledPlugins "${PLUGIN}" to true in ${p.file}` : PLUGIN_SETUP);
export function pluginState(root) {
    let found = { state: "missing", file: join(claudeDir(), "settings.json") };
    for (const file of [join(claudeDir(), "settings.json"), join(root, ".claude/settings.json"), join(root, ".claude/settings.local.json")]) {
        const value = settingsOf(file)?.enabledPlugins?.[PLUGIN];
        if (value !== undefined)
            found = { state: value === true ? "enabled" : "disabled", file };
    }
    return found;
}
const hooksPath = (root) => {
    const r = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : undefined;
};
export const HOOKS_DIR = dirname(COMMIT_HOOK);
export const hooksDir = (root) => resolve(root, execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: root, encoding: "utf8" }).trim());
export const hooksUnused = (root) => hooksPath(root) === undefined && (!existsSync(hooksDir(root)) || readdirSync(hooksDir(root)).every((f) => f.endsWith(".sample")));
export const commitHookItem = (root) => {
    const name = `git pre-commit hook: ${COMMIT_HOOK}`;
    const dir = hooksDir(root);
    const chained = dir !== resolve(root, HOOKS_DIR);
    const preCommit = join(dir, "pre-commit");
    const shown = relative(root, preCommit).startsWith("..") ? preCommit : relative(root, preCommit);
    if (chained && !(existsSync(preCommit) && readFileSync(preCommit, "utf8").includes(COMMIT_HOOK))) {
        if (hooksUnused(root))
            return { name, problem: "git runs no Warden commit check", fix: `run git config core.hooksPath ${HOOKS_DIR}` };
        return { name, problem: `git runs hooks from ${dirname(shown)}, and its pre-commit does not run Warden's`, fix: `make ${shown} an executable script that runs ${COMMIT_HOOK} and exits with its status` };
    }
    if (!executable(join(root, COMMIT_HOOK)))
        return { name, problem: "is not executable, so git skips it", fix: `run chmod +x ${COMMIT_HOOK}` };
    return { name };
};
export async function doctor(set, explicit = false) {
    const items = [];
    for (const tool of TOOLS)
        items.push(await toolItem(tool, () => wardenRequire.resolve(tool)));
    items.push(await toolItem("warden eslint plugin", () => import("../../eslint-plugin/index.js")));
    const scripts = scriptsOf(set.root);
    for (const g of set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails))) {
        if (g.implementation.startsWith("cmd:"))
            items.push(commandItem(g.id, targetOf(g), set.root, scripts, g.packDir));
    }
    if (explicit) {
        for (const c of set.packs.flatMap((p) => p.capabilities))
            if (c.kind === "skill")
                items.push(skillItem(c.id, set.root));
        items.push(commitHookItem(set.root));
    }
    const plugin = explicit ? pluginState(set.root) : undefined;
    const note = plugin === undefined || plugin.state === "enabled" ? [] : [`note  Claude plugin ${PLUGIN} is ${plugin.state === "missing" ? "not installed" : `disabled in ${plugin.file}`}, so Claude Code edits are not checked; to check them, ${pluginAction(plugin)}`];
    const failed = items.find((i) => i.fix !== undefined);
    return {
        lines: [...items.map((i) => (i.problem === undefined ? `ok    ${i.name}` : `FAIL  ${i.name}  ${i.problem}`)), ...note],
        next: failed === undefined ? undefined : `${failed.fix}, then run warden doctor`,
    };
}
export const formatDoctor = ({ lines, next }) => [...lines, ...(next === undefined ? [] : [`Next action: ${next}`])].join("\n");
