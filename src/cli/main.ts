#!/usr/bin/env node
import "./require-node.js";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { agentNote, guardFinding } from "../adapters/claude.js";
import { compile, wardenVersion } from "../compiler/compile.js";
import { thenRemoveExampleProjects } from "../compiler/examples.js";
import { COMMAND_PROBE, UNKNOWN_COMMAND } from "../compiler/skills.js";
import { RecordError, findWardenRoot } from "../records/load.js";
import type { Tier } from "../records/types.js";
import type { Format } from "../runner/feedback.js";
import { runBench } from "./bench.js";
import { runAudit, runCheck } from "./check.js";
import { installDaemon, runDaemon, uninstallDaemon } from "./daemon.js";
import { runDispute, runDisputeRuling } from "./dispute.js";
import { runExplain } from "./explain.js";
import { runEnrollCompile, runEnrollMigrate, runEnrollSign } from "./enroll.js";
import { runDoctor, runInit } from "./init.js";
import { runMutationReview } from "./mutations.js";
import { runNewCapability } from "./new-capability.js";
import { runNewUnit } from "./new-unit.js";
import { runPacks } from "./packs.js";
import { publishESLint } from "./publish.js";
import { runLearningReport, runReport } from "./report.js";
import { type ReviewOptions, reviewOptions, runBrief, runReviewConfirm, runReviewHistory, runReviewProposals, runReviewRecord, runReviewRule, runTriage } from "./review.js";
import { recordClaudeStalls } from "./session-end.js";
import { runRuns } from "./runs.js";
import { runWhere } from "./where.js";
import { runTrust } from "./trust.js";
import { MAX_KEYFRAMES, runVideoRecord } from "./video.js";
import { type Screen, liveView, loadView, plainDeterminism, plainLayers, plainView, plainViolations } from "./view.js";
import { SKILL_HARNESSES } from "../runner/doctor.js";
import { wardenHome } from "../runner/evidence.js";
import { DEFAULT_PORT, isAuditOnlyCheckout } from "../runner/daemon.js";

const oneOf = <T extends string>(command: string, name: string, value: string, allowed: readonly T[]): T => {
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`--${name} must be one of ${allowed.join(", ")}. Next action: run warden ${command} --help`);
  return value as T;
};

