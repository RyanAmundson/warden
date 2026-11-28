import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "vitest";

const helper = resolve(import.meta.dirname, "../../skills/main-audit/scripts/read-audit.py");

test("filters agent queries and updates to task files before limiting results", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "warden-scoped-audit-")));
  const root = join(scratch, "project");
  const worktree = join(scratch, "linked");
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args,
  ], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  for (const file of ["task.ts", "staged.ts", "branch.ts", "unrelated.ts"]) writeFileSync(join(root, file), "base");
  git("add", ".");
  git("commit", "-qm", "Published");
  const commit = git("rev-parse", "HEAD");
  const ref = "refs/remotes/origin/main";
  git("update-ref", ref, commit);
  git("worktree", "add", "--detach", worktree, commit);
  writeFileSync(join(worktree, "branch.ts"), "changed");
  git("-C", worktree, "commit", "-qam", "Branch");
  writeFileSync(join(worktree, "staged.ts"), "changed");
  git("-C", worktree, "add", "staged.ts");
  writeFileSync(join(worktree, "task.ts"), "changed");
  writeFileSync(join(worktree, "new.ts"), "untracked");

  const finding = (file: string, line: number) => ({ file, line, guardrail: "eslint/rule" });
  const matches = ["branch.ts", "staged.ts", "new.ts"].map((file) => finding(file, 1));
  const task = Array.from({ length: 11 }, (_, line) => finding("task.ts", line + 1));
  let findings = [...Array.from({ length: 25 }, (_, i) => finding("unrelated.ts", i + 1)), ...matches, ...task];
  let run = "receipt";
  let stream: ServerResponse | undefined;
  let markUnrelatedRead: () => void;
  const unrelatedRead = new Promise<void>((done) => { markUnrelatedRead = done; });
  const server = createServer((req, res) => {
    const summary = { run, root, ref, commit, outcome: "ran", kinds: { lint: findings.length }, report: { adapter: "eslint" } };
    if (req.url === "/api/events") {
      stream = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("retry: 1000\n\n");
      return;
    }
    const body = req.url?.startsWith("/api/projects") ? {
      projects: [{ project: "project", auditOnly: { root, ref }, lastMainAudit: null, mainAuditRuns: [], mainReports: [summary] }],
    } : { findings, runs: [summary] };
    res.setHeader("content-type", "application/json").end(JSON.stringify(body));
    if (req.url?.startsWith("/api/runs") && run === "unrelated-update") markUnrelatedRead();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture daemon did not start");
  const invoke = (cwd: string, ...args: string[]) =>
    spawn("python3", [helper, "--port", String(address.port), ...args], { cwd });
  const read = async (cwd: string, ...args: string[]) => {
    const child = invoke(cwd, ...args);
    let output = "";
    for await (const chunk of child.stdout) output += String(chunk);
    return JSON.parse(output);
  };
  let watcher: ReturnType<typeof invoke> | undefined;
  try {
    const before = git("-C", worktree, "status", "--porcelain");
    const inferred = await read(worktree);
    expect(inferred.scope).toEqual({ mode: "changed-files", files: 4 });
    expect(new Set(inferred.findings.map((item: { file: string }) => item.file))).toEqual(
      new Set(["task.ts", "staged.ts", "branch.ts", "new.ts"]),
    );

    const explicit = await read(worktree, "--path", "task.ts");
    expect(explicit).toMatchObject({ scope: { mode: "task-files", files: 1 }, more_matching_findings: 1 });
    expect(explicit.findings).toHaveLength(10);
    expect(explicit.findings.every((item: { file: string }) => item.file === "task.ts")).toBe(true);

    expect(explicit).not.toHaveProperty("runs");
    expect(await read(worktree, "--path", root)).toMatchObject({ status: "unavailable" });
    expect(await read(root)).toMatchObject({ status: "no_scope", scope: { files: 0 } });
    expect(git("-C", worktree, "status", "--porcelain")).toBe(before);

    const taskFile = join(worktree, "task.ts");
    unlinkSync(taskFile);
    symlinkSync("unrelated.ts", taskFile);
    expect(await read(worktree, "--path", "task.ts")).toEqual(explicit);

    watcher = invoke(worktree, "--path", "task.ts", "--watch");
    const lines = createInterface({ input: watcher.stdout })[Symbol.asyncIterator]();
    const nextResult = async () => {
      const line = await lines.next();
      if (line.done) throw new Error("Subscription closed before reporting a result");
      return JSON.parse(line.value);
    };
    expect(await nextResult()).toEqual(explicit);
    unlinkSync(taskFile);
    const afterRemoval = git("-C", worktree, "status", "--porcelain");
    findings = [finding("unrelated.ts", 99), ...matches, ...task];
    run = "unrelated-update";
    stream?.write('event: evidence\ndata: {"project":"project"}\n\n');
    await unrelatedRead;
    findings = [finding("task.ts", 42)];
    run = "task-update";
    stream?.write('event: evidence\ndata: {"project":"project"}\n\n');
    const update = await nextResult();
    expect(update.findings).toEqual([expect.objectContaining(finding("task.ts", 42))]);
    expect(git("-C", worktree, "status", "--porcelain")).toBe(afterRemoval);
  } finally {
    watcher?.kill();
    stream?.end();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(scratch, { recursive: true, force: true });
  }
}, 15_000);
