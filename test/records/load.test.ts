import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { examplePrefix } from "../../src/compiler/examples.js";
import { RecordError, exampleSet, loadRecords } from "../../src/records/load.js";
import { enabledOn, folderOf } from "../../src/records/paths.js";

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

describe("pack settings", () => {
  const withPack = async (settings: string | undefined, entry: string | undefined, run: (project: string) => Promise<void>): Promise<void> => {
    const project = await mkdtemp(join(tmpdir(), "warden-settings-"));
    try {
      await mkdir(join(project, ".warden/packs/local"), { recursive: true });
      const schema = settings === undefined ? [] : ["settings:", ...settings.split("\n").map((l) => `  ${l}`)];
      await writeFile(join(project, ".warden/packs/local/pack.yaml"), ["id: local", "layer: 1", "terms: []", ...schema, "practices: []", ""].join("\n"));
      const settingsLine = entry === undefined ? [] : [`    settings: ${entry}`];
      await writeFile(join(project, ".warden/config.yaml"), ["project: p", "base: main", "packs:", "  - id: local", "    paths: []", ...settingsLine, "tierBudgetMs: { edit: 1, commit: 1, boundary: 1 }", "loopBreakerRepeats: 3", ""].join("\n"));
      await run(project);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  };
  const schema = "type: object\nadditionalProperties: false\nproperties:\n  words: { type: array, items: { type: string }, default: [a] }\n  max: { type: integer, default: 3 }\nexamples:\n  - { words: [x] }";

  it("fills a pack's declared defaults into the config entry, keeping what the config sets", async () => {
    await withPack(schema, "{ max: 5 }", async (project) => {
      const set = await loadRecords(project, wardenRoot);
      expect(set.config.packs[0]?.settings).toEqual({ words: ["a"], max: 5 });
    });
  });

  it("refuses settings that break the pack's schema, naming the field and the next action", async () => {
    await withPack(schema, "{ max: many }", async (project) => {
      const error = await loadRecords(project, wardenRoot).catch((e: unknown) => e);
      expect(error).toMatchObject({ pointer: "/packs/0/settings/max", message: expect.stringContaining("Next action: fix settings/max of pack local in") });
    });
  });

  it("refuses an unknown settings key by name, with one next action", async () => {
    await withPack(schema, "{ wrds: [b] }", async (project) => {
      const error = await loadRecords(project, wardenRoot).catch((e: unknown) => e);
      expect(error).toMatchObject({ name: "RecordError", pointer: "/packs/0/settings/wrds", message: expect.stringMatching(/^wrds is not a setting of pack local\. Next action: remove or rename wrds in the settings of pack local in .*, then run warden compile\.$/) });
    });
  });

  it("refuses settings for a pack that declares none", async () => {
    await withPack(undefined, "{ max: 5 }", async (project) => {
      const error = await loadRecords(project, wardenRoot).catch((e: unknown) => e);
      expect(error).toMatchObject({ pointer: "/packs/0/settings", message: expect.stringContaining("pack local declares no settings. Next action: remove settings from pack local in") });
    });
  });

  it("runs examples with the pack's first example settings, never the project's", async () => {
    await withPack(schema, "{ max: 5 }", async (project) => {
      const set = await loadRecords(project, wardenRoot);
      expect(exampleSet(set).config.packs[0]?.settings).toEqual({ words: ["x"], max: 3 });
    });
  });
});

describe("path globs", () => {
  it("a negated glob enables every file it does not match", () => {
    expect(enabledOn("src/a.ts", [["!**/sources/**", "**/*.ts"]])).toBe(true);
    expect(enabledOn("src/sources/a.ts", [["!**/sources/**", "**/*.ts"]])).toBe(false);
  });

  it("an example under a negated Practice glob goes under the config's folder, not a file named !", () => {
    expect(examplePrefix(["!**/sources/**", "src/**"])).toBe("src/");
  });
});

describe("backslash in a pack glob", () => {
  const project = async (configPath: string, practicePath: string, run: (root: string) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "warden-glob-"));
    try {
      await mkdir(join(root, ".warden/packs/local"), { recursive: true });
      await writeFile(
        join(root, ".warden/packs/local/pack.yaml"),
        ["id: local", "layer: 1", "terms: []", "practices:", "  - id: p", "    statement: s", "    terms: []", `    paths: [${JSON.stringify(practicePath)}]`, "    conflictsWith: []", "    guardrails: []", ""].join("\n"),
      );
      await writeFile(join(root, ".warden/config.yaml"), ["project: p", "base: main", "packs:", `  - { id: local, paths: [${JSON.stringify(configPath)}] }`, "tierBudgetMs: { edit: 1, commit: 1, boundary: 1 }", "loopBreakerRepeats: 3", ""].join("\n"));
      await run(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  it("a config path with a backslash is refused with the [[] form", async () => {
    await project("\\[plugins\\]/**", "src/**", async (root) => {
      const error = (await loadRecords(root, wardenRoot).catch((e: unknown) => e)) as RecordError;
      expect(error).toBeInstanceOf(RecordError);
      expect(error.pointer).toBe("/packs/0/paths/0");
      expect(error.message).toBe(
        `path \\[plugins\\]/** holds a backslash, which Node's glob matcher does not read as an escape. Next action: write [[]plugins]/** in place of \\[plugins\\]/** in ${join(root, ".warden/config.yaml")}, then run warden compile.`,
      );
    });
    await project("[[]plugins]/**", "src/**", async (root) => {
      await expect(loadRecords(root, wardenRoot)).resolves.toBeDefined();
    });
  });

  it("a practice path with a backslash is refused", async () => {
    await project("src/**", "\\[plugins\\]/**", async (root) => {
      const error = (await loadRecords(root, wardenRoot).catch((e: unknown) => e)) as RecordError;
      expect(error).toBeInstanceOf(RecordError);
      expect(error.pointer).toBe("/practices/0/paths/0");
      expect(error.file).toBe(join(root, ".warden/packs/local/pack.yaml"));
      expect(error.message).toContain("Next action: write [[]plugins]/** in place of");
    });
    await project("src/**", "[[]plugins]/**", async (root) => {
      await expect(loadRecords(root, wardenRoot)).resolves.toBeDefined();
    });
  });

  it("examplePrefix reads [[] as [", () => {
    expect(examplePrefix(["!**/sources/**", "[[]plugins]/**"])).toBe("[plugins]/");
  });

  it.each([
    ["src/ui/**", "src/ui"],
    ["[[]plugins]/frame/**", "[plugins]/frame"],
    ["**", undefined],
    ["src/*.ts", undefined],
    ["src/{a,b}/**", undefined],
    ["!src/**", undefined],
    ["../src/**", undefined],
    ["src/ui", undefined],
  ])("folderOf accepts only plain folder scopes: %s", (glob, folder) => {
    expect(folderOf(glob)).toBe(folder);
  });
});
