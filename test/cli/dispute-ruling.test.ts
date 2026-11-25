import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { expectedOutputs } from "../../src/compiler/compile.js";
import { LOCK_PATH } from "../../src/compiler/lock.js";
import { loadRecords } from "../../src/records/load.js";
import { appendEvidence, evidenceFile, readEvidence, ROTATE_BYTES, wardenHome } from "../../src/runner/evidence.js";
import { withVerdict } from "../verdict.js";

const wardenRoot = resolve(import.meta.dirname, "../..");

it("records one attributed dispute ruling without clearing the underlying finding", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "warden-dispute-ruling-")));
  const root = join(dir, "project");
  const other = join(dir, "other");
  const file = "src/feature.ts";
  const git = (cwd: string, ...args: string[]) => execFileSync("git", [
    "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args,
  ], { cwd, stdio: "pipe" });
  const warden = (cwd: string, ...args: string[]) => withVerdict(args, spawnSync(process.execPath, [join(wardenRoot, "bin/warden.js"), ...args], { cwd, encoding: "utf8" }));
  const check = () => warden(root, "check", file, "--tier", "edit", "--base", "main");
  const attribution = ["--role", "independent-reviewer", "--actor", "Review fixture", "--reason", "The example needs clarification", "--evidence", "review-note.md"];
  try {
    await cp(join(wardenRoot, "test/fixtures/project-valid"), root, { recursive: true });
    await mkdir(join(root, "src"));
    await writeFile(join(root, file), "export const feature = 1;\n");
    git(root, "init", "-q", "-b", "main");
    const set = await loadRecords(root, wardenRoot);
    const { files, lock } = await expectedOutputs(set, root, wardenRoot);
    await writeFile(join(root, LOCK_PATH), JSON.stringify(lock));
    for (const [path, content] of Object.entries(files)) {
      const output = join(root, path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, content);
    }
    git(root, "add", "-A");
    git(root, "commit", "-qm", "Add sample");
    git(dir, "clone", "-q", root, other);
    await writeFile(join(root, file), "// Context for the example\nexport const feature = 2;\n");
    expect(check().status).toBe(1);
    const filed = warden(root, "dispute", "warden-no-comments", file, "--reason", "Need an example", "--attempt", "Move explanation to docs");
    expect(filed.status, filed.stderr).toBe(0);
    const opened = readEvidence("fixture").find((event) => event.kind === "disputed" && event.root === root);
    if (opened?.dispute === undefined) throw new Error("The CLI did not record a dispute ID");
    const id = opened.dispute;
    expect(JSON.parse(await readFile(join(wardenHome(), "disputes", `${id}.open.json`), "utf8"))).toMatchObject({
      dispute: id, reason: "Need an example", attempts: ["Move explanation to docs"], root, file,
    });
    const previousId = randomUUID();
    appendEvidence("fixture", { ...opened, dispute: previousId });
    const legacy = warden(root, "review", "dispute", previousId, "--status", "rejected", ...attribution);
    expect(legacy.status, legacy.stderr).toBe(0);
    expect(JSON.parse(legacy.stdout)).toMatchObject({ dispute: previousId, status: "rejected" });
    for (const _ of [1, 2]) {
      await truncate(evidenceFile("fixture"), ROTATE_BYTES);
      appendEvidence("fixture", { kind: "cost", at: new Date().toISOString(), ms: 1 });
    }
    expect(readEvidence("fixture").some((event) => event.dispute === id)).toBe(false);
    const decide = (cwd: string, status: string) => warden(cwd, "review", "dispute", id, "--status", status, ...attribution);
    expect(decide(other, "upheld").status).toBe(2);
    const accepted = decide(root, "upheld");
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      dispute: id, status: "upheld", role: "independent-reviewer", actor: "Review fixture",
      root, file, pack: "core", guardrail: "warden-no-comments", evidence: "review-note.md",
    });
    const retried = decide(root, "upheld");
    expect(retried.status, retried.stderr).toBe(0);
    expect(retried.stdout).toBe(accepted.stdout);
    const conflict = decide(root, "rejected");
    expect(conflict.status).toBe(2);
    expect(conflict.stderr).toContain("already has a different ruling");
    expect(check().status).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
