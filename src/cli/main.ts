#!/usr/bin/env node
import "./require-node.js";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { refusal } from "../adapters/claude.js";
import { compile, wardenVersion } from "../compiler/compile.js";
import { thenRemoveExampleProjects } from "../compiler/examples.js";
import { COMMAND_PROBE, UNKNOWN_COMMAND } from "../compiler/skills.js";
import { findWardenRoot } from "../records/load.js";
import type { Tier } from "../records/types.js";
import type { Format } from "../runner/feedback.js";
import { runBench } from "./bench.js";
import { runCheck } from "./check.js";
import { DEFAULT_PORT, installDaemon, runDaemon, uninstallDaemon } from "./daemon.js";
import { runDispute } from "./dispute.js";
import { runExplain } from "./explain.js";
import { runDoctor, runInit } from "./init.js";
import { runPacks } from "./packs.js";
import { runReport } from "./report.js";
import { type ReviewOptions, reviewOptions, runBrief, runTriage } from "./review.js";
import { runRuns } from "./runs.js";
import { runWhere } from "./where.js";
import { type Screen, liveView, loadView, plainDeterminism, plainLayers, plainView, plainViolations } from "./view.js";
import { wardenHome } from "../runner/evidence.js";

const oneOf = <T extends string>(command: string, name: string, value: string, allowed: readonly T[]): T => {
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`--${name} must be one of ${allowed.join(", ")}. Next action: run warden ${command} --help`);
  return value as T;
};

const outputClosed = new AbortController();
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (cause: NodeJS.ErrnoException) => {
    if (cause.code !== "EPIPE") throw cause;
    outputClosed.abort();
  });
}

const program = new Command("warden").exitOverride().enablePositionalOptions().passThroughOptions();
const root = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Git is not available. Next action: install git and put it on PATH, then run the command again");
    }
    throw new Error(`${process.cwd()} is not a git repository; run warden inside the project's git checkout`);
  }
};

program
  .command("init")
  .description("create .warden, compile, and baseline current violations")
  .option("--packs <ids>", "comma-separated pack ids; must include core", "core")
  .option("--base <ref>", "the branch or ref that changes are measured against; must resolve to a commit", "main")
  .action(async (o: { packs: string; base: string }) => {
    process.exitCode = await runInit(root(), findWardenRoot(), o.packs.split(",").map((id) => id.trim()), o.base);
  });

program.command("doctor").description("check that Warden's bundled tools load and every cmd Guardrail's command resolves").action(async () => {
  process.exitCode = await runDoctor(root(), findWardenRoot());
});

program.command("packs").description("list available packs and which are on").option("--format <format>", "text or json", "text").action(async (o: { format: string }) => {
  process.exitCode = await runPacks(root(), findWardenRoot(), oneOf("packs", "format", o.format, ["text", "json"] as const) === "json");
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
      tier: oneOf<Tier>("check", "tier", o.tier, ["edit", "commit", "boundary"]),
      format: oneOf<Format>("check", "format", o.format, ["text", "agent", "json"]),
      hook: o.hook === undefined ? undefined : oneOf("check", "hook", o.hook, ["claude"] as const),
      hookInput: o.hook === undefined ? undefined : readFileSync(0, "utf8"),
      trigger: oneOf("check", "trigger", o.trigger, ["git-commit", "manual"] as const),
    });
  });

