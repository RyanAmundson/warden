import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { exampleProjectsRemoved, withExampleProject } from "../../src/compiler/examples.js";

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
