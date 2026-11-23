import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { practicesElsewhere } from "../src/compiler/compile.js";
import { checkConsistency } from "../src/compiler/consistency.js";
import { runExamples } from "../src/compiler/examples.js";
import { loadRecords } from "../src/records/load.js";
import type { Guardrail, RecordSet } from "../src/records/types.js";
import { runGuardrails } from "../src/runner/run.js";

const wardenRoot = resolve(import.meta.dirname, "..");
const config = (packs: string[]): string =>
  [
    "warden: 0.1.0",
    "project: sample",
    "base: main",
    "packs:",
    "  - id: core",
    "    paths: [\"**/*.{ts,tsx,mts,cts,js,mjs,cjs}\"]",
    ...packs.flatMap((id) => [`  - id: ${id}`, "    paths: [\"**/*\"]"]),
    "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }",
    "loopBreakerRepeats: 3",
    "",
  ].join("\n");

let root: string;
let set: RecordSet;
let guardrail: Guardrail;

const write = async (file: string, content = "export const a = 1;\n"): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

const run = async () => {
  const [result] = await runGuardrails(set, [guardrail], [], { root, generatedDir: join(root, ".warden/generated") });
  return result;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-folder-json-"));
  await write(".warden/config.yaml", config(["collection-folders", "folder-json"]));
  set = await loadRecords(root, wardenRoot);
  guardrail = set.packs.find((p) => p.id === "folder-json")?.practices.flatMap((x) => x.guardrails)[0] as Guardrail;
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe("folder-json pack", () => {
  it("folder-json pack examples hold and the records are consistent", async () => {
    expect(guardrail.id).toBe("warden-folders-hold-one-file-until-the-leaf");
    expect(checkConsistency(set, await practicesElsewhere(set, wardenRoot))).toEqual([]);
    expect(await runExamples(set)).toEqual([]);
  });

  it("requires collection-folders, and says to enable it", async () => {
    await write(".warden/config.yaml", config(["folder-json"]));
    const onlyFolderJson = await loadRecords(root, wardenRoot);
    const findings = checkConsistency(onlyFolderJson, await practicesElsewhere(onlyFolderJson, wardenRoot));
    expect(findings.map((f) => f.code)).toEqual(["undefined-term"]);
    expect(findings[0]?.message).toMatch(/Next action: enable the pack that defines Term collection before pack folder-json in \.warden\/config\.yaml, then run warden compile\.$/);
  });

  it("names each folder that holds more than one file beside its subfolders, and ends with a next action", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await write("src/[widgets]/button/index.ts");
    await write("src/[widgets]/button/parts/knob/index.ts");
    await write("src/[widgets]/button/parts/knob/knob.ts");
    expect((await run())?.status).toBe("pass");
    await write("src/[widgets]/button/styles.ts");
    const failed = await run();
    expect(failed?.status).toBe("fail");
    const lines = failed?.violations[0]?.message.split("\n") ?? [];
    expect(lines).toContain("src/[widgets]/button has subfolders and 2 files, where at most one is allowed: index.ts, styles.ts");
    expect(lines.at(-1)).toMatch(/Next action: in each listed folder, keep at most one file and move the others into a subfolder that has no subfolders of its own\.$/);
  });

  it("ends with the next action even when the listing overflows a pipe", async () => {
    const long = "x".repeat(200);
    for (let i = 0; i < 150; i++) {
      await write(`src/[widgets]/w${i}/a${long}.ts`);
      await write(`src/[widgets]/w${i}/b${long}.ts`);
      await write(`src/[widgets]/w${i}/parts/index.ts`);
    }
    const lines = (await run())?.violations[0]?.message.split("\n") ?? [];
    expect(lines.at(-1)).toMatch(/^150 folder\(s\) with subfolders hold more than one file\. Next action:/);
  });

  it("allows one file beside subfolders, and none", async () => {
    await write("src/[widgets]/button/parts/knob/index.ts");
    await write("src/[widgets]/card/index.ts");
    await write("src/[widgets]/card/[slots]/header/index.ts");
    expect((await run())?.status).toBe("pass");
  });

  it("checks deeper folders below a collection item", async () => {
    await write("src/[widgets]/button/parts/a.ts");
    await write("src/[widgets]/button/parts/b.ts");
    await write("src/[widgets]/button/parts/knob/index.ts");
    expect((await run())?.violations[0]?.message).toContain("src/[widgets]/button/parts has subfolders and 2 files");
  });

  it("counts one on-disk file once when Git lists multiple index stages", async () => {
    const git = (args: string[], input?: string) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", input });
    git(["init", "-q"]);
    const file = "src/[widgets]/button/index.ts";
    await write(file);
    await write("src/[widgets]/button/parts/knob/index.ts");
    const oid = git(["hash-object", "-w", file]).trim();
    git(["update-index", "--index-info"], `100644 ${oid} 1\t${file}\n100644 ${oid} 2\t${file}\n`);
    expect((await run())?.status).toBe("pass");
  });

  it("ignores dangling Git symlinks beside or below a folder", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await write("src/[widgets]/button/index.ts");
    await write("src/[widgets]/button/parts/knob/index.ts");
    await symlink("missing.ts", join(root, "src/[widgets]/button/dangling.ts"));
    expect((await run())?.status).toBe("pass");
    await write("src/[widgets]/button/styles.ts");
    await rm(join(root, "src/[widgets]/button/parts/knob/index.ts"));
    await symlink("missing.ts", join(root, "src/[widgets]/button/parts/knob/dangling.ts"));
    expect((await run())?.status).toBe("pass");
  });

  it("ignores folders outside a collection and leaves a collection's own files to collection-folders", async () => {
    await write("package.json", "{}\n");
    await write("README.md", "x\n");
    await write("src/lib/a.ts");
    await write("src/lib/b.ts");
    await write("src/lib/x/index.ts");
    await write("src/[widgets]/notes.ts");
    await write("src/[widgets]/stray.ts");
    await write("src/[widgets]/button/index.ts");
    await write("src/[widgets]/button/[slots]/a.ts");
    await write("src/[widgets]/button/[slots]/b.ts");
    await write("src/[widgets]/button/[slots]/header/index.ts");
    expect((await run())?.status).toBe("pass");
  });
});