const NEVER_BLOCK = new Set(["check", "audit", "guard", "session-end", "publish"]);
const reportVerdict = (verdict: number): void => {
  if (verdict !== 0) process.stderr.write(`Warden reported problems (verdict ${verdict}) and exits 0, because Warden never blocks work.\n`);
  process.exitCode = 0;
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

program
  .command("doctor")
  .description("check Warden's tools, commands, hooks and generated skill links")
  .option("--harness <harness>", "which harness to check: claude or codex", "claude")
  .action(async ({ harness }: { harness: string }) => {
    process.exitCode = await runDoctor(root(), findWardenRoot(), oneOf("doctor", "harness", harness, SKILL_HARNESSES));
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
    const checkout = root();
    const trigger = oneOf("check", "trigger", o.trigger, ["git-commit", "manual"] as const);
    if ((o.hook !== undefined || trigger === "git-commit") && isAuditOnlyCheckout(checkout)) return;
    reportVerdict(await runCheck({
      root: checkout,
      wardenRoot: findWardenRoot(),
      paths: paths.length > 0 ? paths.map((p) => resolve(p)) : undefined,
      rule: o.rule,
      base: o.base,
      tier: oneOf<Tier>("check", "tier", o.tier, ["edit", "commit", "boundary"]),
      format: oneOf<Format>("check", "format", o.format, ["text", "agent", "json"]),
      hook: o.hook === undefined ? undefined : oneOf("check", "hook", o.hook, ["claude"] as const),
      hookInput: o.hook === undefined ? undefined : readFileSync(0, "utf8"),
      trigger,
    }));
  });

program
  .command("audit [paths...]")
  .description("run advisory checks and report findings")
  .option("--rule <id>", "only this Practice or Guardrail")
  .option("--tier <tier>", "edit or boundary", "edit")
  .option("--format <format>", "text or json", "text")
  .option("--base <ref>", "the branch this work merges into")
  .action(async (paths: string[], o: { rule?: string; tier: string; format: string; base?: string }) => {
    reportVerdict(await runAudit({
      root: root(),
      wardenRoot: findWardenRoot(),
      paths: paths.length > 0 ? paths.map((p) => resolve(p)) : undefined,
      rule: o.rule,
      base: o.base,
      tier: oneOf("audit", "tier", o.tier, ["edit", "boundary"] as const),
      format: oneOf("audit", "format", o.format, ["text", "json"] as const),
    }));
  });

program
  .command("guard")
  .description("check a harness PreToolUse request against Warden's editing, commit, and command policies; read input on stdin")
  .option("--compiled-replacements", "require the compiled Capability command policy for shell requests")
  .action((options: { compiledReplacements?: boolean }) => {
    const checkout = root();
    if (isAuditOnlyCheckout(checkout)) return;
    const finding = guardFinding(checkout, readFileSync(0, "utf8"), options.compiledReplacements === true);
    if (finding !== undefined) process.stdout.write(agentNote("PreToolUse", finding));
  });

program
  .command("session-end", { hidden: true })
  .action(() => {
    const checkout = root();
    if (isAuditOnlyCheckout(checkout)) return;
    recordClaudeStalls(checkout, readFileSync(0, "utf8"));
  });

program
  .command("bench")
  .description("measure how each Guardrail's time grows with input size, and fail on a superlinear one")
  .option("--rule <id>", "only this Practice or Guardrail")
  .option("--pack <id>", "only this pack")
  .action(async (o: { rule?: string; pack?: string }) => {
    process.exitCode = await runBench(root(), findWardenRoot(), o);
  });

program.command("where <term-unit-or-path>")
  .description("locate a Unit document or the Capability that serves a Term")
  .option("--capability", "search only for a Capability serving this Term")
  .action(async (query: string, options: { capability?: boolean }) => {
    process.exitCode = await runWhere(root(), findWardenRoot(), query, options.capability === true);
  });

const newRecord = program.command("new").description("scaffold Warden records");
newRecord
  .command("unit <id> <folder>")
  .description("create a Unit record and its required document")
  .requiredOption("--kind <kind>", "Unit kind declared in .warden/config.yaml")
  .option("--term <term>", "Term that also identifies the Unit")
  .option("--public-entry <file>", "public JavaScript or TypeScript entry relative to the Unit folder")
  .action(async (id: string, folder: string, { kind, term, publicEntry }: { kind: string; term?: string; publicEntry?: string }) => {
    process.exitCode = await runNewUnit(root(), findWardenRoot(), {
      id, folder, kind,
      ...(term === undefined ? {} : { term }),
      ...(publicEntry === undefined ? {} : { publicEntry }),
    });
  });

for (const kind of ["skill", "tool"] as const) {
  newRecord.command(`${kind} <id>`)
    .description(`add a ${kind} Capability to a local pack`)
    .requiredOption("--pack <id>", "enabled local pack that will own the Capability")
    .requiredOption("--serves <term>", "Term that identifies its purpose")
    .requiredOption("--purpose <text>", "what the Capability does")
    .requiredOption("--when <text>", "when to use the Capability")
    .requiredOption("--command <commands...>", kind === "tool" ? "quoted Warden or local tool commands" : "quoted Warden command lines")
    .option("--upholds <practices...>", "Practices this Capability enforces", [])
    .option("--replaces <actions...>", "ad hoc actions this Capability replaces", [])
    .action(async (id: string, options: { pack: string; serves: string; purpose: string; when: string; command: string[]; upholds: string[]; replaces: string[] }) => {
      const { pack, command, ...fields } = options;
      process.exitCode = await runNewCapability(root(), findWardenRoot(), pack, { ...fields, id, kind, commands: command });
    });
}

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

program
  .command("report")
  .description("Guardrails grouped by Practice, strongest kind first")
  .option("--learning", "show precision and confirmed Practice escapes")
  .option("--json", "print JSON")
  .option("--format <format>", "text or json", "text")
  .action(async (o: { learning?: boolean; json?: boolean; format: string }) => {
    const report = o.learning === true ? runLearningReport : runReport;
    process.exitCode = await report(root(), findWardenRoot(), o.json === true || oneOf("report", "format", o.format, ["text", "json"] as const) === "json");
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

const video = program.command("video").description("record a UI change for the owner with the change-video pack");
video
  .command("record")
  .description("replay a UI change in agent-browser, record a WebM for the owner, and keep it with this checkout's latest run, which must have checked HEAD")
  .requiredOption("--url <url>", "the dev server page your change affects")
  .requiredOption("--steps <file>", "a Bash file of the flow your diff changes; see below")
  .addHelpText("after", `
The steps file runs inside the recording, after the page at --url opens at
1280 x 800. Call agent-browser through ab, and use wait as the assertions:

  ab wait '#save'                          # fails the replay if it never appears
  ab screenshot "$OUT/01-before.jpg"
  ab click '#save'
  ab wait --text 'Saved' --timeout 5000
  ab screenshot "$OUT/02-after.jpg"

Cover only the flow your diff changes. A page error also fails the replay.
For another width, run ab set viewport <width> <height> and take one keyframe
for it.

Cost rules:
- Never read the video or extract frames from it. It is for the owner.
- Take at most ${MAX_KEYFRAMES} keyframes, saved as "$OUT/NN-name.jpg"; write nothing
  else to $OUT. Read each one and compare it with what the change must show.
- Run the replay once per coherent change, not after every edit.
- Use agent-browser snapshot -i only to find selectors, scoped to your change.
- Reuse the dev server that serves this checkout.

When the replay fails, fix the app if it is wrong; fix the steps only when a
selector or expected text is wrong, and say which one you changed.

Report, one line each: the exit code and any failed assertion; what each
keyframe shows against what the change requires; the run page link and the
paths of the video, keyframes, and steps file; and what the replay does not
cover, such as other widths, empty states, or error states.`)
  .action(async (o: { url: string; steps: string }) => {
    process.exitCode = await runVideoRecord(root(), findWardenRoot(), o);
  });

const review = program.command("review").description("brief a reviewer on a change, and triage the reviewer's report");
const reviewScopeFlags = (c: Command): Command =>
  c
    .option("--capability <id>", "the Capability with a review block")
    .option("--base <ref>", "the branch the change merges into")
    .option("--head <ref>", "the head to review")
    .option("--component <name>", "the component to audit with component-quality")
    .option("--pull-request <url>", "the GitHub pull request to review with code-review")
    .option("--requirements <paths...>", "files that state what the change must do");
const reviewFlags = (c: Command): Command =>
  reviewScopeFlags(c)
    .option("--previous-head <ref>", "the head the previous round reviewed; makes this round 2")
    .option("--previous-report <file>", "the reviewer's report of the previous round; needs --previous-head");
const reviewSeriesFlags = (c: Command): Command =>
  c.requiredOption("--series <id>", "the controller's stable change ID")
    .requiredOption("--target <name>", "the Unit or other review target");
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

reviewSeriesFlags(reviewScopeFlags(review.command("record").description("validate and save a completed review round")))
  .option("--report <file>", "the reviewer's report")
  .option("--previous-round <id>", "the preceding completed round ID")
  .action(async (o: Partial<ReviewOptions> & { series: string; target: string; previousRound?: string }) => {
    process.exitCode = await runReviewRecord(root(), findWardenRoot(), reviewOptions("record", o), o);
  });
reviewSeriesFlags(review.command("history").description("list completed review rounds for a series"))
  .requiredOption("--capability <id>", "the recording Capability")
  .option("--round <id>", "show the full record and native report for this round")
  .action((o: { series: string; target: string; capability: string; round?: string }) => {
    process.exitCode = runReviewHistory(root(), o);
  });
review.command("proposals").description("list repository proposals or Add proposals for one review series")
  .option("--series <id>", "the change ID for a series query")
  .option("--target <name>", "the target for a series query")
  .option("--capability <id>", "the recording Capability for a series query")
  .option("--record", "save the proposals with their evidence and immutable IDs")
  .action(async (o: { series?: string; target?: string; capability?: string; record?: boolean }) => {
    process.exitCode = await runReviewProposals(root(), findWardenRoot(), o);
  });
review.command("mutations").description("measure the Guardrails against their declared must-fail variants")
  .requiredOption("--base <ref>", "the trusted branch the policy is compared against")
  .option("--rule <id>", "select one Practice or Guardrail")
  .option("--format <format>", "text or json", "text")
  .action(async (o: { base: string; rule?: string; format: string }) => {
    process.exitCode = await runMutationReview(root(), findWardenRoot(), o.base, o.rule, oneOf("review mutations", "format", o.format, ["text", "json"] as const));
  });
type AttributionOptions = { role: string; actor: string; reason: string; evidence: string };
type ReviewAttributionOptions = AttributionOptions & { series: string; target: string; capability: string; round: string; finding: string };
const attributionFlags = (c: Command): Command =>
  c.requiredOption("--role <role>", "independent-reviewer or repository-owner")
    .requiredOption("--actor <name>", "the identity of the person or reviewer who made the ruling")
    .requiredOption("--reason <text>", "the reason for the ruling")
    .requiredOption("--evidence <reference>", "evidence supporting the ruling");

const reviewAttributionFlags = (c: Command): Command =>
  attributionFlags(reviewSeriesFlags(c)
    .requiredOption("--capability <id>", "the recording Capability")
    .requiredOption("--round <id>", "the completed round ID")
    .requiredOption("--finding <n>", "the original finding number"));

attributionFlags(review.command("dispute <id>").description("record an attributed Guardrail dispute ruling"))
  .requiredOption("--status <status>", "upheld or rejected")
  .action(async (id: string, o: AttributionOptions & { status: string }) => {
    const status = oneOf("review dispute", "status", o.status, ["upheld", "rejected"] as const);
    const role = oneOf("review dispute", "role", o.role, ["independent-reviewer", "repository-owner"] as const);
    process.exitCode = await runDisputeRuling(root(), findWardenRoot(), id, { ...o, status, role });
  });

reviewAttributionFlags(review.command("rule").description("record a reviewer error on one finding"))
  .action((o: ReviewAttributionOptions) => {
    process.exitCode = runReviewRule(root(), { ...o, role: oneOf("review rule", "role", o.role, ["independent-reviewer", "repository-owner"] as const) });
  });
reviewAttributionFlags(review.command("confirm").description("confirm a finding as an escape for a Practice"))
  .requiredOption("--practice <id>", "the Practice that failed to catch the finding")
  .action(async (o: ReviewAttributionOptions & { practice: string }) => {
    process.exitCode = await runReviewConfirm(root(), findWardenRoot(), { ...o, role: oneOf("review confirm", "role", o.role, ["independent-reviewer", "repository-owner"] as const) });
  });

program
  .command("trust <commit>")
  .description("as the repository owner, sign that the daemon may stop flagging a commit; asks for your trust key's passphrase")
  .requiredOption("--key <file>", "your passphrase-protected private key listed in Warden's trust_signers")
  .requiredOption("--reason <text>", "why you trust the commit")
  .action((commit: string, o: { key: string; reason: string }) => {
    process.exitCode = runTrust(root(), findWardenRoot(), commit, o.key, o.reason);
  });

program.command("publish <adapter> <project> <report>")
  .description("publish an external check report for an enrolled Git ref")
  .option("--snapshot <directory>", "Git checkout that produced the report", process.cwd())
  .action((adapter: string, project: string, report: string, o: { snapshot: string }) => {
    if (adapter !== "eslint") throw new Error(`Unsupported report adapter ${adapter}. Next action: run warden publish eslint --help.`);
    const { run, ref, commit, result, files, kinds } = publishESLint(project, report, o.snapshot, findWardenRoot());
    process.stdout.write(`${JSON.stringify({ project, run, ref, commit, result, files, findings: kinds?.lint })}\n`);
  });

const enroll = program.command("enroll").description("audit a repository's ref from WARDEN_HOME, without reading policy from or writing to the repository");

enroll
  .command("migrate <repo>")
  .description("copy a repository's in-repo .warden and pack data into WARDEN_HOME, and compile it with this Warden")
  .requiredOption("--ref <ref>", "the full ref the daemon audits, such as refs/remotes/origin/main")
  .option("--from <commit>", "the commit whose .warden to copy; defaults to the ref")
  .option("--data <glob...>", "repository paths a pack reads as records, such as plugins/*/contracts.lock.json", [])
  .option("--link <path...>", "repository paths linked into the audit checkout from the working tree, such as node_modules", [])
  .option("--initial-base <commit>", "the commit the first audit compares against; defaults to the first audited commit's parent")
  .action(async (repo: string, o: { ref: string; from?: string; data: string[]; link: string[]; initialBase?: string }) => {
    process.exitCode = await runEnrollMigrate(repo, o.ref, o.from, findWardenRoot(), o.data, o.link, o.initialBase);
  });

enroll
  .command("compile <repo>")
  .description("recompile an enrolled policy with this Warden, after an upgrade or a config change")
  .requiredOption("--ref <ref>", "the enrolled full ref")
  .action(async (repo: string, o: { ref: string }) => {
    process.exitCode = await runEnrollCompile(repo, o.ref, findWardenRoot());
  });

enroll
  .command("sign <repo>")
  .description("as the owner, sign an enrolled policy so the daemon audits with it; asks for your trust key's passphrase")
  .requiredOption("--ref <ref>", "the enrolled full ref")
  .requiredOption("--key <file>", "your passphrase-protected private key listed in Warden's trust_signers")
  .action((repo: string, o: { ref: string; key: string }) => {
    process.exitCode = runEnrollSign(repo, o.ref, o.key, findWardenRoot());
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
      if (cause.exitCode === 0) process.exitCode = 0;
      else if (NEVER_BLOCK.has(process.argv[2] ?? "")) reportVerdict(2);
      else process.exitCode = 2;
    } else {
      const location = cause instanceof RecordError ? [cause.file, cause.pointer].filter(Boolean).join(" ") : "";
      process.stderr.write(`${location === "" ? "" : `${location}: `}${(cause as Error).message}\n`);
      if (NEVER_BLOCK.has(process.argv[2] ?? "")) reportVerdict(2);
      else process.exitCode = 2;
    }
  },
);
