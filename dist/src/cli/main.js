#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { refusal } from "../adapters/claude.js";
import { compile, wardenVersion } from "../compiler/compile.js";
import { runBench } from "./bench.js";
import { runCheck } from "./check.js";
import { runExplain } from "./explain.js";
import { runDoctor, runInit } from "./init.js";
import { runPacks } from "./packs.js";
import { runReport } from "./report.js";
import { runRuns } from "./runs.js";
import { liveView, loadView, plainLayers, plainView, plainViolations } from "./view.js";
import { wardenHome } from "../runner/evidence.js";
const findWardenRoot = () => {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(dir, "packs")) || !existsSync(join(dir, "package.json"))) {
        const parent = dirname(dir);
        if (parent === dir)
            throw new Error("cannot locate the Warden package root");
        dir = parent;
    }
    return dir;
};
const oneOf = (command, name, value, allowed) => {
    if (!allowed.includes(value))
        throw new Error(`--${name} must be one of ${allowed.join(", ")}. Next action: run warden ${command} --help`);
    return value;
};
const program = new Command("warden").exitOverride();
const root = () => {
    try {
        return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    }
    catch {
        throw new Error(`${process.cwd()} is not a git repository; run warden inside the project's git checkout`);
    }
};
program
    .command("init")
    .description("create .warden, compile, and baseline current violations")
    .option("--packs <ids>", "comma-separated pack ids; must include core", "core")
    .option("--base <ref>", "the branch or ref that changes are measured against; must resolve to a commit", "main")
    .action(async (o) => {
    process.exitCode = await runInit(root(), findWardenRoot(), o.packs.split(",").map((id) => id.trim()), o.base);
});
program.command("doctor").description("check that Warden's bundled tools load and every cmd Guardrail's command resolves").action(async () => {
    process.exitCode = await runDoctor(root(), findWardenRoot());
});
program.command("packs").description("list available packs and which are on").option("--format <format>", "text or json", "text").action(async (o) => {
    process.exitCode = await runPacks(root(), findWardenRoot(), oneOf("packs", "format", o.format, ["text", "json"]) === "json");
});
program.command("compile").description("compile records into tool configs and the lock").action(async () => {
    const { findings, written } = await compile(root(), findWardenRoot());
    for (const f of findings)
        process.stderr.write(`${f.code} ${f.record}: ${f.message}\n`);
    if (findings.length === 0)
        process.stdout.write(`${written.join("\n")}\n`);
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
    .action(async (paths, o) => {
    process.exitCode = await runCheck({
        root: root(),
        wardenRoot: findWardenRoot(),
        paths: paths.length > 0 ? paths.map((p) => resolve(p)) : undefined,
        rule: o.rule,
        base: o.base,
        tier: oneOf("check", "tier", o.tier, ["edit", "commit", "boundary"]),
        format: oneOf("check", "format", o.format, ["text", "agent", "json"]),
        hook: o.hook === undefined ? undefined : oneOf("check", "hook", o.hook, ["claude"]),
        hookInput: o.hook === undefined ? undefined : readFileSync(0, "utf8"),
        trigger: oneOf("check", "trigger", o.trigger, ["git-commit", "manual"]),
    });
});
program.command("guard").description("refuse a Claude Code tool call that edits .warden or skips the pre-commit hook; reads the PreToolUse input on stdin").action(() => {
    const reason = refusal(root(), readFileSync(0, "utf8"));
    if (reason !== undefined)
        process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}\n`);
});
program
    .command("bench")
    .description("measure how each Guardrail's time grows with input size, and fail on a superlinear one")
    .option("--rule <id>", "only this Practice or Guardrail")
    .option("--pack <id>", "only this pack")
    .action(async (o) => {
    process.exitCode = await runBench(root(), findWardenRoot(), o);
});
program.command("explain <id>").description("explain a Practice or Guardrail").action(async (id) => {
    process.exitCode = await runExplain(root(), findWardenRoot(), id);
});
program.command("report").description("Guardrails grouped by Practice, strongest kind first").option("--json", "print JSON").option("--format <format>", "text or json", "text").action(async (o) => {
    process.exitCode = await runReport(root(), findWardenRoot(), o.json === true || oneOf("report", "format", o.format, ["text", "json"]) === "json");
});
program
    .command("runs")
    .description("the most recent checks: when, what started them, and whether they passed")
    .option("--limit <n>", "how many runs to show", "20")
    .option("--format <format>", "text or json", "text")
    .option("--follow", "print each new run as it lands, until interrupted")
    .option("--html <file>", "write one self-contained page of the runs, Practices, and failures")
    .action(async (o) => {
    const stop = new AbortController();
    if (o.follow === true)
        process.once("SIGINT", () => stop.abort());
    process.exitCode = await runRuns(root(), findWardenRoot(), {
        limit: Number(o.limit),
        format: oneOf("runs", "format", o.format, ["text", "json"]),
        follow: o.follow === true,
        signal: stop.signal,
        ...(o.html === undefined ? {} : { html: o.html }),
    });
});
program
    .option("--layers", "show the layers screen: every rule by strength, and the packs")
    .option("--violations", "show the violations screen: baselined and new violations for each pack and Guardrail")
    .action(async (options, command) => {
    if (command.args.length > 0)
        throw new Error(`unknown command ${command.args[0]}. Next action: run warden --help`);
    const project = root();
    const wardenRoot = findWardenRoot();
    if (options.layers === true && options.violations === true)
        throw new Error("--layers and --violations each open one screen. Next action: run warden with only one of them");
    const screen = options.violations === true ? "violations" : options.layers === true ? "layers" : "runs";
    const model = await loadView(project, wardenRoot);
    if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
        const cols = Number(process.env.COLUMNS) || 80;
        process.stdout.write(screen === "violations" ? plainViolations(model, cols) : screen === "layers" ? plainLayers(model, cols) : plainView(model, cols));
        return;
    }
    const watchDir = join(wardenHome(), "evidence");
    mkdirSync(watchDir, { recursive: true });
    let child;
    const rerun = () => {
        if (child !== undefined && child.exitCode === null)
            return;
        child = spawn(process.execPath, [fileURLToPath(import.meta.url), "check", "--base", model.base, "--trigger", "manual"], { cwd: project, stdio: "ignore" });
    };
    try {
        process.exitCode = await liveView({ input: process.stdin, output: process.stdout, watchDir, file: `${model.project}.jsonl`, screen, rerun, load: () => loadView(project, wardenRoot) });
    }
    finally {
        if (child !== undefined && child.exitCode === null)
            child.kill();
    }
});
try {
    program.version(await wardenVersion(findWardenRoot()));
    await program.parseAsync(process.argv);
}
catch (cause) {
    if (cause instanceof CommanderError) {
        process.exitCode = cause.exitCode === 0 ? 0 : 2;
    }
    else {
        process.stderr.write(`${cause.message}\n`);
        process.exitCode = 2;
    }
}
