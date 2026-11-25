import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { appendEvidence, RUN_TOTAL, wardenHome, writeAtomic } from "../dist/src/runner/evidence.js";
import { parseConfig } from "../dist/src/records/load.js";

const exec = promisify(execFile);
const tiers = ["edit", "boundary"];
const intervalMs = 10_000;
const retryMs = 60_000;
const trigger = "main audit";
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const commitSha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const gitEnv = { ...process.env, GIT_ALLOW_PROTOCOL: "file", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" };
delete gitEnv.GIT_DIR;
delete gitEnv.GIT_WORK_TREE;
delete gitEnv.GIT_INDEX_FILE;
delete gitEnv.GIT_COMMON_DIR;

const git = async (cwd, args, signal) => (await exec("git", args, {
  cwd, signal, env: gitEnv, maxBuffer: 1024 * 1024,
})).stdout.trim();

const commitAt = (root, ref, signal) =>
  git(root, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"], signal);

const total = (entry) => entry.kind === "cost" && entry.guardrail === RUN_TOTAL;
const completed = (entry) => entry.exit === 0 && (entry.outcome === "ran" || entry.outcome === "empty");

async function auditTier({ root, project, ref, commit, base, tier, checkout, executable, auditHome, packs, signal }) {
  const at = new Date().toISOString();
  const start = performance.now();
  let exit = 0;
  let message;
  try {
    await exec(executable, ["audit", "--tier", tier, "--base", base, "--format", "json"], {
      cwd: checkout,
      env: { ...gitEnv, WARDEN_HOME: auditHome, GIT_ALLOW_PROTOCOL: "" },
      maxBuffer: 16 * 1024 * 1024,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    exit = typeof error.code === "number" ? error.code : 2;
    message = error.stderr?.trim() || error.message;
  }

  const path = join(auditHome, "evidence", project + ".jsonl");
  let entries = [];
  try {
    entries = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const summary = entries.findLast((entry) => total(entry) && entry.tier === tier && entry.at >= at);
  if (summary === undefined && exit === 0) {
    exit = 2;
    message = `Warden produced no ${tier} receipt for ${commit}.`;
  }
  const fallback = { at, kind: "cost", guardrail: RUN_TOTAL, run: randomUUID(), tier,
    outcome: "error", exit, ms: performance.now() - start, files: 0, next: message };
  appendEvidence(project, {
    ...(summary ?? fallback),
    ...(exit !== 0 && summary?.exit !== exit ? { outcome: "error", exit } : {}),
    ...(message === undefined ? {} : { next: summary?.next ?? message }),
    root, ref, commit, base, packs, trigger,
  });
  return exit === 0 && summary !== undefined && completed(summary);
}

async function auditMain({ root, project, ref, executable, approvedPolicies, policyCommit, initialBase, once, signal }) {
  const commit = await commitAt(root, ref, signal);
  const path = join(wardenHome(), "main-audits", sha256([root, project, ref].join("\0")) + ".json");
  let checkpoint = { tiers: {} };
  try {
    checkpoint = JSON.parse(await readFile(path, "utf8"));
    if (!checkpoint || !commitSha.test(checkpoint.head) || !commitSha.test(checkpoint.base) || !checkpoint.tiers ||
        Object.entries(checkpoint.tiers).some(([tier, state]) => !tiers.includes(tier) ||
          !state || !commitSha.test(state.base) || !commitSha.test(state.commit) ||
          !Number.isFinite(state.at) || state.completed !== undefined && !commitSha.test(state.completed))) {
      throw new Error("invalid checkpoint");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Cannot read the main audit checkpoint at ${path}: ${error.message}`);
  }
  const prior = checkpoint.head;
  if (prior !== undefined && prior !== commit) {
    try {
      await git(root, ["merge-base", "--is-ancestor", prior, commit], signal);
    } catch (error) {
      if (error.code === 1) throw new Error(`${ref} no longer descends from ${prior}. Verify the published history before resuming automatic audits.`);
      throw error;
    }
  }
  const pending = tiers.filter((tier) => {
    const state = checkpoint.tiers[tier];
    return state?.completed !== commit && (once || state?.commit !== commit || Date.now() - state.at >= retryMs);
  });
  if (pending.length === 0) return true;
  if (checkpoint.base === undefined && initialBase !== undefined) {
    await git(root, ["merge-base", "--is-ancestor", initialBase, commit], signal);
  }
  checkpoint.head = commit;
  checkpoint.base ??= await commitAt(root, initialBase ?? commit + "^", signal);
  writeAtomic(path, JSON.stringify(checkpoint) + "\n");
  const scratch = await mkdtemp(join(tmpdir(), "warden-main-audit-"));
  try {
    const checkout = join(scratch, "checkout");
    await git(scratch, ["clone", "--quiet", "--shared", "--single-branch", "--no-tags", "--no-checkout", "--", root, checkout], signal);
    await git(checkout, ["checkout", "--quiet", "--detach", commit], signal);
    if (policyCommit !== undefined) {
      try {
        await lstat(join(checkout, ".warden"));
        throw new Error(`Cannot install the pinned audit policy because ${commit} already contains .warden.`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await git(checkout, ["restore", `--source=${policyCommit}`, "--worktree", "--", ".warden"], signal);
    }
    const [config, lockText] = await Promise.all([
      readFile(join(checkout, ".warden/config.yaml"), "utf8"),
      readFile(join(checkout, ".warden/lock.json"), "utf8"),
    ]);
    if (approvedPolicies !== undefined) {
      const configHash = sha256(config);
      const lockHash = sha256(lockText);
      if (!approvedPolicies.some((policy) => policy.config === configHash && policy.lock === lockHash)) {
        throw new Error(`Audit skipped for ${commit}: the published config and lock hashes are outside the approved policy list.`);
      }
    }
    const lock = JSON.parse(lockText);
    const compiled = parseConfig(".warden/config.yaml", config);
    if (compiled.project !== project) throw new Error(`Expected Warden project ${project}, got ${compiled.project}.`);
    if (lock.config.base !== compiled.base) throw new Error(`Config and lock record different bases at ${commit}.`);
    const packs = compiled.packs.filter((pack) => pack.enabled !== false).map((pack) => pack.id);
    let allCompleted = true;
    for (const tier of pending) {
      const previous = checkpoint.tiers[tier];
      const base = previous?.completed ?? previous?.base ?? checkpoint.base;
      const state = { ...previous, base, commit, at: Date.now() };
      checkpoint.tiers[tier] = state;
      writeAtomic(path, JSON.stringify(checkpoint) + "\n");
      const completedTier = await auditTier({ root, project, ref, commit, base, tier, checkout, executable, auditHome: join(scratch, "evidence-home"), packs, signal });
      if (completedTier) {
        state.completed = commit;
        writeAtomic(path, JSON.stringify(checkpoint) + "\n");
      }
      allCompleted = allCompleted && completedTier;
    }
    return allCompleted;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const { positionals: args, values } = parseArgs({ allowPositionals: true, options: {
    once: { type: "boolean" },
    "policy-commit": { type: "string" },
    "initial-base": { type: "string" },
  } });
  const { once, "policy-commit": policyCommit, "initial-base": initialBase } = values;
  const [root, project, ref, executable, policyFile] = args;
  if (!root || !project || !ref || !executable || !isAbsolute(executable) ||
      !/^[a-z0-9][a-z0-9-]*$/.test(project) || !ref.startsWith("refs/") ||
      args.length > 5) {
    throw new Error("Usage: node scripts/watch-main.mjs <repo> <project> <full-ref> <warden-executable> [approved-policies.json] [--policy-commit <sha>] [--initial-base <sha>] [--once]");
  }
  if (policyCommit !== undefined && (!commitSha.test(policyCommit) || policyFile === undefined)) {
    throw new Error("--policy-commit requires a full commit SHA and an approved policy list.");
  }
  if (initialBase !== undefined && !commitSha.test(initialBase)) throw new Error("--initial-base requires a full commit SHA.");
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  const approvedPolicies = policyFile === undefined ? undefined : JSON.parse(await readFile(policyFile, "utf8"));
  if (approvedPolicies !== undefined && (!Array.isArray(approvedPolicies) || approvedPolicies.length === 0 ||
      approvedPolicies.some((policy) => !/^[0-9a-f]{64}$/.test(policy?.config) || !/^[0-9a-f]{64}$/.test(policy?.lock)))) {
    throw new Error("The approved policy list must contain pairs of config and lock SHA-256 digests.");
  }
  const options = { root: await realpath(root), project, ref, executable, approvedPolicies, policyCommit, initialBase, once, signal: controller.signal };
  let lastError;
  do {
    try {
      if (!await auditMain(options) && once) process.exitCode = 1;
      lastError = undefined;
    } catch (error) {
      if (controller.signal.aborted) return;
      if (once) throw error;
      if (lastError !== error.message) process.stderr.write(`${new Date().toISOString()} ${error.message}\n`);
      lastError = error.message;
    }
    if (once) return;
    await delay(intervalMs, undefined, { signal: controller.signal });
  } while (!controller.signal.aborted);
}

main().catch((error) => {
  if (error.name === "AbortError") return;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
