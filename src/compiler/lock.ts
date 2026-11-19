import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RecordError } from "../records/load.js";
import { pathGroups } from "../records/paths.js";
import { type BenchSettings, type Kind, type ProjectConfig, type RecordSet, type Tier, benchSettings } from "../records/types.js";

export const LOCK_FORMAT = 3;

export interface Lock {
  format: number;
  warden: string;
  sources: Record<string, string>;
  tools: Record<string, string>;
  generated: Record<string, string>;
  guardrails: Record<string, LockedGuardrail>;
  config: Pick<ProjectConfig, "project" | "base" | "tierBudgetMs" | "loopBreakerRepeats"> & { bench?: BenchSettings };
}

export interface LockedGuardrail {
  kind: Kind;
  budgetMs: number;
  version: number;
  implementation: string;
  options: unknown;
  runs: Tier[];
  paths: string[];
  settings?: unknown;
}

export const TOOLS = ["eslint", "typescript-eslint", "typescript"] as const;

const wardenRequire = createRequire(import.meta.url);

export const firstLine = (text: string): string => text.split("\n")[0] as string;

const versionOf = (name: string): string => {
  try {
    return (wardenRequire(`${name}/package.json`) as { version: string }).version;
  } catch (cause) {
    throw new RecordError("", "/tools", `Warden's bundled ${name} does not load: ${firstLine((cause as Error).message)}. Next action: reinstall Warden so its bundled ${name} loads, then run warden doctor.`);
  }
};

export const bundledTools = (): Record<string, string> => Object.fromEntries(TOOLS.map((name) => [name, versionOf(name)]));

const OS_JUNK = new Set([".DS_Store", ".localized", "Thumbs.db", "desktop.ini"].map((n) => n.toLowerCase()));

export const isOsJunk = (name: string): boolean => OS_JUNK.has(name.toLowerCase());

