import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join, resolve } from "node:path";
import { TOOLS } from "../compiler/lock.js";
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

const commandItem = (id: string, command: string, root: string, scripts: Record<string, unknown>): Item => {
  const name = `cmd ${id}: ${command}`;
  const word = command.trim().split(/\s+/)[0] as string;
  const script = /^npm\s+test(\s|$)/.test(command.trim()) ? "test" : /^npm\s+run\s+([^\s-]\S*)/.exec(command.trim())?.[1];
  if (word.includes("/")) {
    return executable(resolve(root, word)) ? { name } : { name, problem: `${word} is not an executable file in the project`, fix: `create ${word} as an executable file` };
  }
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
    return { name: `tool ${name}`, problem: (cause as Error).message, fix: `reinstall Warden so its bundled ${name} loads` };
  }
};

export async function doctor(set: RecordSet): Promise<DoctorResult> {
  const items: Item[] = [];
  for (const tool of TOOLS) items.push(await toolItem(tool, () => wardenRequire.resolve(tool)));
  items.push(await toolItem("warden eslint plugin", () => import("../../eslint-plugin/index.js")));
  const scripts = scriptsOf(set.root);
  for (const g of set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails))) {
    if (g.implementation.startsWith("cmd:")) items.push(commandItem(g.id, g.implementation.slice(4), set.root, scripts));
  }
  const failed = items.find((i) => i.fix !== undefined);
  return {
    lines: items.map((i) => (i.problem === undefined ? `ok    ${i.name}` : `FAIL  ${i.name}  ${i.problem}`)),
    next: failed === undefined ? undefined : `${failed.fix as string}, then run warden doctor`,
  };
}

export const formatDoctor = ({ lines, next }: DoctorResult): string => [...lines, ...(next === undefined ? [] : [`Next action: ${next}`])].join("\n");
