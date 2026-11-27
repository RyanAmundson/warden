import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { serve } from "../../src/cli/daemon.js";
import * as changed from "../../src/runner/changed.js";
import { openAlerts, stateFile } from "../../src/runner/daemon.js";
import * as enrollmentTools from "../../src/runner/enrollment.js";
import { appendEvidence } from "../../src/runner/evidence.js";

const wardenRoot = resolve(import.meta.dirname, "../..");

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=Warden Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function init(root: string, project: string): void {
  mkdirSync(join(root, ".warden"), { recursive: true });
  writeFileSync(join(root, ".warden/config.yaml"), `project: ${project}
base: main
packs: []
tierBudgetMs: { edit: 1000, commit: 1000, boundary: 1000 }
loopBreakerRepeats: 3
`);
  git(root, "init", "-qb", "main");
  git(root, "config", "core.hooksPath", join(root, "no-hooks"));
  git(root, "add", ".warden/config.yaml");
  git(root, "commit", "-qm", "Register fixture");
}

it("shows the published audit and excludes the repository's remembered and newly linked worktrees", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "warden-audit-only-")));
  const root = join(scratch, "audit-only");
  const linked = join(scratch, "linked");
  const separate = join(scratch, "separate");
  const repo = join(root, ".git");
  const ref = "refs/remotes/origin/main";
  const list = vi.spyOn(changed, "worktrees");
  const audits = vi.spyOn(enrollmentTools, "auditEnrollment").mockImplementation((_project, { signal }) =>
    new Promise((resolve) => signal?.addEventListener("abort", () => resolve(false), { once: true })));
  let dashboard: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    init(root, "audit-only");
    init(separate, "separate");
    git(root, "worktree", "add", "--detach", linked);
    const directory = join(enrollmentTools.enrollmentsDir(), "audit-only");
    mkdirSync(directory, { recursive: true });
    mkdirSync(resolve(stateFile(), ".."), { recursive: true });
    writeFileSync(join(directory, "enrollment.json"), JSON.stringify({ project: "audit-only", root, ref, data: [], links: [] }));
    writeFileSync(stateFile(), JSON.stringify({ roots: { [linked]: { open: [{
      project: "audit-only", root: linked, repo, file: "fixture", detail: "unchecked-commit", next: "check",
    }] } }, repos: { [repo]: { tips: [], unchecked: [] } } }));
    const at = new Date().toISOString();
    appendEvidence("audit-only", { at, kind: "registered", root: linked });
    appendEvidence("audit-only", { at, kind: "cost", guardrail: "run", tier: "edit", run: "one", trigger: "main audit", root, ref, exit: 0, outcome: "ran" });
    appendEvidence("separate", { at, kind: "registered", root: separate });
    dashboard = await serve(wardenRoot, 0);
    await dashboard.daemon.discover();
    expect([...dashboard.daemon.projects.keys()]).toEqual([separate]);
    expect(list.mock.calls.map(([directory]) => directory)).not.toContain(repo);
    expect(openAlerts(linked)).toEqual([]);
    const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/projects`);
    expect(await response.json()).toMatchObject({ projects: [
      { project: "audit-only", roots: [], openAlerts: 0, mode: "audit", lastMainAudit: { root, ref, run: "one" } },
      { project: "separate", roots: [separate] },
    ] });
    for (const route of ["layers", "violations"]) {
      const unavailable = await fetch(`http://127.0.0.1:${dashboard.port}/api/${route}?project=audit-only`);
      expect(unavailable.status).toBe(409);
      expect(await unavailable.json()).toMatchObject({ error: "This project audits a published ref and has no watched checkouts." });
    }
    const watch = (watching: boolean): Promise<Response> => {
      const origin = `http://127.0.0.1:${dashboard?.port}`;
      return fetch(`${origin}/api/watch`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ project: "audit-only", watching }),
      });
    };
    const roster = async (): Promise<string[]> => {
      const response = await fetch(`http://127.0.0.1:${dashboard?.port}/api/projects`);
      return (await response.json()).projects.map((entry: { project: string }) => entry.project);
    };
    const enrollment = join(directory, "enrollment.json");
    const before = readFileSync(enrollment, "utf8");
    expect(audits).toHaveBeenCalledTimes(1);
    const signal = audits.mock.calls[0]?.[1].signal;
    expect((await watch(false)).status).toBe(200);
    expect(signal?.aborted).toBe(true);
    expect(await roster()).toEqual(["separate"]);
    await dashboard.close();
    dashboard = await serve(wardenRoot, 0);
    expect(await roster()).toEqual(["separate"]);
    expect(audits).toHaveBeenCalledTimes(1);
    expect((await watch(true)).status).toBe(200);
    expect(audits).toHaveBeenCalledTimes(2);
    expect(await roster()).toEqual(["audit-only", "separate"]);
    expect(readFileSync(enrollment, "utf8")).toBe(before);
  } finally {
    await dashboard?.close();
    list.mockRestore();
    audits.mockRestore();
    rmSync(scratch, { recursive: true, force: true });
  }
});
