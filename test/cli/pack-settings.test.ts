import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { serve } from "../../src/cli/daemon.js";
import { loadRecords, parseConfig } from "../../src/records/load.js";
import { type Watched } from "../../src/runner/daemon.js";
import { appendEvidence } from "../../src/runner/evidence.js";

const wardenRoot = resolve(import.meta.dirname, "../..");
const configSource = (project: string): string => `# Keep this project comment
project: ${project}
base: main
packs:
  - id: core
    paths: ["src/**/*.ts"]
  - id: review
    paths: ["docs/**/*.md"]
tierBudgetMs: { edit: 1000, commit: 5000, boundary: 10000 }
loopBreakerRepeats: 3
`;

it("saves project pack toggles to the primary repository, retains coverage, and reports recorded results", async () => {
  const scratch = realpathSync(await mkdtemp(join(tmpdir(), "warden-pack-settings-")));
  vi.stubEnv("WARDEN_HOME", join(scratch, "warden-home"));
  const served = await serve(wardenRoot, 0);
  try {
    const root = join(scratch, "example");
    const sibling = join(scratch, "sibling");
    const other = join(scratch, "other");
    for (const checkout of [root, sibling, other]) {
      const project = checkout === other ? "other" : "example";
      await mkdir(join(checkout, ".warden"), { recursive: true });
      await writeFile(join(checkout, ".warden", "config.yaml"), configSource(project));
      served.daemon.projects.set(checkout, { root: checkout, project, repo: checkout === other ? join(scratch, "git-metadata", "other.git") : join(root, ".git"), open: new Map(), watchers: new Map() } as unknown as Watched);
    }
    const origin = `http://127.0.0.1:${served.port}`;
    const settings = async () => {
      const res = await fetch(`${origin}/api/project-checks?project=example`);
      expect(res.status).toBe(200);
      return res.json();
    };
    const save = (changes: { id: string; enabled: boolean }[], revision: string, checkout: string | undefined = undefined, requestOrigin = origin) =>
      fetch(`${origin}/api/packs?project=example${checkout === undefined ? "" : `&root=${encodeURIComponent(checkout)}`}`, {
        method: "POST",
        headers: { origin: requestOrigin, "content-type": "application/json" },
        body: JSON.stringify({ revision, changes }),
      });
    const file = join(root, ".warden", "config.yaml");
    const at = "2026-11-27T00:00:00.000Z";
    appendEvidence("example", { at, kind: "cost", guardrail: "run", outcome: "ran", run: "test-run", root, rules: { "warden-no-comments": 1 }, failedRules: ["warden-no-comments"] });
    appendEvidence("example", { at: "2026-11-27T00:01:00.000Z", kind: "cost", guardrail: "run", outcome: "ran", run: "unrelated-run", root, cachedRules: ["warden-no-comments", "not-observed"] });
    const before = await settings();
    expect(before.results).not.toHaveProperty("not-observed");
    expect(before).not.toHaveProperty("root");
    expect(before.results).toMatchObject({ "warden-no-comments": { at, run: "test-run", status: "Findings" } });
    expect(before.bands.flatMap(({ kinds }: { kinds: string[] }) => kinds)).toContain("lint");
    expect(await readFile(file, "utf8")).toBe(configSource("example"));
    const separateGitDir = await fetch(`${origin}/api/project-checks?project=other`);
    expect(separateGitDir.status).toBe(200);
    expect(await separateGitDir.json()).toMatchObject({ packs: expect.arrayContaining([{ id: "review", on: true, required: false }]) });
    const disable = [{ id: "review", enabled: false }];
    expect((await save(disable, before.revision, other)).status).toBe(404);
    expect((await save(disable, before.revision, root, "http://localhost:8888")).status).toBe(403);
    expect((await save([{ id: "core", enabled: false }], before.revision)).status).toBe(422);
    const saved = await save(disable, before.revision);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ changed: true });
    const disabled = await readFile(file, "utf8");
    expect(disabled).toContain("# Keep this project comment");
    expect(parseConfig(file, disabled).packs.find((pack) => pack.id === "review")).toEqual({ id: "review", paths: ["docs/**/*.md"], enabled: false });
    expect((await loadRecords(root, wardenRoot)).packs.map((pack) => pack.id)).toEqual(["core"]);
    expect((await save([{ id: "review", enabled: true }], before.revision)).status).toBe(409);
    const after = await settings();
    expect(after.packs).toContainEqual({ id: "review", on: false, required: false });
    const enabled = await save([{ id: "review", enabled: true }, { id: "signals", enabled: true }], after.revision);
    expect(enabled.status).toBe(200);
    const final = parseConfig(file, await readFile(file, "utf8"));
    expect(final.packs.find((pack) => pack.id === "review")).toEqual({ id: "review", paths: ["docs/**/*.md"] });
    expect(final.packs.find((pack) => pack.id === "signals")).toEqual({ id: "signals", paths: ["**/*"] });
    expect(await readFile(join(sibling, ".warden", "config.yaml"), "utf8")).toBe(configSource("example"));
    expect(await readFile(join(other, ".warden", "config.yaml"), "utf8")).toBe(configSource("other"));
  } finally {
    await served.close();
    vi.unstubAllEnvs();
    await rm(scratch, { recursive: true, force: true });
  }
});
