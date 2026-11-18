import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, matchesGlob } from "node:path";
import { compile, wardenVersion } from "../compiler/compile.js";
import { RecordError, loadRecords } from "../records/load.js";
import { PARSE_ERROR } from "../adapters/types.js";
import { type Baseline, writeBaseline } from "../runner/baseline.js";
import { verifyBase } from "../runner/changed.js";
import { runGuardrails } from "../runner/run.js";

const CONFIG_PATH = ".warden/config.yaml";

const configText = (project: string, version: string): string =>
  [
    `warden: ${JSON.stringify(version)}`,
    `project: ${JSON.stringify(project)}`,
    "base: main",
    "packs:",
    "  - id: core",
    '    paths: ["**/*.{ts,tsx,js,mjs}"]',
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

export async function runInit(root: string, wardenRoot: string): Promise<number> {
  if (existsSync(join(root, ".warden"))) throw new RecordError(join(root, ".warden"), "", "already exists; init refuses to overwrite it");
  verifyBase(root, "main");
  const claudeExisted = existsSync(join(root, ".claude"));
  const settings = existsSync(join(root, SETTINGS)) ? readFileSync(join(root, SETTINGS), "utf8") : undefined;
  try {
    return await initialize(root, wardenRoot);
  } catch (cause) {
    rmSync(join(root, ".warden"), { recursive: true, force: true });
    if (settings !== undefined) writeFileSync(join(root, SETTINGS), settings);
    else rmSync(join(root, claudeExisted ? SETTINGS : ".claude"), { recursive: true, force: true });
    throw cause;
  }
}

async function initialize(root: string, wardenRoot: string): Promise<number> {
  mkdirSync(join(root, ".warden"));
  writeFileSync(join(root, CONFIG_PATH), configText(basename(root), await wardenVersion(wardenRoot)));

  const compiled = await compile(root, wardenRoot);
  if (compiled.findings.length > 0) {
    throw new RecordError(CONFIG_PATH, "", compiled.findings.map((f) => f.message).join("; "));
  }

  const set = await loadRecords(root, wardenRoot);
  const guardrails = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.filter((g) => g.kind !== "instruction")));
  const files = projectFiles(root, set.config.packs.flatMap((p) => p.paths));
  const results = files.length === 0 ? [] : await runGuardrails(guardrails, files, { root, generatedDir: join(root, ".warden/generated") });
  const unparsed = results.filter((r) => r.guardrail === PARSE_ERROR).flatMap((r) => r.violations.map((v) => `${v.file}:${v.line}`));
  if (unparsed.length > 0) throw new RecordError("", "", `cannot baseline files that do not parse: ${unparsed.join(", ")}. Next action: fix the syntax error, then run warden init again.`);
  const slow = results.filter((r) => r.status === "over-budget").map((r) => r.guardrail);
  if (slow.length > 0) throw new RecordError("", "", `cannot baseline: ${slow.join(", ")} exceeded its time budget`);

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
