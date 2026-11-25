import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adapters, runGuardrails } from "../src/runner/run.js";
import { runExamples } from "../src/compiler/examples.js";
import { loadRecords } from "../src/records/load.js";
import type { Guardrail, RecordSet } from "../src/records/types.js";

const wardenRoot = resolve(import.meta.dirname, "..");
const config = (settings: string): string => [
  "warden: 0.1.0",
  "project: sample",
  "base: main",
  "packs:",
  "  - id: core",
  "    paths: [\"**/*.{ts,tsx,mts,cts,js,mjs,cjs}\"]",
  "  - id: plugin-compliance",
  "    paths: [\"**/*\"]",
  `    settings: ${settings}`,
  "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }",
  "loopBreakerRepeats: 3",
  "",
].join("\n");

let root: string;
let written: string[];

const write = async (file: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
  if (!file.startsWith(".")) written.push(file);
};

const load = async (settings = "{ plugins: [\"plugins/*\"], sharedCode: [libs], hostImports: [\"^@app/\"], legacyImports: [\"^@sdk/shims/\"], consoleFolders: [cli] }"): Promise<{ set: RecordSet; guardrails: Guardrail[] }> => {
  await write(".warden/config.yaml", config(settings));
  const set = await loadRecords(root, wardenRoot);
  return { set, guardrails: set.packs.find((p) => p.id === "plugin-compliance")?.practices.flatMap((x) => x.guardrails) ?? [] };
};

const findings = async (set: RecordSet, guardrails: Guardrail[], id: string) => {
  const g = guardrails.find((x) => x.id === id) as Guardrail;
  const adapter = adapters.get(g.implementation.slice(0, g.implementation.indexOf(":")));
  for (const [path, content] of Object.entries(adapter?.emit([g], set) ?? {})) await write(path, content);
  const [result] = await runGuardrails(set, [g], written, { root, generatedDir: join(root, ".warden/generated") });
  return result?.violations.map((v) => `${v.file}:${v.line} ${v.message}`);
};

const definition = (manifest: object): string => [
  "import { definePlugin } from \"./sdk.js\";",
  `export const notes = definePlugin({ manifest: ${JSON.stringify(manifest)}, main: () => import("./main/main.js") });`,
  "",
].join("\n");

const docs = async (folder: string): Promise<void> => {
  await write(`${folder}/package.json`, "{ \"version\": \"2.0.0\" }\n");
  await write(`${folder}/README.md`, "# Notes\n");
  await write(`${folder}/CONTRACT.md`, "# Notes\n\nPublishes notes.list@1 and requests tags.search@1.\n");
  await write(`${folder}/CHANGELOG.md`, "## 2.0.0\n");
};

