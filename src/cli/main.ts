#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { compile } from "../compiler/compile.js";
import type { Tier } from "../records/types.js";
import type { Format } from "../runner/feedback.js";
import { runCheck } from "./check.js";
import { runExplain } from "./explain.js";
import { runInit } from "./init.js";
import { runReport } from "./report.js";

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

const program = new Command("warden").exitOverride();
const root = (): string => resolve(process.cwd());

program.command("init").description("create .warden, compile, and baseline current violations").action(async () => {
  process.exitCode = await runInit(root(), findWardenRoot());
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
  .action(async (paths: string[], o: { rule?: string; tier: string; format: string; hook?: string }) => {
    process.exitCode = await runCheck({
      root: root(),
      wardenRoot: findWardenRoot(),
      paths: paths.length > 0 ? paths : undefined,
      rule: o.rule,
      tier: oneOf<Tier>("tier", o.tier, ["edit", "commit", "boundary"]),
      format: oneOf<Format>("format", o.format, ["text", "agent", "json"]),
      hook: o.hook === undefined ? undefined : oneOf("hook", o.hook, ["claude"] as const),
      hookInput: o.hook === undefined ? undefined : readFileSync(0, "utf8"),
    });
  });

program.command("explain <id>").description("explain a Practice or Guardrail").action(async (id: string) => {
  process.exitCode = await runExplain(root(), findWardenRoot(), id);
});

program.command("report").description("one row per Guardrail").option("--json", "print JSON").action(async (o: { json?: boolean }) => {
  process.exitCode = await runReport(root(), findWardenRoot(), o.json === true);
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
