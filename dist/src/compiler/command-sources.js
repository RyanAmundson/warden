import { readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { RecordError } from "../records/load.js";
import { PROJECT_SOURCE, scriptsOf } from "./lock.js";
const NPM_ALIASES = { test: "test", t: "test", tst: "test", start: "start", stop: "stop", restart: "restart" };
const NPM_RUN = new Set(["run", "run-script", "rum", "urn"]);
const NPM_VALUE_FLAGS = new Set(["--prefix", "-C", "-w", "--workspace"]);
const SCRIPT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const PYTHON = /^python(?:\d+(?:\.\d+)?)?$/;
const LEADS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{"]);
const ENDS = new Set(["fi", "done", "}"]);
const UNMODELED = new Set(["case", "esac", "function", "select", "coproc", "eval", "trap"]);
const BUILTINS = new Set([":", "true", "false", "exit", "return", "export", "unset", "set", "shift", "read", "local", "readonly", "wait", "echo", "printf", "test", "[", "[[", "pwd", "umask", "ulimit", "type", "hash", "getopts", "break", "continue", "let", "declare", "typeset"]);
const DATA_TOOLS = new Set(["cat", "grep", "egrep", "fgrep", "rg", "ls", "find", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "diff", "cmp", "comm", "git", "eslint", "tsc", "prettier", "jq", "mkdir", "rm", "rmdir", "cp", "mv", "touch", "chmod", "ln", "stat", "file", "du", "date", "sleep", "seq", "basename", "dirname", "realpath", "readlink", "tee", "od", "xxd", "shasum", "sha256sum", "md5", "md5sum", "tar", "gzip", "gunzip", "zip", "unzip", "ruff", "mypy", "black"]);
const RUN_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const MODULE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const NODE_ENTRY_EXTENSIONS = ["", ".js", ".json", ".node"];
const NODE_SHEBANG = /^#!.*\b(?:node|tsx|ts-node|bun|deno)\b/;
const SHELL_SHEBANG = /^#!.*\b(?:sh|bash|zsh|dash)\b/;
const SHELL_SCRIPT = /\.(?:sh|bash|zsh)$/;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']*)["']/g;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const PACK_PROGRAM = /^\$(?:\{WARDEN_PACK_DIR\}|WARDEN_PACK_DIR)\/([^$]*)$/;
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const NODE_FILE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);
const NODE_INLINE_FLAGS = new Set(["-e", "-p", "-pe", "--eval", "--print"]);
const NODE_INLINE_BOOL = new Set(["--no-warnings", "--trace-warnings", "--enable-source-maps", "--inspect", "--inspect-brk"]);
const NODE_VALUE_FLAGS = new Set(["--title", "-C", "--conditions", "--input-type", "--env-file", "--tsconfig", "-P", "--project"]);
const TSX_WATCH_VALUE_FLAGS = new Set(["--include", "--exclude", "--ignore"]);
const NODE_BOOL = /^--(?:no-[\w-]+|experimental-[\w-]+|enable-source-maps|trace-[\w-]+|expose-gc|preserve-symlinks(?:-main)?|inspect(?:-brk)?|throw-deprecation|pending-deprecation|frozen-intrinsics|transpile-only|swc|esm)$/;
const SHELL_LETTERS = /^[-+][aefhklmnuvxBCEHPTc]+$/;
const SHELL_LONG = new Set(["--login", "--norc", "--noprofile", "--posix"]);
const PYTHON_BOOL = /^-[uBOEsSIqbdv]+$/;
const PERL_BOOL = /^-[wWtTsnpalc0]+$/;
const RUBY_BOOL = /^-[wWvdnpalc]+$/;
const DENO_BOOL = /^(?:-A|-q|--quiet|--allow-[\w-]+(?:=.*)?|--no-[\w-]+|--unstable[\w-]*|--check)$/;
const XARGS_VALUE = new Set(["-n", "-L", "-P", "-s", "-I", "-d", "-E", "-a"]);
const XARGS_BOOL = new Set(["-0", "-r", "-t", "-p", "-x", "--null", "--no-run-if-empty", "--verbose"]);
const TIMEOUT_VALUE = new Set(["-s", "-k", "--signal", "--kill-after"]);
const TIMEOUT_BOOL = new Set(["-v", "--verbose", "--preserve-status", "--foreground"]);
const ENV_VALUE = new Set(["-u", "--unset"]);
const closing = (text, open) => {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (c === "\\")
            i++;
        else if (c === "'") {
            const close = text.indexOf("'", i + 1);
            if (close === -1)
                return -1;
            i = close;
        }
        else if (c === "(")
            depth++;
        else if (c === ")" && --depth === 0)
            return i;
    }
    return -1;
};
const lex = (text) => {
    const out = [];
    let word;
    let drop = false;
    const end = () => {
        if (word !== undefined) {
            if (!drop)
                out.push({ word });
            drop = false;
        }
        word = undefined;
    };
    const substitute = (i) => {
        word = `${word ?? ""}$`;
        if (text[i] === "`") {
            let j = i + 1;
            while (j < text.length && text[j] !== "`")
                j += text[j] === "\\" ? 2 : 1;
            out.push(j >= text.length ? { unresolved: text.slice(i) } : { sub: text.slice(i + 1, j) });
            return j;
        }
        const j = closing(text, i + 1);
        if (j === -1) {
            out.push({ unresolved: text.slice(i) });
            return text.length;
        }
        if (text[i + 2] === "(") {
            if (/\$\(|`/.test(text.slice(i + 3, j - 1)))
                out.push({ unresolved: text.slice(i, j + 1) });
            return j;
        }
        out.push({ sub: text.slice(i + 2, j) });
        return j;
    };
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "'") {
            const close = text.indexOf("'", i + 1);
            const stop = close === -1 ? text.length : close;
            word = (word ?? "") + text.slice(i + 1, stop);
            i = stop;
        }
        else if (c === '"') {
            let j = i + 1;
            for (; j < text.length && text[j] !== '"'; j++) {
                if (text[j] === "\\")
                    word = (word ?? "") + (text[++j] ?? "");
                else if (text[j] === "`" || (text[j] === "$" && text[j + 1] === "("))
                    j = substitute(j);
                else
                    word = (word ?? "") + text[j];
            }
            word = word ?? "";
            i = j;
        }
        else if (c === "\\") {
            word = (word ?? "") + (text[++i] ?? "");
        }
        else if (c === "`" || (c === "$" && text[i + 1] === "(")) {
            i = substitute(i);
        }
        else if (c === "#" && word === undefined) {
            while (i + 1 < text.length && text[i + 1] !== "\n")
                i++;
        }
        else if (c === "<" || c === ">") {
            if (word !== undefined && /^\d+$/.test(word))
                word = undefined;
            end();
            if (c === "<" && text[i + 1] === "<" && text[i + 2] !== "<")
                out.push({ unresolved: "a here-document" });
            while (/[<>&|]/.test(text[i + 1] ?? ""))
                i++;
            drop = true;
        }
        else if ("\n;&|()".includes(c)) {
            end();
            drop = false;
            out.push({ op: c });
        }
        else if (/\s/.test(c)) {
            end();
        }
        else {
            word = (word ?? "") + c;
        }
    }
    end();
    return out;
};
const inside = (base, full) => {
    const key = relative(base, full);
    return key === "" || key.startsWith("..") || isAbsolute(key) ? undefined : key;
};
const projectKey = (w, full) => {
    const key = inside(w.root, full) ?? inside(w.realRoot, full);
    if (key === undefined || statSync(full, { throwIfNoEntry: false })?.isFile() !== true)
        return undefined;
    return `${PROJECT_SOURCE}${key.split(sep).join("/")}`;
};
const projectFiles = (w, cwd, words) => [
    ...new Set(words.flatMap((word) => (word === "" || word.includes("$") ? [] : [projectKey(w, resolve(cwd, word))])).filter((k) => k !== undefined)),
];
const refuse = (w, form, files) => {
    if (!w.strict)
        return;
    const open = files.filter((k) => !w.listed.has(k));
    if (files.length > 0 && open.length === 0)
        return;
    const id = w.owner.id;
    const next = open.length > 0
        ? `list ${open.map((k) => k.slice(PROJECT_SOURCE.length)).join(", ")} under sources: in Guardrail ${id}, then run warden compile.`
        : `rewrite ${form} in Guardrail ${id} as a command Warden resolves, such as sh <file>, node <file>, or npm run <script>, then run warden compile.`;
    throw new RecordError(w.owner.file, `/guardrails/${id}/implementation`, `Guardrail ${id} runs ${form}, which Warden cannot resolve to the files it runs. Next action: ${next}`);
};
const addModule = (w, dir, spec) => {
    const base = resolve(dir, spec);
    const candidates = [base, ...EXTENSIONS.map((e) => base + e), ...(/\.[cm]?js$/.test(base) ? [base.replace(/js$/, "ts"), base.replace(/\.js$/, ".tsx")] : []), ...EXTENSIONS.map((e) => join(base, `index${e}`))];
    const found = candidates.find((f) => statSync(f, { throwIfNoEntry: false })?.isFile() === true);
    if (found !== undefined)
        addFile(w, dir, found);
};
const addNodeImports = (w, dir, text) => {
    for (const match of text.matchAll(IMPORT))
        addModule(w, dir, match[1]);
};
const addFile = (w, cwd, path, kind) => {
    const full = resolve(cwd, path);
    const key = projectKey(w, full);
    if (key === undefined)
        return;
    const captured = key in w.out;
    if (captured && (kind !== "node" || w.nodeModules.has(key)))
        return;
    const bytes = captured ? Buffer.from(w.out[key], "latin1") : readFileSync(full);
    w.out[key] = bytes.toString("latin1");
    const text = bytes.toString("utf8");
    if (kind === "node" || MODULE.test(full) || NODE_SHEBANG.test(text)) {
        w.nodeModules.add(key);
        addNodeImports(w, dirname(full), text);
    }
    else if (kind === "shell" || SHELL_SCRIPT.test(full) || SHELL_SHEBANG.test(text)) {
        walk({ ...w, strict: false }, text, cwd);
    }
};
const packRelativePath = (path) => path !== ".." && !path.startsWith("../") && !path.startsWith("/");
const nodePackEntry = (path, sources) => {
    const file = (name) => name !== "." && !name.endsWith("/") && NODE_ENTRY_EXTENSIONS.some((extension) => sources.has(name + extension));
    const index = (name) => NODE_ENTRY_EXTENSIONS.slice(1).some((extension) => sources.has(posix.join(name, `index${extension}`)));
    if (file(path))
        return true;
    const manifest = sources.get(posix.join(path, "package.json"));
    if (manifest !== undefined) {
        const main = JSON.parse(manifest.replace(/^\uFEFF/, ""))?.main;
        if (typeof main === "string" && main !== "") {
            const target = posix.normalize(posix.join(path, main));
            if (posix.isAbsolute(main) || !packRelativePath(target))
                return false;
            if (file(target) || index(target))
                return true;
        }
    }
    return index(path);
};
const addProgram = (w, cwd, word, form, rest, kind) => {
    const packPath = PACK_PROGRAM.exec(word)?.[1];
    if (packPath !== undefined) {
        const path = posix.normalize(packPath);
        const { file, id, packSources, exactNodeEntry } = w.owner;
        let problem = "does not resolve to a file in its signed pack sources";
        if (packSources !== undefined && packRelativePath(path)) {
            try {
                const found = kind === "node" && exactNodeEntry !== true
                    ? nodePackEntry(path, packSources) : !packPath.endsWith("/") && packSources.has(path);
                if (found)
                    return;
            }
            catch (cause) {
                if (!(cause instanceof SyntaxError))
                    throw cause;
                problem = `has an invalid package.json at ${posix.join(path, "package.json")}`;
            }
        }
        throw new RecordError(file, `/guardrails/${id}/implementation`, `Guardrail ${id} names ${word}, which ${problem}. Next action: use a pack-relative file name under WARDEN_PACK_DIR in ${file}, then run warden compile.`);
    }
    if (word.includes("$"))
        return refuse(w, `${form}, whose program is named through a variable`, projectFiles(w, cwd, rest));
    addFile(w, cwd, word, kind);
};
const resolveBare = (w, word) => [...(process.env.PATH ?? "").split(delimiter).filter((d) => d !== ""), join(w.root, "node_modules", ".bin")].flatMap((dir) => {
    const candidate = join(resolve(w.root, dir), word);
    return statSync(candidate, { throwIfNoEntry: false })?.isFile() === true ? [realpathSync(candidate)] : [];
});
const runPackageScript = (w, name, manager) => {
    for (const n of [`pre${name}`, name, `post${name}`]) {
        const key = `${PROJECT_SOURCE}package.json#scripts/${n}`;
        const body = w.scripts[n];
        if (typeof body !== "string" || (key in w.out && (!w.strict || w.strictScripts.has(key))))
            continue;
        w.out[key] = body;
        if (w.strict)
            w.strictScripts.add(key);
        try {
            walk(w, body, w.root);
        }
        catch (cause) {
            if (!(cause instanceof RecordError) || n === name || manager === undefined)
                throw cause;
            const id = w.owner.id;
            throw new RecordError(w.owner.file, `/guardrails/${id}/implementation`, `Warden cannot trace package.json script ${n}, which ${manager} may run alongside ${name}. Next action: call the Guardrail's check file directly, then run warden compile.`);
        }
    }
};
const shell = (w, cmd, args, cwd, form) => {
    let inline = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--" || SHELL_LONG.has(a))
            continue;
        if (SHELL_LETTERS.test(a)) {
            if (a.includes("c"))
                inline = true;
            continue;
        }
        if (a.startsWith("-") || a.startsWith("+"))
            return refuse(w, `${form}, with the ${cmd} option ${a}`, projectFiles(w, cwd, args));
        if (inline)
            return walk(w, a, cwd);
        return addProgram(w, cwd, a, form, args.slice(i + 1), "shell");
    }
    refuse(w, `${form}, which reads its commands from standard input`, []);
};
const nodeEntry = (cwd, path) => {
    if (path.includes("$"))
        return path;
    const full = resolve(cwd, path);
    return NODE_ENTRY_EXTENSIONS.map((extension) => full + extension)
        .find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile() === true) ?? path;
};
const nodeLike = (w, cmd, args, cwd, form) => {
    const watch = cmd === "tsx" && args[0] === "watch";
    let inline;
    let printOnly = false;
    for (let i = watch ? 1 : 0; i < args.length; i++) {
        const a = args[i];
        const [flag, value] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
        if (watch && TSX_WATCH_VALUE_FLAGS.has(flag)) {
            if (value === undefined)
                i++;
            continue;
        }
        if (watch && flag === "--clear-screen")
            continue;
        if (NODE_INLINE_FLAGS.has(flag)) {
            if (cmd !== "node")
                return;
            const print = flag === "-p" || flag === "--print";
            const next = args[i + 1];
            if (print && (next === undefined || next.startsWith("-"))) {
                printOnly = true;
                continue;
            }
            inline = flag === "--eval" && value !== undefined ? value : args[++i];
            if (inline === undefined)
                return;
            continue;
        }
        if (NODE_FILE_FLAGS.has(flag)) {
            const spec = value ?? args[++i];
            if (spec !== undefined) {
                if (PACK_PROGRAM.test(spec)) {
                    const mode = flag === "-r" || flag === "--require" ? "node" : undefined;
                    addProgram(w, cwd, spec, form, [], mode);
                }
                else if (/^\.{0,2}\//.test(spec))
                    addProgram(w, cwd, spec, form, []);
            }
            continue;
        }
        if (NODE_VALUE_FLAGS.has(flag)) {
            if (value === undefined)
                i++;
            continue;
        }
        if (inline !== undefined) {
            if (a === "--" || a === "-" || !a.startsWith("-"))
                break;
            if (NODE_INLINE_BOOL.has(flag))
                continue;
            return refuse(w, `${form}, with the ${cmd} option ${a}`, []);
        }
        if ((a.startsWith("--") && value !== undefined) || NODE_BOOL.test(a))
            continue;
        if (a.startsWith("-"))
            return refuse(w, `${form}, with the ${cmd} option ${a}`, projectFiles(w, cwd, args));
        const program = cmd === "node" ? nodeEntry(cwd, a) : a;
        return addProgram(w, cwd, program, form, args.slice(i + 1), cmd === "node" && !/\.(?:json|node)$/.test(program) ? "node" : undefined);
    }
    if (inline !== undefined)
        return addNodeImports(w, cwd, inline);
    if (printOnly)
        return;
    refuse(w, watch ? `${form}, which names no script to watch` : `${form}, which reads its program from standard input`, []);
};
const scripted = (w, cmd, args, cwd, form, inline, bool, valued) => {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (inline.has(a))
            return;
        if (valued.has(a)) {
            i++;
            continue;
        }
        if (bool.test(a) || [...valued].some((v) => a.startsWith(v) && a.length > v.length))
            continue;
        if (a.startsWith("-"))
            return refuse(w, `${form}, with the ${cmd} option ${a}`, projectFiles(w, cwd, args));
        return addProgram(w, cwd, a, form, args.slice(i + 1));
    }
    refuse(w, `${form}, which reads its program from standard input`, []);
};
const fileFlag = (w, args, cwd, form) => {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-f" || a === "--file")
            addProgram(w, cwd, args[++i] ?? "", form, []);
        else if (a.startsWith("--file="))
            addProgram(w, cwd, a.slice("--file=".length), form, []);
        else if (/^-f./.test(a))
            addProgram(w, cwd, a.slice(2), form, []);
    }
};
const deno = (w, args, cwd, form) => {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-c" || a === "--config") {
            i++;
            continue;
        }
        if (DENO_BOOL.test(a) || a.startsWith("--config="))
            continue;
        if (a.startsWith("-"))
            return refuse(w, `${form}, with the deno option ${a}`, projectFiles(w, cwd, args));
        return addProgram(w, cwd, a, form, args.slice(i + 1));
    }
    refuse(w, `${form}, which names no program`, []);
};
const bun = (w, args, cwd, form) => {
    const rest = args.filter((a) => a !== "--bun" && a !== "--smol" && a !== "--silent");
    const flag = rest.find((a) => a.startsWith("-"));
    if (flag !== undefined)
        return refuse(w, `${form}, with the bun option ${flag}`, projectFiles(w, cwd, args));
    const [first, second] = rest;
    const target = first === "run" ? second : first;
    if (target === undefined || (first !== "run" && ["test", "t", "x", "install", "add", "build", "exec"].includes(target)))
        return refuse(w, `${form}, a bun subcommand Warden does not resolve`, projectFiles(w, cwd, args));
    if (first === "run" && typeof w.scripts[target] === "string")
        return runPackageScript(w, target);
    addProgram(w, cwd, target, form, []);
};
const npm = (w, args, cwd, form) => {
    const flag = args.find((a) => NPM_VALUE_FLAGS.has(a.split("=")[0]));
    if (flag !== undefined)
        return refuse(w, `${form}, with the npm option ${flag}`, projectFiles(w, cwd, args));
    const [sub, name] = args.filter((a) => !a.startsWith("-"));
    if (sub === undefined)
        return;
    if (NPM_RUN.has(sub)) {
        if (name !== undefined)
            runPackageScript(w, name);
        return;
    }
    if (sub in NPM_ALIASES)
        return runPackageScript(w, NPM_ALIASES[sub]);
    refuse(w, `${form}, an npm subcommand Warden does not resolve`, projectFiles(w, cwd, args));
};
const localPackageRunner = (w, cmd, args, cwd, form) => {
    const [sub, name] = args;
    const run = sub === "run" || (cmd === "pnpm" && sub === "run-script");
    if (!run || name === undefined || !SCRIPT_NAME.test(name) || typeof w.scripts[name] !== "string" || args.length !== 2 || resolve(cwd) !== resolve(w.root)) {
        return refuse(w, `${form}, which must run a literal ${cmd} script name declared in the root package.json without extra arguments`, projectFiles(w, cwd, args));
    }
    runPackageScript(w, name, cmd);
};
const bare = (w, cmd, args, cwd, form) => {
    const own = resolveBare(w, cmd).filter((real) => inside(w.realRoot, real)?.split(sep).includes("node_modules") === false);
    for (const real of own)
        addFile(w, w.realRoot, real);
    if (own.length > 0 || BUILTINS.has(cmd))
        return;
    if (DATA_TOOLS.has(cmd)) {
        if (cmd === "find" && args.some((a) => RUN_FLAGS.has(a)))
            refuse(w, `${form}, which runs a program for each file`, projectFiles(w, cwd, args));
        return;
    }
    refuse(w, `${form}, an unrecognized program`, projectFiles(w, cwd, args));
};
const unwrap = (w, words, cwd, form) => {
    const head = words[0];
    const rest = words.slice(1);
    const skip = (valued, bool, extra = () => false) => {
        let i = 0;
        while (i < rest.length && rest[i].startsWith("-")) {
            const a = rest[i];
            if (a === "--")
                return rest.slice(i + 1);
            const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
            if (valued.has(name))
                i += a.includes("=") ? 1 : 2;
            else if (bool.has(a) || extra(a))
                i++;
            else {
                refuse(w, `${form}, with the ${head} option ${a}`, projectFiles(w, cwd, rest));
                return undefined;
            }
        }
        return rest.slice(i);
    };
    if (head === "nice")
        return skip(new Set(["-n", "--adjustment"]), new Set(), (a) => /^-\d+$/.test(a));
    if (head === "nohup")
        return skip(new Set(), new Set());
    if (head === "xargs")
        return skip(XARGS_VALUE, XARGS_BOOL);
    if (head === "timeout")
        return skip(TIMEOUT_VALUE, TIMEOUT_BOOL)?.slice(1);
    if (head === "env") {
        const after = skip(ENV_VALUE, new Set(["-i", "-", "--ignore-environment"]));
        return after?.slice(Math.max(0, after.findIndex((x) => !ASSIGNMENT.test(x))));
    }
    if (head === "exec" || head === "time" || head === "command") {
        if (head === "command" && (rest[0] === "-v" || rest[0] === "-V"))
            return [];
        return skip(new Set(["-a"]), new Set(["-c", "-l", "-p"]));
    }
    return words;
};
const simple = (w, all, cwd) => {
    const lead = all.findIndex((x) => !LEADS.has(x) && !ENDS.has(x));
    if (lead === -1)
        return cwd;
    let words = all.slice(lead);
    const form = `\`${words.join(" ")}\``;
    for (;;) {
        words = words.slice(Math.max(0, words.findIndex((x) => !LEADS.has(x) && !ENDS.has(x))));
        const start = words.findIndex((x) => !ASSIGNMENT.test(x));
        if (start === -1)
            return cwd;
        words = words.slice(start);
        const next = unwrap(w, words, cwd, form);
        if (next === undefined || next.length === 0)
            return cwd;
        if (next === words)
            break;
        words = next;
    }
    const [cmd, ...args] = words;
    if (cmd === "cd") {
        const target = args.find((a) => !a.startsWith("-"));
        if (target === undefined)
            return cwd;
        if (target.includes("$")) {
            refuse(w, `${form}, which changes to a folder named through a variable`, []);
            return cwd;
        }
        return resolve(cwd, target);
    }
    if (cmd === "for")
        return cwd;
    if (UNMODELED.has(cmd))
        refuse(w, `${form}, a ${cmd} construct Warden does not resolve`, projectFiles(w, cwd, args));
    else if (cmd === "source" || cmd === ".") {
        if (args[0] === undefined)
            refuse(w, `${form}, which names no script`, []);
        else
            addProgram(w, cwd, args[0], form, args.slice(1), "shell");
    }
    else if (SHELLS.has(cmd))
        shell(w, cmd, args, cwd, form);
    else if (cmd === "node" || cmd === "tsx" || cmd === "ts-node")
        nodeLike(w, cmd, args, cwd, form);
    else if (cmd === "npx" && (args[0] === "tsx" || args[0] === "ts-node"))
        nodeLike(w, args[0], args.slice(1), cwd, form);
    else if (cmd === "npx") {
        const [bin, ...more] = args.filter((a) => !["--yes", "-y", "--no", "--no-install", "-q", "--quiet"].includes(a));
        if (bin === undefined || bin.startsWith("-"))
            refuse(w, `${form}, which names no program`, []);
        else
            bare(w, bin, more, cwd, form);
    }
    else if (PYTHON.test(cmd))
        scripted(w, cmd, args, cwd, form, new Set(["-c"]), PYTHON_BOOL, new Set(["-W", "-X"]));
    else if (cmd === "perl")
        scripted(w, cmd, args, cwd, form, new Set(["-e", "-E"]), PERL_BOOL, new Set(["-I", "-M", "-m"]));
    else if (cmd === "ruby")
        scripted(w, cmd, args, cwd, form, new Set(["-e"]), RUBY_BOOL, new Set(["-I", "-r"]));
    else if (cmd === "awk" || cmd === "gawk" || cmd === "sed")
        fileFlag(w, args, cwd, form);
    else if (cmd === "deno")
        args[0] === "run" ? deno(w, args.slice(1), cwd, form) : refuse(w, `${form}, a deno subcommand Warden does not resolve`, projectFiles(w, cwd, args));
    else if (cmd === "bun")
        bun(w, args, cwd, form);
    else if (cmd === "npm")
        npm(w, args, cwd, form);
    else if (cmd === "pnpm" || cmd === "yarn")
        localPackageRunner(w, cmd, args, cwd, form);
    else if (cmd.includes("$"))
        addProgram(w, cwd, cmd, form, args);
    else if (cmd.includes("/"))
        addFile(w, cwd, cmd);
    else
        bare(w, cmd, args, cwd, form);
    return cwd;
};
function walk(w, text, cwd) {
    const stack = [];
    let here = cwd;
    let words = [];
    const flush = () => {
        if (words.length > 0)
            here = simple(w, words, here);
        words = [];
    };
    for (const t of lex(text)) {
        if ("word" in t)
            words.push(t.word);
        else if ("sub" in t)
            walk(w, t.sub, here);
        else if ("unresolved" in t)
            refuse(w, `\`${t.unresolved}\``, projectFiles(w, here, lex(t.unresolved).flatMap((x) => ("word" in x ? [x.word] : []))));
        else {
            flush();
            if (t.op === "(")
                stack.push(here);
            else if (t.op === ")")
                here = stack.pop() ?? cwd;
        }
    }
    flush();
}
export const commandSources = (root, command, sources, scripts = scriptsOf(root), owner = { file: "", id: "" }) => {
    const w = { root, realRoot: realpathSync(root), scripts, out: {}, strict: true, listed: new Set(), strictScripts: new Set(), nodeModules: new Set(), owner };
    const keys = sources.map((path) => {
        const key = projectKey(w, resolve(root, path));
        if (key === undefined)
            throw new RecordError(owner.file, `/guardrails/${owner.id}/sources`, `${path} is not a file inside the project, so the lock cannot hash it. Next action: create ${path} in the project or remove it from sources, then run warden compile.`);
        w.listed.add(key);
        return [key, resolve(root, path)];
    });
    walk(w, command, root);
    for (const [key, full] of keys)
        w.out[key] = readFileSync(full).toString("latin1");
    return w.out;
};
