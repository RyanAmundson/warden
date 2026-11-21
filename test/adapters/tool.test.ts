import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { toolRegistrationAdapter as toolAdapter } from "../../src/adapters/tool-registration.js";
import type { Guardrail } from "../../src/records/types.js";
import { conformance } from "./conformance.js";
import { treeSet } from "./tree-pack.js";

it("reports new tools and accepts registered tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-tool-conformance-"));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, stdio: "pipe" });
  };
  const rule: Guardrail = {
    id: "registered-tools", implementation: "tool:registration", kind: "lint",
    scope: "project", runs: ["boundary"], version: 1, budgetMs: 5000,
  };
  try {
    git("init", "-qb", "main");
    await writeFile(join(root, "package.json"), "{}\n");
    git("add", "package.json");
    git("commit", "-qm", "Add fixture manifest");
    await writeFile(join(root, "package.json"), '{"scripts":{"report":"node report.js"}}\n');
    await conformance(toolAdapter, root, [rule], treeSet(rule), ["package.json"], [{
      guardrail: rule.id, file: "package.json", line: 1, message: "New npm script report has no tool Capability.",
      doThis: "Register npm run report in an enabled tool Capability, then compile and sign the policy.",
    }], { base: "main" });
    await conformance(toolAdapter, root, [rule], treeSet(rule), ["package.json"], [], { base: "main", toolCommands: ["npm run report"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
