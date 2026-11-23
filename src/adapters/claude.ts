import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { COMMAND_REPLACEMENTS, literalCommand } from "../compiler/emit.js";
import { LOCK_PATH, readLock, sha256 } from "../compiler/lock.js";
import type { CommandReplacement } from "../compiler/skills.js";
import { RecordError } from "../records/load.js";
import { appendEvidence } from "../runner/evidence.js";

const NEXT = ". Next action: update Claude Code, then retry the tool call";

interface HookInput {
  hook_event_name?: unknown;
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: { file_path?: unknown; command?: unknown };
}

const parseInput = (input: string): HookInput => {
  try {
    return (JSON.parse(input) ?? {}) as HookInput;
  } catch {
    throw new RecordError("hook input", "", `is not JSON${NEXT}`);
  }
};

export function claudeSession(input: string, event: "PostToolUse" | "SessionEnd"): string | undefined {
  const payload = parseInput(input);
  if (payload.hook_event_name !== event || payload.tool_name === "apply_patch") return undefined;
  const { session_id: session } = payload;
  return typeof session === "string" && session.trim() !== "" && session.length <= 200 ? session : undefined;
}

const real = (path: string): string => (existsSync(path) ? realpathSync(path) : join(real(dirname(path)), basename(path)));

const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
const CODEX_NEXT = ". Next action: update Codex, then retry the tool call";

const editedFiles = (parsed: HookInput): string[] => {
  if (parsed.tool_name !== "apply_patch") {
    const file = parsed.tool_input?.file_path;
    if (typeof file !== "string") throw new RecordError("hook input", "/tool_input/file_path", `is missing${NEXT}`);
    return [file];
  }
  const patch = parsed.tool_input?.command;
  if (typeof patch !== "string") throw new RecordError("hook input", "/tool_input/command", `is missing${CODEX_NEXT}`);
  const files = [...patch.matchAll(PATCH_FILE)].map((m) => (m[1] as string).trim());
  if (files.length === 0) throw new RecordError("hook input", "/tool_input/command", `names no file to patch${CODEX_NEXT}`);
  return files;
};

export const hookTriggers = (root: string, input: string): string[] =>
  editedFiles(parseInput(input)).map((file) => relative(root, real(resolve(root, file))));

const SEPARATORS = ";&|\n()`";

export function shellCommands(source: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word: string | undefined;
  const endWord = (): void => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string;
    if (c === "\\") {
      if (source[i + 1] !== "\n") word = (word ?? "") + (source[i + 1] ?? "");
      i++;
    } else if (c === "'") {
      const end = source.indexOf("'", i + 1);
      const stop = end === -1 ? source.length : end;
      word = (word ?? "") + source.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      let depth = 0;
      let text = "";
      for (i++; i < source.length; i++) {
        const d = source[i] as string;
        if (d === "\\") text += source[++i] ?? "";
        else if (d === "$" && source[i + 1] === "(") {
          depth++;
          text += "$(";
          i++;
        } else if (d === ")" && depth > 0) {
          depth--;
          text += d;
        } else if (d === '"' && depth === 0) break;
        else text += d;
      }
      word = (word ?? "") + text;
    } else if (c === "#" && word === undefined) {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end - 1;
    } else if (c === " " || c === "\t") endWord();
    else if (SEPARATORS.includes(c)) endCommand();
    else if (c === "$" && source[i + 1] === "(") {
      endCommand();
      i++;
    } else word = (word ?? "") + c;
  }
  endCommand();
  return commands;
}

const WRAPPERS = new Set(["env", "command", "exec", "nohup", "time", "sudo"]);
const GIT_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const COMMIT_VALUE_SHORT = new Set(["m", "F", "C", "c", "t"]);
const COMMIT_VALUE_LONG = new Set(["--message", "--file", "--author", "--date", "--reuse-message", "--reedit-message", "--fixup", "--squash", "--cleanup", "--template", "--trailer", "--pathspec-from-file"]);

