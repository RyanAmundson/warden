import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { commandOf, packDirs } from "../adapters/cmd.js";
import { COMMIT_HOOK } from "../compiler/emit.js";
import { TOOLS, firstLine } from "../compiler/lock.js";
import type { RecordSet } from "../records/types.js";

export interface DoctorResult {
  lines: string[];
  next: string | undefined;
}

interface Item {
  name: string;
  problem?: string;
  fix?: string;
}

const wardenRequire = createRequire(import.meta.url);

const executable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

const scriptsOf = (root: string): Record<string, unknown> => {
  const file = join(root, "package.json");
  if (!existsSync(file)) return {};
  return (JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
};

const SHELL_WORDS = new Set([
  "!", "{", "}", "[[", ".", ":", "[", "alias", "bg", "break", "case", "cd", "command", "continue", "declare", "do", "done", "echo", "elif", "else", "esac", "eval", "exec", "exit", "export", "false", "fg", "fi", "for", "function", "getopts", "hash", "if", "jobs", "kill", "let", "local", "printf", "pwd", "read", "readonly", "return", "select", "set", "shift", "source", "test", "then", "time", "times", "trap", "true", "type", "typeset", "ulimit", "umask", "unalias", "unset", "until", "wait", "while",
]);

const commandItem = (id: string, command: string, root: string, scripts: Record<string, unknown>): Item => {
  const name = `cmd ${id}: ${command}`;
  const words = command.trim().split(/\s+/);
  while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] as string)) words.shift();
  const word = words[0] as string;
  const rest = words.join(" ");
  const script = /^npm test(\s|$)/.test(rest) ? "test" : /^npm run ([^\s-]\S*)/.exec(rest)?.[1];
  if (word.includes("/")) {
    return executable(resolve(root, word)) ? { name } : { name, problem: `${word} is not an executable file in the project`, fix: `create ${word} as an executable file` };
  }
  if (SHELL_WORDS.has(word) || !/^[A-Za-z0-9_.+-]+$/.test(word)) return { name: `${name}  (shell)` };
  if (!(process.env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && executable(join(dir, word)))) {
    return { name, problem: `${word} is not on PATH`, fix: `install ${word} so it is on PATH` };
  }
  if (script !== undefined && !(script in scripts)) {
    return { name, problem: `package.json has no "${script}" script`, fix: `add a "${script}" script to package.json` };
  }
  return { name };
};

const toolItem = async (name: string, load: () => unknown): Promise<Item> => {
  try {
    await load();
    return { name: `tool ${name}` };
  } catch (cause) {
    return { name: `tool ${name}`, problem: firstLine((cause as Error).message), fix: `reinstall Warden so its bundled ${name} loads` };
  }
};

const hooksPath = (root: string): string | undefined => {
  const r = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
};

export const HOOKS_DIR = dirname(COMMIT_HOOK);

export const hooksDir = (root: string): string => resolve(root, execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: root, encoding: "utf8" }).trim());

export const hooksUnused = (root: string): boolean =>
  hooksPath(root) === undefined && (!existsSync(hooksDir(root)) || readdirSync(hooksDir(root)).every((f) => f.endsWith(".sample")));

const commitHookItem = (root: string): Item => {
  const name = `git pre-commit hook: ${COMMIT_HOOK}`;
  const dir = hooksDir(root);
  const chained = dir !== resolve(root, HOOKS_DIR);
  const preCommit = join(dir, "pre-commit");
  const shown = relative(root, preCommit).startsWith("..") ? preCommit : relative(root, preCommit);
  if (chained && !(existsSync(preCommit) && readFileSync(preCommit, "utf8").includes(COMMIT_HOOK))) {
    if (hooksUnused(root)) return { name, problem: "git runs no Warden commit check", fix: `run git config core.hooksPath ${HOOKS_DIR}` };
    return { name, problem: `git runs hooks from ${dirname(shown)}, and its pre-commit does not run Warden's`, fix: `make ${shown} an executable script that runs ${COMMIT_HOOK} and exits with its status` };
  }
  if (!executable(join(root, COMMIT_HOOK))) return { name, problem: "is not executable, so git skips it", fix: `run chmod +x ${COMMIT_HOOK}` };
  return { name };
};

export async function doctor(set: RecordSet, withCommitHook = false): Promise<DoctorResult> {
  const items: Item[] = [];
  for (const tool of TOOLS) items.push(await toolItem(tool, () => wardenRequire.resolve(tool)));
  items.push(await toolItem("warden eslint plugin", () => import("../../eslint-plugin/index.js")));
  const scripts = scriptsOf(set.root);
  const dirs = packDirs(set);
  for (const g of set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails))) {
    if (g.implementation.startsWith("cmd:")) items.push(commandItem(g.id, commandOf(g, dirs.get(g.id)), set.root, scripts));
  }
  if (withCommitHook) items.push(commitHookItem(set.root));
  const failed = items.find((i) => i.fix !== undefined);
  return {
    lines: items.map((i) => (i.problem === undefined ? `ok    ${i.name}` : `FAIL  ${i.name}  ${i.problem}`)),
    next: failed === undefined ? undefined : `${failed.fix as string}, then run warden doctor`,
  };
}

export const formatDoctor = ({ lines, next }: DoctorResult): string => [...lines, ...(next === undefined ? [] : [`Next action: ${next}`])].join("\n");
