import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { claudeSession } from "../adapters/claude.js";
import { sha256 } from "../compiler/lock.js";
import { parseConfig, RecordError } from "../records/load.js";
import { appendEvidence, readEvidence, RUN_TOTAL, type Evidence } from "../runner/evidence.js";

type Failure = Evidence & Required<Pick<Evidence, "file" | "guardrail" | "detail" | "pack" | "run" | "policy">>;

function confirmed(event: Evidence, completed: ReadonlySet<string>): event is Failure {
  return event.kind === "fired" && event.status === "fail" && event.tier === "edit" && event.session !== undefined &&
    event.triggered === true && event.run !== undefined && completed.has(event.run) && event.policy !== undefined &&
    event.pack !== undefined && event.guardrail !== undefined && event.detail !== undefined && Boolean(event.file);
}

const stillPresent = (root: string, { file, detail }: Failure): boolean => {
  const path = join(root, file);
  try {
    return lstatSync(path).isFile() && realpathSync(path).startsWith(root + sep) && sha256(readFileSync(path)) === detail;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
};

export function recordClaudeStalls(root: string, input: string): void {
  const session = claudeSession(input, "SessionEnd");
  if (session === undefined) throw new RecordError("hook input", "/session_id", "Expected a Claude Code SessionEnd event with its session ID.");
  const configPath = join(root, ".warden/config.yaml");
  const { project } = parseConfig(configPath, readFileSync(configPath, "utf8"));
  const location = `"root":${JSON.stringify(root)}`;
  const owner = `"session":${JSON.stringify(session)}`;
  const rows = readEvidence(project, (line) => line.includes(location) && (
    line.includes(owner) || line.includes('"kind":"fired"') || line.includes('"kind":"resolved"') ||
    line.includes('"kind":"disputed"') || (line.includes('"kind":"cost"') && line.includes('"guardrail":"run"') && line.includes('"result":"fail"'))
  )).filter((e) => e.root === root);
  const completed = new Set(rows.flatMap((e) =>
    e.kind === "cost" && e.guardrail === RUN_TOTAL && e.trigger === "agent-edit" && e.tier === "edit" &&
    e.outcome === "ran" && e.result === "fail" && e.run !== undefined ? [e.run] : [],
  ));
  const open = new Map<string, Failure>();
  const latest = new Map<string, Failure>();
  const disputed = new Map<string, Failure>();
  const sameJudgment = (a: Failure | undefined, b: Failure): boolean =>
    a?.detail === b.detail && a.policy === b.policy;
  for (const event of rows) {
    const key = JSON.stringify([event.pack, event.guardrail, event.file]);
    if (confirmed(event, completed)) {
      latest.set(key, event);
      if (event.session === session && !sameJudgment(disputed.get(key), event)) open.set(key, event);
      continue;
    }
    if (event.kind === "disputed" && event.status === "open") {
      const judgment = latest.get(key);
      if (judgment !== undefined) {
        disputed.set(key, judgment);
        if (sameJudgment(open.get(key), judgment)) open.delete(key);
      }
      continue;
    }
    if (event.kind === "resolved" && event.sourceRun === latest.get(key)?.run && event.policy === latest.get(key)?.policy) latest.delete(key);
    const failure = open.get(key);
    if (failure === undefined || event.sourceRun !== failure.run) continue;
    if (event.kind === "stalled" && event.session === session) open.delete(key);
    if (event.kind === "resolved" && event.policy === failure.policy) open.delete(key);
  }
  for (const failure of open.values()) {
    if (!stillPresent(root, failure)) continue;
    const { pack, guardrail, file, detail, run, policy } = failure;
    appendEvidence(project, {
      at: new Date().toISOString(), kind: "stalled", status: "fail", tier: "edit", root, session,
      pack, guardrail, file, detail, sourceRun: run, policy,
    });
  }
}