export function skipsCommitHook(words: string[]): string | undefined {
  let i = 0;
  while (i < words.length && (WRAPPERS.has(words[i] as string) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string))) i++;
  if (basename(words[i] ?? "") !== "git") return undefined;
  for (i++; i < words.length && (words[i] as string).startsWith("-"); i++) if (GIT_VALUE.has(words[i] as string)) i++;
  if (words[i] !== "commit") return undefined;
  for (i++; i < words.length; i++) {
    const w = words[i] as string;
    if (w === "--") return undefined;
    if (w.startsWith("--")) {
      const name = w.split("=")[0] as string;
      if (name.length > "--no-".length && "--no-verify".startsWith(name)) return w;
      if (COMMIT_VALUE_LONG.has(name) && !w.includes("=")) i++;
    } else if (w.startsWith("-")) {
      for (let j = 1; j < w.length; j++) {
        if (w[j] === "n") return w;
        if (w[j] === "u" || w[j] === "S") break;
        if (COMMIT_VALUE_SHORT.has(w[j] as string)) {
          if (j === w.length - 1) i++;
          break;
        }
      }
    }
  }
  return undefined;
}

const withoutFlag = (flag: string): string =>
  flag.startsWith("--") || flag === "-n" ? `without ${flag}` : `with ${flag.replace("n", "")} in place of ${flag}`;

const optionalText = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
};

const replacementRefusal = (root: string, source: string, required: boolean): string | undefined => {
  const command = literalCommand(source);
  if (command === "warden compile") return undefined;
  const file = join(root, COMMAND_REPLACEMENTS);
  const text = optionalText(file);
  const drift = (): RecordError => new RecordError(file, "", "Command replacements differ from the compiled lock. Next action: ask the user to restore the generated policy or run warden compile.");
  if (text === undefined) {
    const lockText = optionalText(join(root, LOCK_PATH));
    if (required || (lockText?.includes(JSON.stringify(COMMAND_REPLACEMENTS)) === true && readLock(root).generated?.[COMMAND_REPLACEMENTS] !== undefined)) throw drift();
    return undefined;
  }
  const lock = readLock(root);
  const project = lock.config?.project;
  if (lock.generated?.[COMMAND_REPLACEMENTS] !== sha256(text) || typeof project !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project)) throw drift();
  const { replacements } = JSON.parse(text) as { replacements: CommandReplacement[] };
  const rule = replacements.find((entry) => entry.command === command);
  if (rule === undefined) return undefined;
  const next = `use the registered Capability, starting with ${rule.replacement}.`;
  appendEvidence(project, { at: new Date().toISOString(), kind: "tampered", root, detail: `capability-replacement:${rule.capability}`, next });
  return `${rule.command} is replaced by Capability ${rule.capability}. Next action: ${next}`;
};

export function refusal(root: string, input: string, requireReplacements = false): string | undefined {
  const parsed = parseInput(input);
  if (parsed.tool_name === "Bash") {
    const command = parsed.tool_input?.command;
    if (typeof command !== "string") throw new RecordError("hook input", "/tool_input/command", `is missing${NEXT}`);
    for (const words of shellCommands(command)) {
      const flag = skipsCommitHook(words);
      if (flag !== undefined) return `${flag} skips the pre-commit hook that runs Warden's commit check. Next action: run the git commit again ${withoutFlag(flag)}.`;
    }
    return replacementRefusal(root, command, requireReplacements);
  }
  if (!["Edit", "Write", "MultiEdit", "apply_patch"].includes(parsed.tool_name as string)) return undefined;
  const file = hookTriggers(root, input).find((f) => f === ".warden" || f.startsWith(".warden/"));
  if (file === undefined) return undefined;
  return `${file} is a Warden record, and only a person changes Warden's records. Next action: tell the user what to change in ${file}, so they edit it and run warden compile.`;
}

function localEditTarget(path: string): string {
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) return realpathSync.native(path);
  return join(localEditTarget(dirname(path)), basename(path));
}

export function localSessionRefusal(root: string, input: string): string | undefined {
  const canonicalRoot = realpathSync.native(root);
  const files = editedFiles(parseInput(input));
  for (const file of files) {
    const absolute = resolve(root, file);
    const path = relative(root, absolute);
    const target = relative(canonicalRoot, localEditTarget(absolute));
    for (const location of [path, target]) {
      const parts = location.toLowerCase().split(sep);
      if (location === "" || parts[0] === ".." || isAbsolute(location)) {
        return "Local session edits must stay inside the project. Next action: ask the user to make the external edit.";
      }
      if (parts.some((part) => part === ".git" || part === ".warden" || part === ".claude")) {
        return `${location} is protected project metadata. Next action: ask the user to make the change.`;
      }
    }
  }
  return undefined;
}