export const packFiles = async (base: string, dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(join(base, dir), { recursive: true, withFileTypes: true });
    const link = entries.find((e) => e.isSymbolicLink());
    if (link !== undefined) {
      const path = join(link.parentPath, link.name);
      throw new RecordError(path, "", `is a symbolic link in a pack folder, so the lock cannot hash what it points to. Next action: replace ${path} with a copy of what it points to, then run warden compile.`);
    }
    return entries.filter((e) => e.isFile() && !isOsJunk(e.name)).map((e) => relative(base, join(e.parentPath, e.name)).split(sep).join("/"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
};

export const scriptsOf = (root: string): Record<string, unknown> => {
  const file = join(root, "package.json");
  if (!existsSync(file)) return {};
  return (JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
};

export const PROJECT_SOURCE = "./";

const NPM_ALIASES: Record<string, string> = { test: "test", t: "test", tst: "test", start: "start", stop: "stop", restart: "restart" };

const NPM_RUN = new Set(["run", "run-script", "rum", "urn"]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

const INTERPRETERS = new Set([...SHELLS, "node", "tsx", "python", "python3"]);

const INLINE = new Set(["-c", "-e", "-p", "-m", "--eval", "--print", "--test"]);

const MODULE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']*)["']/g;

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

type Token = { word: string } | { op: string };

const lex = (text: string): Token[] => {
  const out: Token[] = [];
  let word: string | undefined;
  let drop = false;
  const end = (): void => {
    if (word !== undefined) {
      if (!drop) out.push({ word });
      drop = false;
    }
    word = undefined;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const stop = close === -1 ? text.length : close;
      word = (word ?? "") + text.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      let v = "";
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) v += text[j] === "\\" ? (text[++j] ?? "") : text[j];
      word = (word ?? "") + v;
      i = j;
    } else if (c === "\\") {
      word = (word ?? "") + (text[++i] ?? "");
    } else if (c === "#" && word === undefined) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (c === "<" || c === ">") {
      if (word !== undefined && /^\d+$/.test(word)) word = undefined;
      end();
      while (/[<>&|]/.test(text[i + 1] ?? "")) i++;
      drop = true;
    } else if ("\n;&|()".includes(c)) {
      end();
      drop = false;
      out.push({ op: c });
    } else if (/\s/.test(c)) {
      end();
    } else {
      word = (word ?? "") + c;
    }
  }
  end();
  return out;
};

interface Walk {
  root: string;
  scripts: Record<string, unknown>;
  out: Record<string, string>;
}

const projectKey = (root: string, full: string): string | undefined => {
  const key = relative(root, full);
  if (key === "" || key.startsWith("..") || isAbsolute(key) || statSync(full, { throwIfNoEntry: false })?.isFile() !== true) return undefined;
  return `${PROJECT_SOURCE}${key.split(sep).join("/")}`;
};

const addModule = (w: Walk, dir: string, spec: string): void => {
  const base = resolve(dir, spec);
  const candidates = [base, ...EXTENSIONS.map((e) => base + e), ...(/\.[cm]?js$/.test(base) ? [base.replace(/js$/, "ts"), base.replace(/\.js$/, ".tsx")] : []), ...EXTENSIONS.map((e) => join(base, `index${e}`))];
  const found = candidates.find((f) => statSync(f, { throwIfNoEntry: false })?.isFile() === true);
  if (found !== undefined) addFile(w, dir, found);
};

const addFile = (w: Walk, cwd: string, path: string): void => {
  if (path === "" || path.includes("$")) return;
  const full = resolve(cwd, path);
  const key = projectKey(w.root, full);
  if (key === undefined || key in w.out) return;
  const bytes = readFileSync(full);
  w.out[key] = bytes.toString("latin1");
  if (MODULE.test(full)) for (const m of bytes.toString("utf8").matchAll(IMPORT)) addModule(w, dirname(full), m[1] as string);
};

const runNpm = (w: Walk, name: string): void => {
  for (const n of [`pre${name}`, name, `post${name}`]) {
    const key = `${PROJECT_SOURCE}package.json#scripts/${n}`;
    const body = w.scripts[n];
    if (typeof body !== "string" || key in w.out) continue;
    w.out[key] = body;
    walk(w, body, w.root);
  }
};

const simple = (w: Walk, words: string[], cwd: string): string => {
  const start = words.findIndex((x) => !/^[A-Za-z_]\w*=/.test(x));
  if (start === -1) return cwd;
  const [cmd, ...args] = words.slice(start) as [string, ...string[]];
  if (cmd === "cd") return args[0] === undefined || args[0].includes("$") ? cwd : resolve(cwd, args[0]);
  if (cmd === "npm") {
    const [sub, name] = args.filter((a) => !a.startsWith("-"));
    if (sub !== undefined && NPM_RUN.has(sub) && name !== undefined) runNpm(w, name);
    else if (sub !== undefined && sub in NPM_ALIASES) runNpm(w, NPM_ALIASES[sub] as string);
    return cwd;
  }
  const via = cmd === "npx" && args[0] === "tsx" ? args.slice(1) : cmd === "deno" && args[0] === "run" ? args.slice(1) : INTERPRETERS.has(cmd) ? args : undefined;
  if (via === undefined) {
    if (cmd.includes("/")) addFile(w, cwd, cmd);
    return cwd;
  }
  for (let i = 0; i < via.length; i++) {
    const a = via[i] as string;
    if (a === "-c" && SHELLS.has(cmd)) {
      if (via[i + 1] !== undefined) walk(w, via[i + 1] as string, cwd);
      break;
    }
    if (INLINE.has(a)) break;
    if (a.startsWith("-")) continue;
    addFile(w, cwd, a);
    break;
  }
  return cwd;
};

function walk(w: Walk, text: string, cwd: string): void {
  const stack: string[] = [];
  let here = cwd;
  let words: string[] = [];
  const flush = (): void => {
    if (words.length > 0) here = simple(w, words, here);
    words = [];
  };
  for (const t of lex(text)) {
    if ("word" in t) {
      words.push(t.word);
      continue;
    }
    flush();
    if (t.op === "(") stack.push(here);
    else if (t.op === ")") here = stack.pop() ?? cwd;
  }
  flush();
}

export const commandSources = (root: string, command: string, sources: string[], scripts = scriptsOf(root), record: [string, string] = ["", "/sources"]): Record<string, string> => {
  const w: Walk = { root, scripts, out: {} };
  walk(w, command, root);
  for (const path of sources) {
    const key = projectKey(root, resolve(root, path));
    if (key === undefined) throw new RecordError(record[0], record[1], `${path} is not a file inside the project, so the lock cannot hash it. Next action: create ${path} in the project or remove it from sources, then run warden compile.`);
    w.out[key] = readFileSync(resolve(root, path)).toString("latin1");
  }
  return w.out;
};

export const LOCK_PATH = ".warden/lock.json";

export const sha256 = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const hashed = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, content]) => [path, sha256(content)]),
  );

export function computeLock(
  set: RecordSet,
  generated: Record<string, string>,
  sources: Record<string, string>,
  warden: string,
): Lock {
  const guardrails = set.packs
    .flatMap((pack) =>
      pack.practices.flatMap((practice) => {
        const entry = set.config.packs.find((p) => p.id === pack.id);
        const paths = pathGroups(practice.paths, entry?.paths ?? []).map((g) => g.join(" & "));
        return practice.guardrails.map((g): [string, LockedGuardrail] => [
          g.id,
          {
            kind: g.kind,
            budgetMs: g.budgetMs,
            version: g.version,
            implementation: g.implementation,
            options: g.options ?? null,
            runs: [...g.runs].sort(),
            paths: [...paths].sort(),
            ...(entry?.settings === undefined ? {} : { settings: entry.settings }),
          },
        ]);
      }),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const { project, base, tierBudgetMs, loopBreakerRepeats } = set.config;
  return {
    format: LOCK_FORMAT,
    warden,
    sources: hashed(sources),
    tools: bundledTools(),
    generated: hashed(generated),
    guardrails: Object.fromEntries(guardrails),
    config: { project, base, tierBudgetMs, loopBreakerRepeats, bench: benchSettings(set.config) },
  };
}

export function readLock(root: string): Lock {
  const lock = JSON.parse(readFileSync(join(root, LOCK_PATH), "utf8")) as Lock;
  if ((lock.format ?? 0) > LOCK_FORMAT) {
    throw new RecordError(LOCK_PATH, "/format", `has format ${lock.format}; this Warden reads formats up to ${LOCK_FORMAT}. Next action: install Warden ${lock.warden}, the release that wrote the lock.`);
  }
  return lock;
}
