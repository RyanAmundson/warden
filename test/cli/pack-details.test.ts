import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { packSettings } from "../../src/cli/pack-settings.js";

type DetailsResponse = {
  packs: { id: string; on: boolean; required: boolean }[];
  details: { id: string; adapters: { id: string; status: string }[] }[];
  jev: { status: string; packIds: string[] };
};

const wardenRoot = resolve(import.meta.dirname, "../..");
const detailsResponse = async (root: string): Promise<DetailsResponse> =>
  await packSettings(root, "example", wardenRoot) as unknown as DetailsResponse;

it("shows checks for disabled packs and reports runner prerequisites without exposing credentials", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "warden-pack-details-")));
  const folder = join(root, ".warden");
  const catalog = join(folder, "packs", "custom");
  try {
    await mkdir(catalog, { recursive: true });
    await writeFile(join(folder, "config.yaml"), `project: example
base: main
packs: [{ id: core, paths: ["**/*.ts"] }]
tierBudgetMs: { edit: 1000, commit: 5000, boundary: 10000 }
loopBreakerRepeats: 3
`);
    await writeFile(join(catalog, "pack.yaml"), `id: custom
layer: 1
terms: []
practices:
  - id: check-document
    statement: Check the project document.
    terms: []
    paths: []
    conflictsWith: []
    guardrails:
      - id: check-with-jev
        kind: model
        scope: project
        runs: [boundary]
        budgetMs: 5000
        version: 1
        implementation: system-one:noul
        options: { model: jev-1.14.0, question: Is this compliant?, inputs: [readme.md], failBelow: 0.2, passAt: 0.8 }
        mustPass: { readme.md: yes }
        mustFail: { readme.md: no }
`);
    vi.stubEnv("WARDEN_TYPESAFE", undefined);
    vi.stubEnv("TYPESAFE_API_KEY", undefined);
    vi.stubEnv("WARDEN_TLC_JAR", undefined);
    const settings = await detailsResponse(root);
    expect(settings.packs).toContainEqual({ id: "custom", on: false, required: false });
    expect(settings.details).toBeDefined();
    expect(settings.details.find(({ id }) => id === "custom")).toMatchObject({
      checks: [{ id: "check-with-jev", adapter: "system-one", model: "jev-1.14.0", runs: ["boundary"] }],
      adapters: [{ id: "system-one", status: "Needs setup" }],
    });
    expect(settings.details.find(({ id }) => id === "core")?.adapters).toMatchObject([{ id: "eslint", status: "Ready" }]);
    expect(settings.details.find(({ id }) => id === "tla")?.adapters).toMatchObject([{ id: "cmd", status: "Needs setup" }]);
    expect(settings.details.find(({ id }) => id === "typescript")?.adapters).toContainEqual(expect.objectContaining({ id: "tsc", status: "Needs setup" }));
    expect(settings.jev).toMatchObject({ status: "Needs setup", packIds: ["custom"] });

    await writeFile(join(root, "tsconfig.json"), "{}");
    vi.stubEnv("WARDEN_TYPESAFE", "1");
    vi.stubEnv("TYPESAFE_API_KEY", "fixture-key-never-serialized");
    const configured = await detailsResponse(root);
    expect(configured.jev.status).toBe("Verify in runner");
    expect(configured.details.find(({ id }) => id === "typescript")?.adapters).toContainEqual(expect.objectContaining({ id: "tsc", status: "Verify in runner" }));
    expect(JSON.stringify(configured)).not.toContain("fixture-key-never-serialized");

    const { packsPage } = await import(pathToFileURL(join(wardenRoot, "web/render.js")).href);
    const html = packsPage({
      data: {
        projects: [{ project: "example" }],
        layers: { project: "example", bands: [], practices: [], packs: [{ id: "custom", source: "local", on: false, rules: 1 }], packSettings: configured },
      },
      projects: [],
      view: { packDraft: new Map() },
    });
    expect(html).toContain("Checks and setup");
    expect(html).toContain('id="pack-info-custom" aria-labelledby="pack-title-custom"');
    expect(html).toContain("check-with-jev");
    expect(html).toContain("jev-1.14.0");
    expect(html).toContain("Declared in custom.");
    expect(html).toContain("Jev live calls (TypeSafe)");
    expect(html).toContain("Readiness is measured in this checkout and dashboard process.");
    expect(html).toContain("id=\"pack-custom\"");
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
