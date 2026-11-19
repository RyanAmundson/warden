import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { exampleProjectsRemoved, runExamples, thenRemoveExampleProjects, withExampleProject } from "../../src/compiler/examples.js";
import type { Guardrail, RecordSet } from "../../src/records/types.js";

it("a bench example project is removed after its result returns, and exampleProjectsRemoved waits for the removal", async () => {
  let project = "";
  const result = await withExampleProject(async (p) => {
    project = p;
    await mkdir(join(p, "src/[widgets]/button"), { recursive: true });
    await writeFile(join(p, "src/[widgets]/button/index.ts"), "export const button = 1;\n");
    return 7;
  }, true);
  expect(result).toBe(7);
  expect(existsSync(project)).toBe(true);
  await exampleProjectsRemoved();
  expect(existsSync(project)).toBe(false);
});

it("an example project that cannot be removed fails once with one next action that names it", async () => {
  let locked = "";
  await withExampleProject(async (p) => {
    locked = join(p, "locked");
    await mkdir(join(locked, "inner"), { recursive: true });
    await chmod(locked, 0o500);
  }, true);
  const project = locked.slice(0, -"/locked".length);
  try {
    const failure = await exampleProjectsRemoved().then(() => undefined, (cause: Error) => cause.message);
    expect(failure).toContain(`Warden could not remove its example project ${project}`);
    expect(failure?.match(/Next action:/g)).toHaveLength(1);
    expect(failure).toContain(`Next action: delete ${project}, then run the command again.`);
    await expect(exampleProjectsRemoved()).resolves.toBeUndefined();
  } finally {
    await chmod(locked, 0o700);
    await rm(project, { recursive: true, force: true });
  }
});

const lockedProject = async (): Promise<{ project: string; locked: string }> => {
  let project = "";
  await withExampleProject(async (p) => {
    project = p;
    await mkdir(join(p, "locked/inner"), { recursive: true });
    await chmod(join(p, "locked"), 0o500);
  }, true);
  return { project, locked: join(project, "locked") };
};

const unlock = async (...ps: { project: string; locked: string }[]): Promise<void> => {
  for (const p of ps) {
    await chmod(p.locked, 0o700);
    await rm(p.project, { recursive: true, force: true });
  }
};

it("two example projects that cannot be removed are both named in one message with one next action", async () => {
  const a = await lockedProject();
  const b = await lockedProject();
  try {
    const failure = await exampleProjectsRemoved().then(() => undefined, (cause: Error) => cause.message);
    expect(failure).toContain("Warden could not remove 2 example projects:");
    expect(failure).toContain(`${a.project} (`);
    expect(failure).toContain(`${b.project} (`);
    expect(failure?.match(/Next action:/g)).toHaveLength(1);
    expect(failure).toContain(`Next action: delete ${a.project} and ${b.project}, then run the command again.`);
  } finally {
    await unlock(a, b);
  }
});

it("a command that fails and then cannot remove its example project reports its own error first, then the removal error", async () => {
  let p: { project: string; locked: string } | undefined;
  const reported: string[] = [];
  try {
    await thenRemoveExampleProjects(
      async () => {
        p = await lockedProject();
        throw new Error("the command failed");
      },
      (cause) => reported.push((cause as Error).message),
    );
    expect(reported).toHaveLength(2);
    expect(reported[0]).toBe("the command failed");
    expect(reported[1]).toContain(`Next action: delete ${p?.project}, then run the command again.`);
  } finally {
    if (p !== undefined) await unlock(p);
  }
});

it("examples run in a git repository whose base is its first commit", async () => {
  const g: Guardrail = { id: "g", kind: "legacy", runs: ["commit"], budgetMs: 5000, version: 1, implementation: 'cmd:git rev-parse --verify "$WARDEN_BASE" && test ! -e x.txt', mustFail: { "x.txt": "1" }, mustPass: { "y.txt": "1" } };
  const set: RecordSet = {
    root: "",
    packs: [{ id: "p", file: "pack.yaml", layer: 0, terms: [], practices: [{ id: "x", pack: "p", statement: "s", terms: [], paths: [], conflictsWith: [], guardrails: [g] }] }],
    config: { packs: [{ id: "p", paths: ["**"] }] } as never,
  };
  expect(await runExamples(set)).toEqual([]);
});

it("the scaffold commit runs no global hook and uses Warden's own identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warden-hooks-"));
  try {
    await mkdir(join(dir, "hooks"));
    for (const hook of ["pre-commit", "commit-msg"]) await writeFile(join(dir, "hooks", hook), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await writeFile(join(dir, "gitconfig"), `[core]\n\thooksPath = ${join(dir, "hooks")}\n[user]\n\tname = someone\n\temail = someone@example.invalid\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(dir, "gitconfig"));
    vi.stubEnv("GIT_AUTHOR_NAME", "someone");
    vi.stubEnv("GIT_COMMITTER_EMAIL", "someone@example.invalid");
    const who = await withExampleProject(async (p, base) => execFileSync("git", ["log", "-1", "--format=%H %an %ae %cn %ce"], { cwd: p, encoding: "utf8" }).trim() === `${base} warden warden@example.invalid warden warden@example.invalid`);
    expect(who).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});
