import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { exampleProjectsRemoved, thenRemoveExampleProjects, withExampleProject } from "../../src/compiler/examples.js";

it("an example project is removed after its result returns, and exampleProjectsRemoved waits for the removal", async () => {
  let project = "";
  const result = await withExampleProject(async (p) => {
    project = p;
    await mkdir(join(p, "src/[widgets]/button"), { recursive: true });
    await writeFile(join(p, "src/[widgets]/button/index.ts"), "export const button = 1;\n");
    return 7;
  });
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
  });
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
  });
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

it("an example run that fails and cannot remove its project rejects with its own error, and the removal error comes after", async () => {
  let p: { project: string; locked: string } | undefined;
  try {
    const own = await withExampleProject(async (project) => {
      p = { project, locked: join(project, "locked") };
      await mkdir(join(p.locked, "inner"), { recursive: true });
      await chmod(p.locked, 0o500);
      throw new Error("the example run failed");
    }).then(() => undefined, (cause: Error) => cause.message);
    expect(own).toBe("the example run failed");
    const removal = await exampleProjectsRemoved().then(() => undefined, (cause: Error) => cause.message);
    expect(removal).toContain(`Next action: delete ${p?.project}, then run the command again.`);
  } finally {
    if (p !== undefined) await unlock(p);
  }
});
