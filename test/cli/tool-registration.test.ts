import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { withVerdict } from "../verdict.js";

const warden = resolve(import.meta.dirname, "../..");

it("blocks new npm and standalone tools until an enabled Capability registers them", async () => {
  const temp = await mkdtemp(join(tmpdir(), "warden-tool-registration-"));
  const root = join(temp, "repo");
  const pack = ".warden/packs/local/pack.yaml";
  const installed = join(temp, "warden");
  const cli = join(installed, "bin/warden.js");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  const run = (...args: string[]) => withVerdict(args, spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, WARDEN_HOME: join(temp, "warden-home") } }));
  const write = (path: string, content: unknown) => writeFile(join(root, path), JSON.stringify(content));
  const check = () => run("check", "--rule", "no-unregistered-tools", "--tier", "boundary", "--base", "main", "--format", "json");

  try {
    await mkdir(installed);
    for (const path of ["packs", "node_modules", "package.json"]) await symlink(join(warden, path), join(installed, path));
    for (const path of ["bin", "dist/src", "dist/eslint-plugin", "dist/schema"]) {
      await cp(join(warden, path), join(installed, path), { recursive: true });
    }
    await mkdir(join(root, ".warden/packs/local"), { recursive: true });
    await mkdir(join(root, "packages/tools"), { recursive: true });
    await mkdir(join(root, "scripts"));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Warden fixture");
    git("config", "user.email", "fixture@example.invalid");
    const key = join(temp, "signing-key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    git("config", "gpg.format", "ssh");
    git("config", "user.signingkey", key);
    await writeFile(join(installed, "allowed_signers"), `fixture@example.invalid ${await readFile(key + ".pub", "utf8")}`);
    await writeFile(join(root, ".warden/config.yaml"), `project: tool-registration-fixture
base: main
packs:
  - id: local
    paths: []
  - id: tool-registration
    paths: []
    settings:
      manifests: [package.json, packages/tools/package.json]
tierBudgetMs: { edit: 1000, commit: 10000, boundary: 120000 }
loopBreakerRepeats: 3
`);
    await writeFile(join(root, pack), `id: local
layer: 100
terms:
  - id: reporting
    definition: Produce the project report.
    bans: []
practices: []
`);
    await write("package.json", { scripts: { "old report": "node old.js", old: "" } });
    await write("packages/tools/package.json", { name: "@fixture/tools" });
    await writeFile(join(root, "scripts/convert.sh"), "Preparation notes.\n".repeat(150_000));
    const initial = run("compile");
    expect(initial.status, initial.stderr + initial.stdout).toBe(0);
    git("add", "-A");
    git("commit", "-qS", "-m", "Add the project and its signed Warden policy");
    git("switch", "-q", "-c", "new-tools");
    expect(check().status).toBe(0);

    await write("packages/tools/package.json", { name: "@fixture/tools", bin: { tools: "./report.js" }, scripts: { audit: "node report.js" } });
    await writeFile(join(root, "packages/tools/report.js"), "process.stdout.write('report');\n");
    await writeFile(join(root, "scripts/report.sh"), "#!/bin/sh\nprintf '%s\\n' report\n");
    await writeFile(join(root, "scripts/convert.sh"), "#!/bin/sh\nprintf '%s\\n' convert\n");
    await chmod(join(root, "scripts/convert.sh"), 0o755);
    await writeFile(join(root, "scripts/scan.mjs"), "#!/usr/bin/env -S node --no-warnings\nprocess.stdout.write('scan');\n");
    await writeFile(join(root, "scripts/readme draft.md"), "Draft usage notes.\n");
    await write("package.json", { scripts: { "old report": "node report.js", old: "", report: "node report.js" }, bin: { "shell-report": "./scripts/report.sh" } });
    const blocked = check();
    expect(blocked.status, blocked.stderr + blocked.stdout).toBe(1);
    const { failures } = JSON.parse(blocked.stdout);
    expect(failures.map(({ file, why }: { file: string; why: string }) => ({ file, why }))).toEqual([
      { file: "package.json", why: "warden explain register-project-tools" },
      { file: "package.json", why: "warden explain register-project-tools" },
      { file: "packages/tools/package.json", why: "warden explain register-project-tools" },
      { file: "packages/tools/package.json", why: "warden explain register-project-tools" },
      { file: "scripts/convert.sh", why: "warden explain register-project-tools" },
      { file: "scripts/scan.mjs", why: "warden explain register-project-tools" },
    ]);

    const register = run("new", "tool", "project-report", "--pack", "local", "--serves", "reporting",
      "--purpose", "Produce the project report.", "--when", "creating reports", "--command",
      "npm run report", "npm --prefix ./packages/tools run audit", "node ./packages/tools/report.js", "sh ./scripts/report.sh", "./scripts/convert.sh", "node ./scripts/scan.mjs");
    expect(register.status, register.stderr + register.stdout).toBe(0);
    const compiled = run("compile");
    expect(compiled.status, compiled.stderr + compiled.stdout).toBe(0);
    git("add", "-A");
    git("commit", "-qS", "-m", "Register the report tools");
    const accepted = check();
    expect(accepted.status, accepted.stderr + accepted.stdout).toBe(0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
