#!/usr/bin/env node
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { compile } from "../compiler/compile.js";
import type { Tier } from "../records/types.js";
import type { Format } from "../runner/feedback.js";
import { runBench } from "./bench.js";
import { runCheck } from "./check.js";
import { runExplain } from "./explain.js";
import { runDoctor, runInit } from "./init.js";
import { runPacks } from "./packs.js";
import { runReport } from "./report.js";
import { runRuns } from "./runs.js";
import { liveView, loadView, plainView } from "./view.js";
import { wardenHome } from "../runner/evidence.js";

const findWardenRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "packs")) || !existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("cannot locate the Warden package root");
    dir = parent;
  }
  return dir;
};

const oneOf = <T extends string>(name: string, value: string, allowed: readonly T[]): T => {
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`--${name} must be one of ${allowed.join(", ")}`);
  return value as T;
};

const program = new Command("warden")
  .version((JSON.parse(readFileSync(join(findWardenRoot(), "package.json"), "utf8")) as { version: string }).version)
  .exitOverride();
const root = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error(`${process.cwd()} is not a git repository; run warden inside the project's git checkout`);
  }
};

program
  .command("init")
  .description("create .warden, compile, and baseline current violations")
  .option("--packs <ids>", "comma-separated pack ids; must include core", "core")
  .action(async (o: { packs: string }) => {
    process.exitCode = await runInit(root(), findWardenRoot(), o.packs.split(",").map((id) => id.trim()));
  });

program.command("doctor").description("check that Warden's bundled tools load and every cmd Guardrail's command resolves").action(async () => {
  process.exitCode = await runDoctor(root(), findWardenRoot());
});

program.command("packs").description("list available packs and which are on").option("--format <format>", "text or json", "text").action(async (o: { format: string }) => {
  process.exitCode = await runPacks(root(), findWardenRoot(), oneOf("format", o.format, ["text", "json"] as const) === "json");
});

program.command("compile").description("compile records into tool configs and the lock").action(async () => {
  const { findings, written } = await compile(root(), findWardenRoot());
  for (const f of findings) process.stderr.write(`${f.code} ${f.record}: ${f.message}\n`);
  if (findings.length === 0) process.stdout.write(`${written.join("\n")}\n`);
  process.exitCode = findings.length > 0 ? 2 : 0;
});

program
  .command("check [paths...]")
  .description("run Guardrails")
  .option("--rule <id>", "only this Practice or Guardrail")
  .option("--tier <tier>", "edit, commit, or boundary", "commit")
  .option("--format <format>", "text, agent, or json", "text")
  .option("--hook <hook>", "claude")
  .option("--base <ref>", "the branch this work merges into")
  .option("--trigger <trigger>", "what started this check: git-commit or manual", "manual")
  .action(async (paths: string[], o: { rule?: string; tier: string; format: string; hook?: string; base?: string; trigger: string }) => {
    process.exitCode = await runCheck({
      root: root(),
      wardenRoot: findWardenRoot(),
      paths: paths.length > 0 ? paths.map((p) => resolve(p)) : undefined,
      rule: o.rule,
      base: o.base,
      tier: oneOf<Tier>("tier", o.tier, ["edit", "commit", "boundary"]),
      format: oneOf<Format>("format", o.format, ["text", "agent", "json"]),
      hook: o.hook === undefined ? undefined : oneOf("hook", o.hook, ["claude"] as const),
      hookInput: o.hook === undefined ? undefined : readFileSync(0, "utf8"),
      trigger: oneOf("trigger", o.trigger, ["git-commit", "manual"] as const),
    });
  });

program
  .command("bench")
  .description("measure how each Guardrail's time grows with input size, and fail on a superlinear one")
  .option("--rule <id>", "only this Practice or Guardrail")
  .option("--pack <id>", "only this pack")
  .action(async (o: { rule?: string; pack?: string }) => {
    process.exitCode = await runBench(root(), findWardenRoot(), o);
  });

program.command("explain <id>").description("explain a Practice or Guardrail").action(async (id: string) => {
  process.exitCode = await runExplain(root(), findWardenRoot(), id);
});

program.command("report").description("Guardrails grouped by Practice, strongest kind first").option("--json", "print JSON").option("--format <format>", "text or json", "text").action(async (o: { json?: boolean; format: string }) => {
  process.exitCode = await runReport(root(), findWardenRoot(), o.json === true || oneOf("format", o.format, ["text", "json"] as const) === "json");
});

program
  .command("runs")
  .description("the most recent checks: when, what started them, and whether they passed")
  .option("--limit <n>", "how many runs to show", "20")
  .option("--format <format>", "text or json", "text")
  .option("--follow", "print each new run as it lands, until interrupted")
  .option("--html <file>", "write one self-contained page of the runs, Practices, and failures")
  .action(async (o: { limit: string; format: string; follow?: boolean; html?: string }) => {
    const stop = new AbortController();
    process.once("SIGINT", () => stop.abort());
    process.exitCode = await runRuns(root(), findWardenRoot(), {
      limit: Number(o.limit),
      format: oneOf("format", o.format, ["text", "json"] as const),
      follow: o.follow === true,
      signal: stop.signal,
      ...(o.html === undefined ? {} : { html: o.html }),
    });
  });

program.action(async (_options: unknown, command: Command) => {
  if (command.args.length > 0) throw new Error(`unknown command ${command.args[0] as string}. Next action: run warden --help`);
  const project = root();
  const wardenRoot = findWardenRoot();
  const model = await loadView(project, wardenRoot);
  if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
    process.stdout.write(plainView(model));
    return;
  }
  const watchDir = join(wardenHome(), "evidence");
  mkdirSync(watchDir, { recursive: true });
  let child: ChildProcess | undefined;
  const rerun = (): void => {
    if (child !== undefined && child.exitCode === null) return;
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), "check", "--base", model.base, "--trigger", "manual"], { cwd: project, stdio: "ignore" });
  };
  try {
    process.exitCode = await liveView({ input: process.stdin, output: process.stdout, watchDir, rerun, load: () => loadView(project, wardenRoot) });
  } finally {
    if (child !== undefined && child.exitCode === null) child.kill();
  }
});

try {
  await program.parseAsync(process.argv);
} catch (cause) {
  if (cause instanceof CommanderError) {
    process.exitCode = cause.exitCode === 0 ? 0 : 2;
  } else {
    process.stderr.write(`${(cause as Error).message}\n`);
    process.exitCode = 2;
  }
}
