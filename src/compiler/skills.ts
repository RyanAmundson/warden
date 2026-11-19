import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import type { Capability, RecordSet } from "../records/types.js";
import type { Finding } from "./consistency.js";

export const SKILLS_DIR = ".warden/generated/skills";
export const skillPath = (id: string): string => `${SKILLS_DIR}/${id}/SKILL.md`;

const run = promisify(execFile);

export const COMMAND_PROBE = "WARDEN_COMMAND_PROBE";
export const UNKNOWN_COMMAND = 64;

const skill = (c: Capability, statements: Map<string, string>): string =>
  [
    "---",
    stringify({ name: c.id, description: `${c.purpose} Use when ${c.when.endsWith(".") ? c.when : `${c.when}.`}` }, { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN", lineWidth: 0 }).trimEnd(),
    "---",
    `# ${c.id}`,
    "",
    c.purpose,
    "",
    "## Upholds",
    "",
    ...c.upholds.map((id) => `- ${id}: ${statements.get(id) as string}`),
    "",
    "## Steps",
    "",
    ...c.commands.map((command, i) => `${i + 1}. \`${command}\``),
    "",
    ...(c.replaces.length === 0 ? [] : ["## Use this instead of", "", ...c.replaces.map((r) => `- ${r}`), ""]),
    "When a step fails, do its printed Next action, then run the step again. Fix the code, never the check.",
    "",
  ].join("\n");

const capabilities = (set: RecordSet): Capability[] => set.packs.flatMap((p) => p.capabilities);

export function emitSkills(set: RecordSet): Record<string, string> {
  const statements = new Map(set.packs.flatMap((p) => p.practices.map((x) => [x.id, x.statement] as const)));
  return Object.fromEntries(capabilities(set).filter((c) => c.kind === "skill").map((c) => [skillPath(c.id), skill(c, statements)]));
}

type Probe = "ok" | "unknown" | "unrunnable";

const helps = async (command: string, wardenRoot: string): Promise<Probe> => {
  if (!command.startsWith("warden ")) return "unknown";
  const rest = command.slice("warden ".length).trim().split(/\s+/);
  const end = rest.findIndex((w) => w.startsWith("-") || w.startsWith("<"));
  const path = end === -1 ? rest : rest.slice(0, end);
  if (path.length === 0 || path[0] === "") return "unknown";
  try {
    await run(process.execPath, [join(wardenRoot, "bin/warden.js"), ...path, "--help"], { cwd: wardenRoot, env: { ...process.env, [COMMAND_PROBE]: "1" } });
    return "ok";
  } catch (error) {
    return (error as { code?: unknown }).code === UNKNOWN_COMMAND ? "unknown" : "unrunnable";
  }
};

export async function checkCommands(set: RecordSet, wardenRoot: string): Promise<Finding[]> {
  const fileOf = new Map(set.packs.map((p) => [p.id, p.file]));
  const checked = await Promise.all(capabilities(set).flatMap((c) => c.commands.map(async (command) => ({ c, command, probe: await helps(command, wardenRoot) }))));
  const broken = checked.filter(({ probe }) => probe === "unrunnable");
  const unrunnable: Finding[] =
    broken.length === 0
      ? []
      : [{ code: "warden-unrunnable", record: broken[0]?.c.id as string, message: `Warden could not run ${join(wardenRoot, "bin/warden.js")} to check ${broken.length} Capability command(s), so none of them was judged. Next action: run npm run build:dist in ${wardenRoot}, then run warden compile again.` }];
  return [
    ...unrunnable,
    ...checked
      .filter(({ probe }) => probe === "unknown")
      .map(({ c, command }) => ({
        code: "unknown-command",
        record: c.id,
        message: `Capability ${c.id} runs "${command}", which is not a warden subcommand whose --help exits 0. Next action: change that command to a warden subcommand in ${fileOf.get(c.pack) as string}, then run warden compile.`,
      })),
  ];
}
