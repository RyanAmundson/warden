import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, matchesGlob } from "node:path";
import { compile, wardenVersion } from "../compiler/compile.js";
import { RecordError, loadRecords } from "../records/load.js";
import { initAction, listPacks } from "./packs.js";
import { PARSE_ERROR } from "../adapters/types.js";
import { type Baseline, writeBaseline } from "../runner/baseline.js";
import { verifyBase } from "../runner/changed.js";
import { runGuardrails } from "../runner/run.js";

const CONFIG_PATH = ".warden/config.yaml";

const configText = (project: string, version: string, packs: string[]): string =>
  [
    `warden: ${JSON.stringify(version)}`,
    `project: ${JSON.stringify(project)}`,
    "base: main",
    "packs:",
    ...packs.flatMap((id) => [`  - id: ${id}`, '    paths: ["**/*.{ts,tsx,js,mjs}"]']),
    "tierBudgetMs:",
    "  edit: 2000",
    "  commit: 10000",
    "  boundary: 120000",
    "loopBreakerRepeats: 3",
    "",
  ].join("\n");

const projectFiles = (root: string, globs: string[]): string[] => {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  return out
    .split("\0")
    .filter((f) => f !== "" && existsSync(join(root, f)) && statSync(join(root, f)).isFile() && globs.some((g) => matchesGlob(f, g)));
};

const SETTINGS = ".claude/settings.json";

const selectPacks = async (root: string, wardenRoot: string, requested: string[]): Promise<string[]> => {
  const available = await listPacks(root, wardenRoot);
  const known = available.map((r) => r.id);
  const action = `Next action: ${initAction(available)}.`;
  const unknown = requested.filter((id) => !known.includes(id));
  if (unknown.length > 0) throw new Error(`unknown pack ${unknown.join(", ")}; available packs are ${known.join(", ")}. ${action}`);
  const dup = requested.find((id, i) => requested.indexOf(id) !== i);
  if (dup !== undefined) throw new Error(`pack ${dup} is listed more than once. ${action}`);
  if (!requested.includes("core")) throw new Error(`core is required because it carries the rules that protect every other rule. Next action: run warden init --packs core,${requested.join(",")}.`);
  return requested;
};

export async function runInit(root: string, wardenRoot: string, requested: string[] = ["core"]): Promise<number> {
  if (existsSync(join(root, CONFIG_PATH))) throw new RecordError(join(root, ".warden"), "", "already exists; init refuses to overwrite it");
  verifyBase(root, "main");
  const packs = await selectPacks(root, wardenRoot, requested);
  const warden = join(root, ".warden");
  const wardenExisted = existsSync(warden);
  const claudeExisted = existsSync(join(root, ".claude"));
  const settings = existsSync(join(root, SETTINGS)) ? readFileSync(join(root, SETTINGS), "utf8") : undefined;
  try {
    return await initialize(root, wardenRoot, packs);
  } catch (cause) {
    if (wardenExisted) for (const entry of readdirSync(warden)) if (entry !== "packs") rmSync(join(warden, entry), { recursive: true, force: true });
    if (!wardenExisted) rmSync(warden, { recursive: true, force: true });
    if (settings !== undefined) writeFileSync(join(root, SETTINGS), settings);
    else rmSync(join(root, claudeExisted ? SETTINGS : ".claude"), { recursive: true, force: true });
    throw cause;
  }
}

async function initialize(root: string, wardenRoot: string, packs: string[]): Promise<number> {
  mkdirSync(join(root, ".warden"), { recursive: true });
  writeFileSync(join(root, CONFIG_PATH), configText(basename(root), await wardenVersion(wardenRoot), packs));

  const compiled = await compile(root, wardenRoot);
  if (compiled.findings.length > 0) {
    throw new RecordError(CONFIG_PATH, "", compiled.findings.map((f) => f.message).join("; "));
  }

  const set = await loadRecords(root, wardenRoot);
  const guardrails = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.filter((g) => g.kind !== "instruction")));
  const files = projectFiles(root, set.config.packs.flatMap((p) => p.paths));
  const results = files.length === 0 ? [] : await runGuardrails(guardrails, files, { root, generatedDir: join(root, ".warden/generated"), unbudgeted: true });
  const unparsed = results.filter((r) => r.guardrail === PARSE_ERROR).flatMap((r) => r.violations.map((v) => `${v.file}:${v.line}`));
  if (unparsed.length > 0) throw new RecordError("", "", `cannot baseline files that do not parse: ${unparsed.join(", ")}. Next action: fix the syntax error, then run warden init again.`);

  const baseline: Baseline = {};
  for (const r of results) {
    for (const v of r.violations) {
      const entries = (baseline[r.guardrail] ??= {});
      entries[v.file] = (entries[v.file] ?? 0) + 1;
    }
  }
  writeBaseline(root, baseline);
  const total = Object.values(baseline).reduce((n, e) => n + Object.values(e).reduce((a, b) => a + b, 0), 0);
  process.stdout.write(`Initialized .warden in ${root}: ${guardrails.length} Guardrails, ${total} existing violations baselined across ${files.length} files.\n`);
  return 0;
}