program.command("guard").description("refuse a Claude Code tool call that edits .warden or skips the pre-commit hook; reads the PreToolUse input on stdin").action(() => {
  const reason = refusal(root(), readFileSync(0, "utf8"));
  if (reason !== undefined) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}\n`);
});

program
  .command("bench")
  .description("measure how each Guardrail's time grows with input size, and fail on a superlinear one")
  .option("--rule <id>", "only this Practice or Guardrail")
  .option("--pack <id>", "only this pack")
  .action(async (o: { rule?: string; pack?: string }) => {
    process.exitCode = await runBench(root(), findWardenRoot(), o);
  });

program.command("where <term-unit-or-path>").description("locate a Unit and its document").action(async (query: string) => {
  process.exitCode = await runWhere(root(), findWardenRoot(), query);
});

program.command("explain <id>").description("explain a Practice or Guardrail").action(async (id: string) => {
  process.exitCode = await runExplain(root(), findWardenRoot(), id);
});

program
  .command("dispute <guardrail> <path>")
  .description("record an objection and the compliant approaches already tried")
  .option("--reason <reason>", "why the Guardrail does not fit")
  .option("--attempt <approaches...>", "compliant approaches you tried")
  .action(async (guardrail: string, path: string, options: { reason?: string; attempt?: string[] }) => {
    process.exitCode = await runDispute(root(), findWardenRoot(), guardrail, resolve(path), options);
  });

program.command("report").description("Guardrails grouped by Practice, strongest kind first").option("--json", "print JSON").option("--format <format>", "text or json", "text").action(async (o: { json?: boolean; format: string }) => {
  process.exitCode = await runReport(root(), findWardenRoot(), o.json === true || oneOf("report", "format", o.format, ["text", "json"] as const) === "json");
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
    if (o.follow === true) process.once("SIGINT", () => stop.abort());
    process.exitCode = await runRuns(root(), findWardenRoot(), {
      limit: Number(o.limit),
      format: oneOf("runs", "format", o.format, ["text", "json"] as const),
      follow: o.follow === true,
      signal: AbortSignal.any([stop.signal, outputClosed.signal]),
      ...(o.html === undefined ? {} : { html: o.html }),
    });
  });

const review = program.command("review").description("brief a reviewer on a change, and triage the reviewer's report");
const reviewFlags = (c: Command): Command =>
  c
    .option("--capability <id>", "the Capability with a review block")
    .option("--base <ref>", "the branch the change merges into")
    .option("--head <ref>", "the head to review")
    .option("--previous-head <ref>", "the head the previous round reviewed; makes this round 2")
    .option("--previous-report <file>", "the reviewer's report of the previous round; needs --previous-head")
    .option("--requirements <paths...>", "files that state what the change must do");
reviewFlags(review.command("brief").description("print the reviewer's full invocation as JSON"))
  .option("--previous <file>", "the triage JSON of the previous round")
  .action(async (o: Partial<ReviewOptions>) => {
    process.exitCode = await runBrief(root(), findWardenRoot(), reviewOptions("brief", o));
  });
reviewFlags(review.command("triage").description("route the reviewer's report by kind to one next action"))
  .option("--report <file>", "the reviewer's report")
  .option("--format <format>", "text or json", "text")
  .action(async (o: Partial<ReviewOptions>) => {
    process.exitCode = await runTriage(root(), findWardenRoot(), reviewOptions("triage", { ...o, format: oneOf("review triage", "format", o.format ?? "text", ["text", "json"] as const) }));
  });

program
  .command("daemon [action]")
  .description("run the per-machine daemon that watches .warden projects and serves the local API; install or uninstall it as a launchd agent")
  .option("--port <n>", "the 127.0.0.1 port for the API", String(DEFAULT_PORT))
  .action(async (action: string | undefined, o: { port: string }) => {
    const port = Number(o.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be an integer from 0 to 65535, not ${o.port}. Next action: run warden daemon --port ${DEFAULT_PORT}`);
    const chosen = action === undefined ? "run" : oneOf("daemon", "action", action, ["install", "uninstall"] as const);
    if (chosen === "install") process.exitCode = installDaemon(fileURLToPath(import.meta.url), port);
    else if (chosen === "uninstall") process.exitCode = uninstallDaemon();
    else process.exitCode = await runDaemon(findWardenRoot(), port);
  });

program
  .option("--layers", "show the layers screen: every rule by strength, and the packs")
  .option("--violations", "show the violations screen: baselined and new violations for each pack and Guardrail")
  .option("--determinism", "show the determinism screen: each project's last-run failures split into deterministic, judgment, and prose")
  .action(async (options: { layers?: boolean; violations?: boolean; determinism?: boolean }, command: Command) => {
    if (command.args.length > 0) throw new Error(`unknown command ${command.args[0] as string}. Next action: run warden --help`);
    const project = root();
    const wardenRoot = findWardenRoot();
    const screens = (["layers", "violations", "determinism"] as const).filter((name) => options[name] === true);
    if (screens.length > 1) throw new Error("--layers, --violations, and --determinism each open one screen. Next action: run warden with only one of them");
    const screen: Screen = screens[0] ?? "runs";
    const model = await loadView(project, wardenRoot);
    if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
      const cols = Number(process.env.COLUMNS) || 80;
      process.stdout.write(screen === "violations" ? plainViolations(model, cols) : screen === "layers" ? plainLayers(model, cols) : screen === "determinism" ? plainDeterminism(model, cols) : plainView(model, cols));
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
      process.exitCode = await liveView({ input: process.stdin, output: process.stdout, watchDir, file: `${model.project}.jsonl`, screen, rerun, load: () => loadView(project, wardenRoot) });
    } finally {
      if (child !== undefined && child.exitCode === null) child.kill();
    }
  });

function canProbe(words: string[]): boolean {
  if (words.length === 0) return false;
  let scope = program;
  for (const word of words) {
    const command = scope.commands.find((entry) => entry.name() === word || entry.aliases().includes(word));
    if (command === undefined) return false;
    if (command.commands.length === 0) return true;
    scope = command;
  }
  return true;
}

await thenRemoveExampleProjects(
  async () => {
    program.version(await wardenVersion(findWardenRoot()));
    if (process.env[COMMAND_PROBE] === "1" && !canProbe(process.argv.slice(2, -1))) {
      process.exitCode = UNKNOWN_COMMAND;
      return;
    }
    await program.parseAsync(process.argv);
  },
  (cause) => {
    if (cause instanceof CommanderError) {
      process.exitCode = cause.exitCode === 0 ? 0 : 2;
    } else {
      process.stderr.write(`${(cause as Error).message}\n`);
      process.exitCode = 2;
    }
  },
);
