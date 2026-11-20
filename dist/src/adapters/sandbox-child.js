import { readSync, writeSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import net, { Server, Socket } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const refuse = (owner, key, what) => {
    Object.defineProperty(owner, key, {
        value: () => {
            throw new Error(`Warden's sandbox refuses ${what}: pack code may not use ${key}`);
        },
        writable: false,
        configurable: false,
    });
};
const pipe = process.stderr._handle?.constructor;
if (pipe?.name !== "Pipe")
    throw new Error(`Warden's sandbox found stderr on ${pipe?.name ?? "no handle"}, not a Pipe, so it cannot lock raw sockets. Next action: spawn the sandbox child with stdio set to pipe.`);
refuse(Socket.prototype, "connect", "socket connections");
refuse(pipe.prototype, "connect", "socket connections");
refuse(Server.prototype, "listen", "socket servers");
refuse(Server.prototype, "_listen2", "socket servers");
refuse(net, "_createServerHandle", "socket servers");
refuse(pipe.prototype, "bind", "socket servers");
refuse(pipe.prototype, "listen", "socket servers");
refuse(process, "kill", "process signals");
refuse(process, "_kill", "process signals");
refuse(os, "setPriority", "process priorities");
syncBuiltinESMExports();
const require = createRequire(import.meta.url);
const pause = new Int32Array(new SharedArrayBuffer(4));
const send = (value) => {
    const line = Buffer.from(`${JSON.stringify(value)}\n`);
    for (let at = 0; at < line.length;) {
        try {
            at += writeSync(1, line, at);
        }
        catch (cause) {
            if (cause.code !== "EAGAIN")
                throw cause;
            Atomics.wait(pause, 0, 0, 1);
        }
    }
};
process.stdout.write = ((chunk) => process.stderr.write(chunk));
let buffered = Buffer.alloc(0);
const chunk = Buffer.alloc(1 << 16);
const nextLine = () => {
    for (;;) {
        const at = buffered.indexOf(10);
        if (at !== -1) {
            const line = buffered.subarray(0, at).toString("utf8");
            buffered = buffered.subarray(at + 1);
            return line;
        }
        let n;
        try {
            n = readSync(0, chunk, 0, chunk.length, null);
        }
        catch (cause) {
            if (cause.code !== "EAGAIN")
                throw cause;
            Atomics.wait(pause, 0, 0, 1);
            continue;
        }
        if (n === 0)
            return undefined;
        buffered = Buffer.concat([buffered, chunk.subarray(0, n)]);
    }
};
const causeOf = (cause) => (cause instanceof Error ? cause.message : String(cause)).trim().replace(/\s*\n\s*/g, " ").replace(/\.$/, "");
const failed = (failure) => Object.assign(new Error(failure.message), { failure });
const fail = (e, what, action = `fix ${e.name} in ${e.file}`) => {
    throw failed({ file: e.packFile, pointer: e.pointer, message: `Guardrail ${e.guardrail}: ${what}. Next action: ${action}, then run warden compile.` });
};
const load = async (e) => {
    let shipped = {};
    try {
        shipped = (await import(pathToFileURL(e.real).href)).default ?? {};
    }
    catch (cause) {
        fail(e, `${e.file} does not load: ${causeOf(cause)}`, `fix ${e.file}`);
    }
    if (typeof shipped !== "object" || !Object.hasOwn(shipped, e.name))
        fail(e, `${e.file} exports no ${e.name}`, `add ${e.name} to the default export of ${e.file}`);
    return shipped[e.name];
};
const isFinding = (f) => {
    if (typeof f !== "object" || f === null)
        return false;
    const { file, message, line, endLine, doThis } = f;
    const lines = (line === undefined && endLine === undefined) || (Number.isInteger(line) && (endLine === undefined || (Number.isInteger(endLine) && endLine >= line)));
    return typeof file === "string" && typeof message === "string" && lines && (doThis === undefined || typeof doThis === "string");
};
const tree = async ({ entry, input }) => {
    const check = await load(entry);
    if (typeof check !== "function")
        fail(entry, `${entry.implementation} in ${entry.file} is not a function`);
    const read = (file) => {
        send({ read: file });
        const answer = JSON.parse(nextLine() ?? "{}");
        if (answer.text === undefined)
            throw new Error(answer.error ?? `no text for ${file}`);
        return answer.text;
    };
    const markdownSections = (text) => {
        const { marked } = require("marked");
        return marked.lexer(text)
            .filter((token) => token.type === "heading" && token.depth === 2)
            .map((token) => token.text);
    };
    const markdownLinks = (text) => {
        const { marked } = require("marked");
        const { decodeHTMLAttribute } = require("entities");
        const links = [];
        marked.walkTokens(marked.lexer(text), (token) => {
            if (token.type === "link" || token.type === "image") {
                const { href } = token;
                links.push(decodeHTMLAttribute(href));
            }
        });
        return links;
    };
    const start = performance.now();
    let found;
    try {
        const given = { ...input, read, markdownSections, markdownLinks, ...(input.imports === undefined ? {} : { imports: new Map(input.imports) }) };
        Object.defineProperty(given, "ts", { get: () => require("typescript"), enumerable: true });
        found = check(given);
    }
    catch (cause) {
        fail(entry, `${entry.implementation} in ${entry.file} threw: ${causeOf(cause)}`);
    }
    const ms = performance.now() - start;
    if (!Array.isArray(found) || !found.every(isFinding)) {
        fail(entry, `${entry.implementation} in ${entry.file} returned ${Array.isArray(found) ? "a list with an item" : typeof found} that is not a finding of the form { file, message, line?, endLine?, doThis? }`);
    }
    return { found, ms };
};
const lint = async ({ root, entries, config, texts }) => {
    const [{ Linter }, { default: tseslint }] = await Promise.all([import("eslint"), import("typescript-eslint")]);
    const plugins = {};
    for (const e of entries)
        (plugins[e.namespace] ??= { meta: { name: e.namespace }, rules: {} }).rules[e.name] = await load(e);
    const linter = new Linter({ cwd: root });
    const configs = [
        { plugins },
        { files: ["**/*.{ts,tsx,mts,cts}"], languageOptions: { parser: tseslint.parser } },
        { linterOptions: { noInlineConfig: true } },
        { ignores: ["!**/node_modules/"] },
        ...config,
    ];
    const results = [];
    for (const [file, text] of Object.entries(texts)) {
        const filePath = join(root, file);
        const options = { filename: filePath, fix: false, stats: true };
        let messages = [];
        try {
            messages = linter.verifyAndFix(text, configs, options).messages;
        }
        catch (cause) {
            const said = /Rule: "([^"]+)"|loading rule '([^']+)'/.exec(cause instanceof Error ? cause.message : "");
            const rule = said?.[1] ?? said?.[2];
            const e = entries.find((x) => `${x.namespace}/${x.name}` === rule);
            if (e === undefined)
                throw cause;
            fail(e, `${e.implementation} in ${e.file} threw while linting ${file}: ${causeOf(cause)}`);
        }
        if (messages.some((m) => m.ruleId === null && m.fatal !== true && m.message.startsWith("No matching configuration found")))
            continue;
        results.push({ filePath, messages, source: messages.length > 0 ? text : undefined, stats: { times: linter.getTimes() } });
    }
    return { results };
};
for (let line = nextLine(); line !== undefined; line = nextLine()) {
    const job = JSON.parse(line);
    try {
        send({ done: await (job.kind === "tree" ? tree(job) : lint(job)) });
    }
    catch (cause) {
        const failure = cause.failure;
        send(failure === undefined ? { crash: `${cause instanceof Error ? cause.name : "Error"}: ${causeOf(cause)}` } : { failure });
    }
}
