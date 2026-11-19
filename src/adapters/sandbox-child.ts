import { readSync, writeSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import net, { Server, Socket } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Entry {
  file: string;
  real: string;
  name: string;
  namespace: string;
  guardrail: string;
  implementation: string;
  packFile: string;
  pointer: string;
}

interface TreeJob {
  kind: "tree";
  entry: Entry;
  input: Record<string, unknown> & { imports?: [string, unknown][] };
}

interface LintJob {
  kind: "eslint";
  root: string;
  entries: Entry[];
  config: unknown[];
  texts: Record<string, string>;
}

interface Failure {
  file: string;
  pointer: string;
  message: string;
}

const refuse = (owner: object, key: string, what: string): void => {
  Object.defineProperty(owner, key, {
    value: () => {
      throw new Error(`Warden's sandbox refuses ${what}: pack code may not use ${key}`);
    },
    writable: false,
    configurable: false,
  });
};

const pipe = (process.stderr as unknown as { _handle?: { constructor: { name: string; prototype: object } } })._handle?.constructor;
if (pipe?.name !== "Pipe") throw new Error(`Warden's sandbox found stderr on ${pipe?.name ?? "no handle"}, not a Pipe, so it cannot lock raw sockets. Next action: spawn the sandbox child with stdio set to pipe.`);

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

const send = (value: unknown): void => {
  const line = Buffer.from(`${JSON.stringify(value)}\n`);
  for (let at = 0; at < line.length; ) {
    try {
      at += writeSync(1, line, at);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EAGAIN") throw cause;
      Atomics.wait(pause, 0, 0, 1);
    }
  }
};

process.stdout.write = ((chunk: string | Uint8Array) => process.stderr.write(chunk)) as typeof process.stdout.write;

let buffered = Buffer.alloc(0);
const chunk = Buffer.alloc(1 << 16);

const nextLine = (): string | undefined => {
  for (;;) {
    const at = buffered.indexOf(10);
    if (at !== -1) {
      const line = buffered.subarray(0, at).toString("utf8");
      buffered = buffered.subarray(at + 1);
      return line;
    }
    let n: number;
    try {
      n = readSync(0, chunk, 0, chunk.length, null);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EAGAIN") throw cause;
      Atomics.wait(pause, 0, 0, 1);
      continue;
    }
    if (n === 0) return undefined;
    buffered = Buffer.concat([buffered, chunk.subarray(0, n)]);
  }
};

const causeOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause)).trim().replace(/\s*\n\s*/g, " ").replace(/\.$/, "");

const failed = (failure: Failure): Error => Object.assign(new Error(failure.message), { failure });

const fail = (e: Entry, what: string, action = `fix ${e.name} in ${e.file}`): never => {
  throw failed({ file: e.packFile, pointer: e.pointer, message: `Guardrail ${e.guardrail}: ${what}. Next action: ${action}, then run warden compile.` });
};

const load = async (e: Entry): Promise<unknown> => {
  let shipped: Record<string, unknown> = {};
  try {
    shipped = ((await import(pathToFileURL(e.real).href)) as { default?: Record<string, unknown> }).default ?? {};
  } catch (cause) {
    fail(e, `${e.file} does not load: ${causeOf(cause)}`, `fix ${e.file}`);
  }
  if (typeof shipped !== "object" || !Object.hasOwn(shipped, e.name)) fail(e, `${e.file} exports no ${e.name}`, `add ${e.name} to the default export of ${e.file}`);
  return shipped[e.name];
};

const isFinding = (f: unknown): boolean => {
  if (typeof f !== "object" || f === null) return false;
  const { file, message, line, endLine, doThis } = f as Record<string, unknown>;
  const lines = (line === undefined && endLine === undefined) || (Number.isInteger(line) && (endLine === undefined || (Number.isInteger(endLine) && (endLine as number) >= (line as number))));
  return typeof file === "string" && typeof message === "string" && lines && (doThis === undefined || typeof doThis === "string");
};

const tree = async ({ entry, input }: TreeJob): Promise<unknown> => {
  const check = await load(entry);
  if (typeof check !== "function") fail(entry, `${entry.implementation} in ${entry.file} is not a function`);
  const read = (file: string): string => {
    send({ read: file });
    const answer = JSON.parse(nextLine() ?? "{}") as { text?: string; error?: string };
    if (answer.text === undefined) throw new Error(answer.error ?? `no text for ${file}`);
    return answer.text;
  };
  const start = performance.now();
  let found: unknown;
  try {
    const given = { ...input, read, ...(input.imports === undefined ? {} : { imports: new Map(input.imports) }) };
    Object.defineProperty(given, "ts", { get: () => require("typescript") as unknown, enumerable: true });
    found = (check as (i: unknown) => unknown)(given);
  } catch (cause) {
    fail(entry, `${entry.implementation} in ${entry.file} threw: ${causeOf(cause)}`);
  }
  const ms = performance.now() - start;
  if (!Array.isArray(found) || !found.every(isFinding)) {
    fail(entry, `${entry.implementation} in ${entry.file} returned ${Array.isArray(found) ? "a list with an item" : typeof found} that is not a finding of the form { file, message, line?, endLine?, doThis? }`);
  }
  return { found, ms };
};

const lint = async ({ root, entries, config, texts }: LintJob): Promise<unknown> => {
  const [{ Linter }, { default: tseslint }] = await Promise.all([import("eslint"), import("typescript-eslint")]);
  const plugins: Record<string, { meta: { name: string }; rules: Record<string, unknown> }> = {};
  for (const e of entries) (plugins[e.namespace] ??= { meta: { name: e.namespace }, rules: {} }).rules[e.name] = await load(e);
  const linter = new Linter({ cwd: root });
  const configs = [
    { plugins },
    { files: ["**/*.{ts,tsx,mts,cts}"], languageOptions: { parser: tseslint.parser } },
    { linterOptions: { noInlineConfig: true } },
    { ignores: ["!**/node_modules/"] },
    ...config,
  ] as never;
  const results: unknown[] = [];
  for (const [file, text] of Object.entries(texts)) {
    const filePath = join(root, file);
    const options = { filename: filePath, fix: false, stats: true };
    let messages: { ruleId: string | null; fatal?: boolean; message: string }[] = [];
    try {
      messages = linter.verifyAndFix(text, configs, options).messages;
    } catch (cause) {
      const said = /Rule: "([^"]+)"|loading rule '([^']+)'/.exec(cause instanceof Error ? cause.message : "");
      const rule = said?.[1] ?? said?.[2];
      const e = entries.find((x) => `${x.namespace}/${x.name}` === rule);
      if (e === undefined) throw cause;
      fail(e, `${e.implementation} in ${e.file} threw while linting ${file}: ${causeOf(cause)}`);
    }
    if (messages.some((m) => m.ruleId === null && m.fatal !== true && m.message.startsWith("No matching configuration found"))) continue;
    results.push({ filePath, messages, source: messages.length > 0 ? text : undefined, stats: { times: linter.getTimes() } });
  }
  return { results };
};

for (let line = nextLine(); line !== undefined; line = nextLine()) {
  const job = JSON.parse(line) as TreeJob | LintJob;
  try {
    send({ done: await (job.kind === "tree" ? tree(job) : lint(job)) });
  } catch (cause) {
    const failure = (cause as { failure?: Failure }).failure;
    send(failure === undefined ? { crash: `${cause instanceof Error ? cause.name : "Error"}: ${causeOf(cause)}` } : { failure });
  }
}
