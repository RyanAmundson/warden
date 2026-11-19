import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readEvidence } from "../../src/runner/evidence.js";

const cli = resolve(import.meta.dirname, "../../bin/warden.js");
const fixture = resolve(import.meta.dirname, "../fixtures/project-valid");
const id = "warden-no-comments";
let root: string;

const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root });
const warden = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
const file = "src/-feature with space.ts";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "warden-dispute-")));
  await cp(fixture, root, { recursive: true });
  await mkdir(join(root, "src"));
  await writeFile(join(root, file), "export const feature = 1;\n");
  git("init", "-q", "-b", "main");
  const compile = warden("compile");
  expect(compile.status, compile.stdout + compile.stderr).toBe(0);
  git("add", "-A");
  git("commit", "-qm", "base");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("records a structured dispute against a failing check and keeps the violation open", async () => {
  const failing = "// context\nexport const feature = 2;\n";
  await writeFile(join(root, file), failing);
  const check = () => warden("check", file, "--tier", "edit", "--rule", id, "--base", "main");
  expect(check().status).toBe(1);
  expect(check().status).toBe(1);
  const repeated = check();
  expect(repeated.status).toBe(1);
  const command = repeated.stdout.match(/and run (warden dispute .+) with --reason/)?.[1];
  expect(command).toBe(`warden dispute '${id}' '${join(root, file)}'`);

  const reason = "The explanation must stay with the code";
  const attempts = ["Move the text to the unit document", "Rename the variable"];
  const result = spawnSync("sh", ["-c", `warden() { "$WARDEN_TEST_NODE" "$WARDEN_TEST_CLI" "$@"; }; ${command} --reason "$1" --attempt "$2" "$3"`, "fixture", reason, ...attempts], {
    cwd: join(root, "src"),
    env: { ...process.env, WARDEN_TEST_NODE: process.execPath, WARDEN_TEST_CLI: cli },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const event = readEvidence("fixture").filter((entry) => entry.kind === "disputed").at(-1);
  expect(event).toMatchObject({
    kind: "disputed", guardrail: id, file, pack: "core", status: "open", detail: reason,
    attempts, dispute: expect.any(String), trigger: "manual",
  });
  expect(result.stdout).toContain(event?.dispute);
  expect(check().status).toBe(1);
  expect(await readFile(join(root, file), "utf8")).toBe(failing);
});

it("names the missing inputs and records only the corrected dispute", () => {
  const previous = readEvidence("fixture").filter((entry) => entry.kind === "disputed").length;
  const incomplete = warden("dispute", id, file, "--reason", "Need a different example");
  expect(incomplete.status).toBe(2);
  expect(incomplete.stderr.match(/Next action:/g)).toHaveLength(1);
  expect(incomplete.stderr).toContain("--attempt");
  expect(readEvidence("fixture").filter((entry) => entry.kind === "disputed")).toHaveLength(previous);
  const corrected = warden("dispute", id, file, "--reason", "Need a different example", "--attempt", "Follow the example");
  expect(corrected.status, corrected.stderr).toBe(0);
  expect(readEvidence("fixture").filter((entry) => entry.kind === "disputed")).toHaveLength(previous + 1);
});
