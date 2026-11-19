import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RecordError, loadRecords } from "../../src/records/load.js";

const fixtures = "test/fixtures";
const wardenRoot = `${fixtures}/warden-root`;

async function failure(project: string): Promise<RecordError> {
  const error = await loadRecords(`${fixtures}/${project}`, wardenRoot).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RecordError);
  return error as RecordError;
}

describe("loadRecords", () => {
  it("loads a valid project", async () => {
    const set = await loadRecords(`${fixtures}/project-valid`, wardenRoot);
    expect(set.packs).toHaveLength(1);
    expect(set.packs[0]?.id).toBe("core");
    expect(set.packs[0]?.layer).toBe(0);
    expect(set.packs[0]?.practices[0]?.pack).toBe("core");
    expect(set.packs[0]?.practices[0]?.guardrails[0]?.packDir).toBe(resolve(wardenRoot, "packs/core"));
  });

  it("loads the bundled packs in layer order whatever order the config lists them, and each has its own layer", async () => {
    const project = await mkdtemp(join(tmpdir(), "warden-load-"));
    try {
      const bundled = (await readdir("packs")).sort().reverse();
      await mkdir(join(project, ".warden"));
      await writeFile(join(project, ".warden/config.yaml"), ["project: p", "base: main", "packs:", ...bundled.map((id) => `  - { id: ${id}, paths: ["**"] }`), "tierBudgetMs: { edit: 1, commit: 1, boundary: 1 }", "loopBreakerRepeats: 3", ""].join("\n"));
      const layers = (await loadRecords(project, ".")).packs.map((p) => p.layer);
      expect(layers).toEqual([...new Set(layers)].sort((a, b) => a - b));
      expect(layers).toHaveLength(bundled.length);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("rejects YAML syntax errors", async () => {
    const error = await failure("project-bad-yaml");
    expect(error.file.endsWith(".warden/config.yaml")).toBe(true);
  });

  it("rejects unknown fields", async () => {
    const error = await failure("project-unknown-field");
    expect(error.pointer).toBe("/practices/0/disable");
  });

  it("requires examples unless legacy", async () => {
    const error = await failure("project-missing-examples");
    expect(error.pointer.endsWith("/mustFail")).toBe(true);
  });

  it("rejects a pack present in both lookup locations", async () => {
    const error = await failure("project-duplicate-pack");
    expect(error.pointer).toBe("/packs");
  });

  it("rejects a pack whose id differs from its config entry", async () => {
    const error = await failure("project-pack-id-mismatch");
    expect(error.pointer).toBe("/id");
    expect(error.file.endsWith("packs/mismatch/pack.yaml")).toBe(true);
  });

  it("rejects a pack listed twice in config", async () => {
    const error = await failure("project-duplicate-config-pack");
    expect(error.pointer).toBe("/packs");
    expect(error.file.endsWith(".warden/config.yaml")).toBe(true);
  });
});
