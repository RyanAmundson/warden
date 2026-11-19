import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { stagedMismatch } from "../src/runner/changed.js";

it("preserves the full staged path and its blob when using a sparse checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-index-paths-"));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const file = "modules/export\tfrançais\nsummary.ts";
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Warden fixture");
    git("config", "user.email", "fixture@example.test");
    git("config", "commit.gpgsign", "false");
    await mkdir(join(root, "src"));
    await mkdir(join(root, "modules"));
    await writeFile(join(root, "src/index.ts"), "export const status = 'ready';\n");
    await writeFile(join(root, file), "export const total = 1;\n");
    git("add", ".");
    git("commit", "-qm", "Add sample files");
    git("switch", "-qc", "update");
    await writeFile(join(root, file), "export const total = 2;\n");
    git("add", "--", file);
    git("commit", "-qm", "Update sample value");
    const sha = git("rev-parse", `HEAD:${file}`);
    git("sparse-checkout", "set", "src");
    expect(stagedMismatch(root, "main")).toEqual({ paths: [], hidden: [], absent: [{ path: file, sha }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