beforeEach(async () => {
  written = [];
  root = await mkdtemp(join(tmpdir(), "warden-plugin-compliance-"));
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe("plugin-compliance pack", () => {
  it("has one Guardrail per checklist row, and every example holds", async () => {
    const { set, guardrails } = await load();
    expect(guardrails.map((g) => g.id)).toEqual([
      "warden-pq-sdk-1", "warden-pq-sdk-2", "warden-pq-sdk-3", "warden-pq-world-1", "warden-pq-world-2", "warden-pq-effects-1", "warden-pq-logs-1", "warden-pq-docs-1",
      "warden-pq-interop-1", "warden-pq-interop-2", "warden-pq-interop-3", "warden-pq-interop-4", "warden-pq-interop-5", "warden-pq-interop-8", "warden-pq-interop-9", "warden-pq-interop-11", "warden-pq-interop-12",
    ]);
    expect(guardrails.every((g) => g.runs.length === 1 && g.runs[0] === "boundary")).toBe(true);
    expect(await runExamples(set)).toEqual([]);
  }, 120_000);

  it("reports each source gap at its file and line, per plugin folder, so the baseline counts it per file", async () => {
    await docs("plugins/notes");
    await write("plugins/notes/plugin.ts", "import { definePlugin } from \"@sdk/core\";\nexport const notes = definePlugin({});\n");
    await write("plugins/notes/main/main.ts", [
      "import { readFile } from \"node:fs/promises\";",
      "import type { Stats } from \"node:fs\";",
      "import { tags } from \"../../tags/main.js\";",
      "import { util } from \"../../../libs/util.js\";",
      "import { app } from \"@app/store\";",
      "// import { hidden } from \"@app/hidden\";",
      "export const read = () => readFile(\"x\");",
      "export const stop = setInterval(() => console.log(process.env.HOME), 1000);",
      "export const commit = (exec: (cmd: string, args: string[]) => void) => exec(\"git\", [\"-C\", dir, \"commit\"]);",
      "export type S = Stats;",
      "export const all = [tags, util, app];",
      "",
    ].join("\n"));
    await write("plugins/notes/main/main.test.ts", "import { shim } from \"@sdk/shims/host\";\nconsole.log(shim, fetch);\n");
    await write("plugins/notes/cli/run.ts", "console.log(\"ok\");\n");
    await write("plugins/tags/plugin.json", "{}\n");
    const { set, guardrails } = await load();
    expect(await findings(set, guardrails, "warden-pq-sdk-1")).toEqual([
      "plugins/tags/plugin.json:1 plugins/tags: plugin.ts is missing: the plugin declares itself with definePlugin there.",
      "plugins/tags/plugin.json:1 plugins/tags: plugin.json is a second copy of the declaration.",
    ]);
    expect(await findings(set, guardrails, "warden-pq-sdk-2")).toEqual([
      "plugins/notes/main/main.ts:3 main/main.ts: imports ../../tags/main.js, outside the plugin and its shared code",
      "plugins/notes/main/main.ts:5 main/main.ts: imports @app/store, which is host code or another plugin",
    ]);
    expect(await findings(set, guardrails, "warden-pq-sdk-3")).toEqual(["plugins/notes/main/main.test.ts:1 main/main.test.ts: imports the legacy bridge @sdk/shims/host"]);
    expect(await findings(set, guardrails, "warden-pq-world-1")).toEqual([
      "plugins/notes/main/main.ts:1 main/main.ts: imports node:fs/promises",
      "plugins/notes/main/main.ts:8 main/main.ts: reads process.env",
    ]);
    expect(await findings(set, guardrails, "warden-pq-world-2")).toEqual(["plugins/notes/main/main.ts:8 main/main.ts: polls with setInterval"]);
    expect(await findings(set, guardrails, "warden-pq-effects-1")).toEqual(["plugins/notes/main/main.ts:9 main/main.ts: runs git commit"]);
    expect(await findings(set, guardrails, "warden-pq-logs-1")).toEqual(["plugins/notes/main/main.ts:8 main/main.ts: console.log"]);
    expect(await findings(set, guardrails, "warden-pq-docs-1")).toEqual([
      "plugins/tags/plugin.json:1 plugins/tags: README.md is missing.",
      "plugins/tags/plugin.json:1 plugins/tags: CONTRACT.md is missing.",
      "plugins/tags/plugin.json:1 plugins/tags: CHANGELOG.md is missing.",
      "plugins/tags/plugin.json:1 plugins/tags: package.json is missing, so the plugin has no version.",
    ]);
  }, 120_000);

  it("decides the manifest rows from what plugin.ts exports when it runs", async () => {
    await docs("plugins/notes");
    await write("plugins/notes/sdk.ts", "export const definePlugin = <T,>(definition: T): T => definition;\n");
    const list = { id: "notes.list", version: 1, side: "main", methods: { open: { input: { type: "string" }, result: { type: "string" } } } };
    await write("plugins/notes/plugin.ts", definition({
      id: "notes", name: "Notes", version: "2.0.0",
      features: [{
        services: [list, { id: "other.svc", version: 1, side: "main", methods: {} }],
        ownedSlots: [{ id: "notes.panel@1", entry: { type: "object" }, cardinality: "many" }],
        collections: [{ id: "notes.items", version: 1, key: "id", schema: { type: "object", properties: { id: { type: "string", optional: true } } } }],
        entityKinds: ["note"],
        cliCommands: [{ namespace: "notes", name: "open", service: "notes.list@1", method: "open", description: "" }],
        contributions: [{ id: "menu", slot: "shell.menu@1" }, { id: "own", slot: "notes.panel@2" }],
      }],
    }));
    await write("plugins/notes/main/main.ts", "const TAGS = \"tags.search@1\";\nexport const go = (registry: { request(id: string): void }) => [registry.request(TAGS), registry.request(\"notes.list@1\"), registry.request(\"host.files@1\"), registry.request(\"dispatch.runs@1\")];\n");
    await write("plugins/notes/main/main.test.ts", "// [contract:notes.list@1] [absent:tags.search@1]\nexport {};\n");
    await write("plugins/notes/contracts.lock.json", JSON.stringify({ "notes.list@1": { open: "0000000000000000", close: "1111111111111111" } }));
    const { set, guardrails } = await load();
    const rows: Record<string, string[] | undefined> = {};
    for (const g of guardrails.filter((x) => x.implementation.startsWith("module:"))) rows[g.id] = await findings(set, guardrails, g.id);
    expect(rows).toEqual({
      "warden-pq-interop-1": ["plugins/notes/plugin.ts:1 plugins/notes: service other.svc is in neither the notes namespace nor a role it fills."],
      "warden-pq-interop-2": ["plugins/notes/plugin.ts:1 plugins/notes: entity kind note has 0 presentations; it needs exactly one."],
      "warden-pq-interop-3": ["plugins/notes/main/main.ts:2 plugins/notes: requests dispatch.runs@1; CONTRACT.md does not name it."],
      "warden-pq-interop-4": ["plugins/notes/main/main.ts:2 plugins/notes: no test is titled [absent:dispatch.runs@1]."],
      "warden-pq-interop-5": ["plugins/notes/plugin.ts:1 plugins/notes: command notes open has no description."],
      "warden-pq-interop-8": ["plugins/notes/plugin.ts:1 plugins/notes: collection notes.items keys by id, which is not a required string field of its schema."],
      "warden-pq-interop-9": [
        "plugins/notes/plugin.ts:1 plugins/notes: CONTRACT.md does not name other.svc@1.",
        "plugins/notes/plugin.ts:1 plugins/notes: no test is titled [contract:other.svc@1].",
        "plugins/notes/plugin.ts:1 plugins/notes: CONTRACT.md does not name notes.panel@1.",
        "plugins/notes/plugin.ts:1 plugins/notes: no test is titled [contract:notes.panel@1].",
      ],
      "warden-pq-interop-11": [
        "plugins/notes/contracts.lock.json:1 plugins/notes: notes.list@1 open changed under the same major.",
        "plugins/notes/contracts.lock.json:1 plugins/notes: notes.list@1 close was removed under the same major.",
        "plugins/notes/plugin.ts:1 plugins/notes: notes.panel@1 is not recorded.",
      ],
      "warden-pq-interop-12": [
        "plugins/notes/plugin.ts:1 plugins/notes: contribution menu targets shell.menu@1; the SDK has no shell.* slots.",
        "plugins/notes/plugin.ts:1 plugins/notes: contribution own targets notes.panel@2, which the plugin neither declares nor accepts.",
      ],
    });
  }, 120_000);

  it("fails every manifest row of a plugin whose plugin.ts does not load, naming the load error", async () => {
    await docs("plugins/notes");
    await write("plugins/notes/plugin.ts", "import { definePlugin } from \"@sdk/not-installed\";\nexport const notes = definePlugin({});\n");
    const { set, guardrails } = await load();
    expect(await findings(set, guardrails, "warden-pq-interop-1")).toEqual([
      expect.stringMatching(/^plugins\/notes\/plugin\.ts:1 plugins\/notes: plugin\.ts does not load, so its manifest cannot be checked: plugins\/notes\/plugin\.ts did not load: Error \[ERR_MODULE_NOT_FOUND\]: Cannot find package '@sdk\/not-installed'/),
    ]);
  }, 120_000);

  it.each(["plugins/", "./plugins", "../plugins/*"])("refuses the plugins entry %s, which would match no folder", async (entry) => {
    await expect(load(`{ plugins: ["${entry}"] }`)).rejects.toThrow("must match pattern");
  }, 120_000);

  it("checks the project root as the plugin by default", async () => {
    await write("plugin.ts", "import { definePlugin } from \"@sdk/core\";\nexport const p = definePlugin({});\n");
    await write("main.ts", "console.warn(\"x\");\n");
    const { set, guardrails } = await load("{}");
    expect(await findings(set, guardrails, "warden-pq-logs-1")).toEqual(["main.ts:1 main.ts: console.warn"]);
    expect(await findings(set, guardrails, "warden-pq-docs-1")).toEqual([
      "plugin.ts:1 .: README.md is missing.",
      "plugin.ts:1 .: CONTRACT.md is missing.",
      "plugin.ts:1 .: CHANGELOG.md is missing.",
      "plugin.ts:1 .: package.json is missing, so the plugin has no version.",
    ]);
  }, 120_000);
});
