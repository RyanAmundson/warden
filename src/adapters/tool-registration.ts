import { readFileSync } from "node:fs";
import { RecordError } from "../records/load.js";
import { LAUNCHER_HEADER_BYTES, declaredTools, launcherInterpreter, normalToolCommand, scriptCommand, toolFile, toolPath } from "../records/tools.js";
import { blobHeader, mergeBase, showAtCommit, treeBlobsAt } from "../runner/changed.js";
import type { Adapter, Violation } from "./types.js";

export const toolRegistrationAdapter: Adapter = {
  id: "tool",
  wholeTree: true,
  emit: (gs) => {
    for (const g of gs) {
      if (g.implementation !== "tool:registration" || g.scope !== "project" || g.runs.length !== 1 || g.runs[0] !== "boundary") {
        throw new RecordError(g.packDir ?? "", `/guardrails/${g.id}`, "Use tool:registration as a project-scoped Guardrail at the boundary.");
      }
    }
    return {};
  },
  run: async (gs, files, ctx) => {
    const available = new Set(files);
    const registrations = new Set((ctx.toolCommands ?? []).map(normalToolCommand));
    const results = [];
    for (const g of gs) {
      const start = performance.now();
      if (ctx.base === undefined) throw new RecordError("", "/base", "Tool registration needs a comparison base. Next action: supply --base to warden check.");
      const at = ctx.mergeBase ?? mergeBase(ctx.root, ctx.base);
      const settings = ctx.settingsOf?.(g);
      const manifests = (settings?.manifests ?? ["package.json"]) as string[];
      const folders = (settings?.scriptFolders ?? ["scripts"]) as string[];
      const scoped = files.filter((file) => folders.some((folder) => file.startsWith(`${folder}/`)));
      const baseFiles = scoped.length === 0 ? undefined : await treeBlobsAt(ctx.root, at, folders);
      const violations: Violation[] = [];
      const reported = new Set<string>();
      const report = (file: string, tool: string, command: string): void => {
        if (registrations.has(command) || reported.has(command)) return;
        reported.add(command);
        violations.push({
          guardrail: g.id, file, line: 1, message: `New ${tool} has no tool Capability.`,
          doThis: `Register ${command} in an enabled tool Capability, then compile and sign the policy.`,
        });
      };
      for (const file of manifests) {
        if (!available.has(file)) continue;
        const manifest = toolFile(ctx.root, file);
        if (manifest === undefined) throw new RecordError(file, "", "A monitored npm manifest must be a regular file in the checkout. Next action: restore the regular file and rerun the check.");
        const before = new Set(declaredTools(file, showAtCommit(ctx.root, at, file)).map(({ kind, name }) => `${kind}/${name}`));
        const tools = declaredTools(file, readFileSync(manifest.path, "utf8"));
        for (const entry of tools) {
          const { kind, name } = entry;
          if (before.has(`${kind}/${name}`)) continue;
          const command = entry.kind === "script" ? entry.command : scriptCommand(ctx.root, entry.file, true);
          if (command === undefined) throw new RecordError(file, `/bin/${name}`, "The new npm bin needs a local launcher. Next action: restore the executable or interpreter script named by the bin entry.");
          report(file, `npm ${kind} ${name}`, command);
        }
      }
      for (const file of scoped) {
        const before = baseFiles?.get(file);
        if (before?.mode === "100755") continue;
        const command = scriptCommand(ctx.root, file);
        if (command === undefined) continue;
        if (before !== undefined && launcherInterpreter(await blobHeader(ctx.root, before.oid, LAUNCHER_HEADER_BYTES)) !== undefined) continue;
        if (!toolPath(file)) throw new RecordError(file, "", "A new launcher needs a portable path. Next action: rename it to use letters, digits, dots, dashes, or underscores.");
        report(file, "standalone script", command);
      }
      results.push({ guardrail: g.id, status: violations.length === 0 ? "pass" as const : "fail" as const, violations, ms: performance.now() - start + (ctx.projectInventory?.discoveryMs ?? 0) });
    }
    return results;
  },
};
