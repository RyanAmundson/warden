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
});
