import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, matchesGlob } from "node:path";
import { promisify } from "node:util";
import { compile } from "../compiler/compile.js";
import { canonicalJson, sha256 } from "../compiler/lock.js";
import { RecordError, parseConfig } from "../records/load.js";
import { ignoresPathCase, pathCaseKey } from "../records/paths.js";
import type { Baseline } from "./baseline.js";
import { RUN_TOTAL, appendEvidence, wardenHome, writeAtomic } from "./evidence.js";
import { TRUST_SIGNERS, signText, signedBy } from "./trust.js";

const exec = promisify(execFile);

export const ENROLLMENT_NAMESPACE = "warden-enrollment";

const TIERS = ["edit", "boundary"] as const;

const RETRY_MS = 60_000;

const TRIGGER = "main audit";

const POLICY = "policy";

const DATA = "data";

const SIGNED = "signed.json";

const BASELINE = `${POLICY}/baseline.json`;

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface Enrollment {
  project: string;
  root: string;
  ref: string;
  data: string[];
  links: string[];
  initialBase?: string;
}

export interface EnrolledProject extends Enrollment {
  dir: string;
}

export interface EnrollmentTamper {
  file: string;
  detail: "unsigned" | "untrusted-signature" | "changed" | "added" | "removed" | "loosened";
  guardrail?: string;
}

interface Manifest {
  enrollment: Enrollment;
  files: Record<string, string>;
  baseline: Baseline;
}

interface TierState {
  base: string;
  commit: string;
  at: number;
  completed?: string;
}

interface Checkpoint {
  head?: string;
  base?: string;
  tampered?: string;
  tiers: Partial<Record<(typeof TIERS)[number], TierState>>;
}

const gitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_ALLOW_PROTOCOL: "file", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[name];
  return env;
};

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "Warden", GIT_AUTHOR_EMAIL: "warden@localhost", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Warden", GIT_COMMITTER_EMAIL: "warden@localhost", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

const git = async (cwd: string, args: string[], signal?: AbortSignal, env: NodeJS.ProcessEnv = {}): Promise<string> =>
  (await exec("git", args, { cwd, signal, env: { ...gitEnv(), ...env }, maxBuffer: 256 * 1024 * 1024 })).stdout.trim();

const commitAt = (root: string, ref: string, signal?: AbortSignal): Promise<string> =>
  git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], signal);

export const enrollmentsDir = (): string => join(wardenHome(), "enrollments");

export const enrollmentDir = (root: string, ref: string): string => join(enrollmentsDir(), sha256(`${root}\0${ref}`).slice(0, 16));

const relativePath = (path: unknown): boolean =>
  typeof path === "string" && path !== "" && !isAbsolute(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const readEnrollment = (dir: string): Enrollment => {
  const file = join(dir, "enrollment.json");
  let value: Partial<Enrollment> | null;
  try {
    value = JSON.parse(readFileSync(file, "utf8")) as Partial<Enrollment> | null;
  } catch (cause) {
    throw new RecordError(file, "", `cannot be read: ${(cause as Error).message}. Next action: run warden enroll migrate again for this repository and ref`);
  }
  if (value === null || typeof value !== "object" ||
    typeof value.project !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.project) ||
    typeof value.root !== "string" || !isAbsolute(value.root) ||
    typeof value.ref !== "string" || !value.ref.startsWith("refs/") ||
    !Array.isArray(value.data) || !value.data.every((glob) => typeof glob === "string" && glob !== "" && !isAbsolute(glob)) ||
    !Array.isArray(value.links) || !value.links.every(relativePath) ||
    (value.initialBase !== undefined && (typeof value.initialBase !== "string" || !COMMIT.test(value.initialBase)))) {
    throw new RecordError(file, "", "needs a project ID, an absolute repository path, a full ref, data globs, relative links, and an optional full initialBase commit. Next action: run warden enroll migrate again for this repository and ref");
  }
  return value as Enrollment;
};

export function readEnrollments(): Map<string, EnrolledProject> {
  const dir = enrollmentsDir();
  const projects = new Map<string, EnrolledProject>();
  if (!existsSync(dir)) return projects;
  for (const name of readdirSync(dir).sort()) {
    const enrolled = join(dir, name);
    if (!existsSync(join(enrolled, "enrollment.json"))) continue;
    const enrollment = readEnrollment(enrolled);
    if (projects.has(enrollment.project)) {
      throw new RecordError(join(enrolled, "enrollment.json"), "/project", `project ${enrollment.project} is enrolled twice. Next action: delete one of the two enrollment folders under ${dir}`);
    }
    projects.set(enrollment.project, { ...enrollment, dir: enrolled });
  }
  return projects;
}

const filesUnder = (dir: string, prefix: string): string[] => {
  if (!existsSync(join(dir, prefix))) return [];
  return readdirSync(join(dir, prefix), { recursive: true, withFileTypes: true }).flatMap((entry) => {
    const path = join(entry.parentPath, entry.name).slice(dir.length + 1);
    if (entry.isSymbolicLink()) throw new RecordError(join(dir, path), "", "is a symbolic link, which an enrollment cannot hold. Next action: replace it with the file it points to");
    return entry.isFile() ? [path] : [];
  });
};

const manifestOf = (dir: string): Manifest => {
  const files = [...filesUnder(dir, POLICY), ...filesUnder(dir, DATA)].sort();
  const baseline = existsSync(join(dir, BASELINE)) ? JSON.parse(readFileSync(join(dir, BASELINE), "utf8")) as Baseline : {};
  return { enrollment: readEnrollment(dir), files: Object.fromEntries(files.map((file) => [file, sha256(readFileSync(join(dir, file)))])), baseline };
};

const manifestText = (dir: string): string => `${canonicalJson(manifestOf(dir))}\n`;

export function signEnrollment(dir: string, key: string): void {
  const text = manifestText(dir);
  const signature = signText(key, ENROLLMENT_NAMESPACE, text, "run warden enroll sign again");
  writeAtomic(join(dir, SIGNED), text);
  writeAtomic(join(dir, `${SIGNED}.sig`), signature);
}

export function enrollmentTampering(dir: string, signers: string): EnrollmentTamper[] {
  const text = existsSync(join(dir, SIGNED)) ? readFileSync(join(dir, SIGNED), "utf8") : undefined;
  const signature = existsSync(join(dir, `${SIGNED}.sig`)) ? readFileSync(join(dir, `${SIGNED}.sig`), "utf8") : undefined;
  if (text === undefined || signature === undefined) return [{ file: join(dir, SIGNED), detail: "unsigned" }];
  if (!signedBy(signers, ENROLLMENT_NAMESPACE, text, signature)) return [{ file: join(dir, `${SIGNED}.sig`), detail: "untrusted-signature" }];
  const signed = JSON.parse(text) as Manifest;
  const now = manifestOf(dir);
  const found: EnrollmentTamper[] = [];
  if (canonicalJson(signed.enrollment) !== canonicalJson(now.enrollment)) found.push({ file: join(dir, "enrollment.json"), detail: "changed" });
  for (const file of [...new Set([...Object.keys(signed.files), ...Object.keys(now.files)])].sort()) {
    if (file === BASELINE) continue;
    const was = signed.files[file];
    const is = now.files[file];
    if (was !== is) found.push({ file: join(dir, file), detail: was === undefined ? "added" : is === undefined ? "removed" : "changed" });
  }
  for (const [guardrail, entries] of Object.entries(now.baseline)) {
    if (Object.entries(entries).some(([file, n]) => n > (signed.baseline[guardrail]?.[file] ?? 0))) found.push({ file: join(dir, BASELINE), detail: "loosened", guardrail });
  }
  return found;
}

const overlay = (dir: string, target: string): void => {
  cpSync(join(dir, POLICY), join(target, ".warden"), { recursive: true });
  if (existsSync(join(dir, DATA))) cpSync(join(dir, DATA), target, { recursive: true });
};

async function snapshot(checkout: string, e: Enrollment, staging: string, commit: string, parent: string | undefined, signal?: AbortSignal): Promise<string> {
  const env = { GIT_INDEX_FILE: join(checkout, ".git", "warden-snapshot-index") };
  await git(checkout, ["read-tree", commit], signal, env);
  const listed = (await git(checkout, ["ls-files", "-z"], signal, env)).split("\0").filter((file) => file !== "");
  const ignoreCase = ignoresPathCase(checkout);
  const keyOf = (path: string): string => pathCaseKey(path, ignoreCase);
  const globs = e.data.map(keyOf);
  const stripped = listed.filter((file) => {
    const key = keyOf(file);
    return key === ".warden" || key.startsWith(".warden/") || globs.some((glob) => matchesGlob(key, glob));
  });
  for (let i = 0; i < stripped.length; i += 500) await git(checkout, ["update-index", "--force-remove", "--", ...stripped.slice(i, i + 500)], signal, env);
  await git(checkout, ["--work-tree", staging, "add", "--force", "--ignore-removal", "--", "."], signal, env);
  const tree = await git(checkout, ["write-tree"], signal, env);
  return git(checkout, ["commit-tree", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", `Warden audit snapshot of ${commit}`], signal, SNAPSHOT_IDENTITY);
}

interface Checkout {
  checkout: string;
  at(commit: string, base?: string): Promise<{ head: string; base?: string }>;
}

async function enrolledCheckout(e: EnrolledProject, scratch: string, signal?: AbortSignal): Promise<Checkout> {
  const checkout = join(scratch, "checkout");
  const staging = join(scratch, "staging");
  mkdirSync(staging);
  overlay(e.dir, staging);
  await git(scratch, ["init", "--quiet", "--", checkout], signal);
  const objects = join(await git(e.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal), "objects");
  writeFileSync(join(checkout, ".git", "objects", "info", "alternates"), `${objects}\n`);
  const at = async (commit: string, base?: string): Promise<{ head: string; base?: string }> => {
    const parent = base === undefined ? undefined : await snapshot(checkout, e, staging, base, undefined, signal);
    const head = await snapshot(checkout, e, staging, commit, parent, signal);
    await git(checkout, ["checkout", "--quiet", "--force", "--detach", head], signal);
    for (const link of e.links) {
      const target = join(e.root, link);
      if (existsSync(target) && !existsSync(join(checkout, link))) symlinkSync(target, join(checkout, link));
    }
    return { head, ...(parent === undefined ? {} : { base: parent }) };
  };
  return { checkout, at };
}

const withScratch = async <T>(run: (scratch: string) => Promise<T>): Promise<T> => {
  const scratch = realpathSync(await mkdtemp(join(tmpdir(), "warden-enrollment-")));
  try {
    return await run(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

const total = (b: Baseline): number => Object.values(b).reduce((n, entries) => n + Object.values(entries).reduce((a, x) => a + x, 0), 0);

export async function compileEnrollment(dir: string, wardenRoot: string): Promise<{ gaps: number }> {
  const e = { ...readEnrollment(dir), dir };
  return withScratch(async (scratch) => {
    const { checkout, at } = await enrolledCheckout(e, scratch);
    await at(await commitAt(e.root, e.ref));
    const { findings, written } = await compile(checkout, wardenRoot);
    if (findings.length > 0) throw new Error(`warden compile reported ${findings.map((f) => `${f.code} ${f.record}: ${f.message}`).join("; ")}. Next action: fix ${join(dir, POLICY, "config.yaml")}, then run warden enroll compile again`);
    const outside = written.filter((file) => !file.startsWith(".warden/"));
    if (outside.length > 0) throw new Error(`warden compile wrote ${outside.join(", ")} outside .warden, which an enrollment cannot hold. Next action: disable the packs that generate those files in ${join(dir, POLICY, "config.yaml")}, then run warden enroll compile again`);
    rmSync(join(dir, POLICY), { recursive: true, force: true });
    cpSync(join(checkout, ".warden"), join(dir, POLICY), { recursive: true });
    return { gaps: total(JSON.parse(readFileSync(join(dir, BASELINE), "utf8")) as Baseline) };
  });
}

export interface Migration {
  dir: string;
  project: string;
  gaps: number;
  sourceGaps: number;
}

export async function migrateEnrollment(repo: string, ref: string, from: string, wardenRoot: string, data: string[], links: string[], initialBase?: string): Promise<Migration> {
  const root = realpathSync(repo);
  if (await git(root, ["rev-parse", "--show-toplevel"]) !== root) throw new Error(`${repo} is not the top of a Git checkout. Next action: pass the repository's root folder`);
  const commit = await commitAt(root, from);
  await commitAt(root, ref);
  const show = (path: string): Promise<Buffer> => exec("git", ["cat-file", "blob", `${commit}:${path}`], { cwd: root, env: gitEnv(), encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }).then((r) => r.stdout);
  const listed = (await git(root, ["ls-tree", "-r", "-z", "--name-only", commit])).split("\0").filter((file) => file !== "");
  const policy = listed.filter((file) => file.startsWith(".warden/"));
  if (!policy.includes(".warden/config.yaml")) throw new Error(`${commit} in ${root} has no .warden/config.yaml to migrate. Next action: pass --from a commit that holds the in-repo enrollment`);
  const config = parseConfig(".warden/config.yaml", (await show(".warden/config.yaml")).toString("utf8"));
  const dir = enrollmentDir(root, ref);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    return await writeMigration(dir, root, ref, commit, config.project, show, listed, policy, wardenRoot, data, links, initialBase);
  } catch (cause) {
    rmSync(dir, { recursive: true, force: true });
    throw cause;
  }
}

async function writeMigration(dir: string, root: string, ref: string, commit: string, project: string, show: (path: string) => Promise<Buffer>, listed: string[], policy: string[], wardenRoot: string, data: string[], links: string[], initialBase?: string): Promise<Migration> {
  const enrollment: Enrollment = { project, root, ref, data, links, ...(initialBase === undefined ? {} : { initialBase }) };
  writeFileSync(join(dir, "enrollment.json"), `${JSON.stringify(enrollment, null, 2)}\n`);
  const copy = async (path: string, to: string): Promise<void> => {
    mkdirSync(join(to, ".."), { recursive: true });
    writeFileSync(to, await show(path));
  };
  for (const file of policy) await copy(file, join(dir, POLICY, file.slice(".warden/".length)));
  for (const file of listed.filter((f) => data.some((glob) => matchesGlob(f, glob)))) await copy(file, join(dir, DATA, file));
  const sourceGaps = policy.includes(".warden/baseline.json") ? total(JSON.parse((await show(".warden/baseline.json")).toString("utf8")) as Baseline) : 0;
  const { gaps } = await compileEnrollment(dir, wardenRoot);
  if (gaps !== sourceGaps) throw new Error(`the enrolled baseline holds ${gaps} gaps, but ${commit}'s .warden/baseline.json holds ${sourceGaps}. Next action: report this to Warden's maintainers with ${dir}`);
  return { dir, project, gaps, sourceGaps };
}

const readCheckpoint = (file: string): Checkpoint => {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { tiers: {} };
    throw cause;
  }
  const checkpoint = JSON.parse(text) as Checkpoint;
  if (!checkpoint || !COMMIT.test(checkpoint.head ?? "") || !COMMIT.test(checkpoint.base ?? "") || !checkpoint.tiers ||
    (checkpoint.tampered !== undefined && typeof checkpoint.tampered !== "string") ||
    Object.entries(checkpoint.tiers).some(([tier, state]) => !TIERS.includes(tier as (typeof TIERS)[number]) ||
      !state || !COMMIT.test(state.base) || !COMMIT.test(state.commit) ||
      !Number.isFinite(state.at) || (state.completed !== undefined && !COMMIT.test(state.completed)))) {
    throw new Error(`Cannot read the enrolled audit checkpoint at ${file}. Next action: delete it so the next audit starts from the ref's current commit`);
  }
  return checkpoint;
};

interface AuditOptions {
  wardenRoot: string;
  executable?: string;
  signers?: string;
  signal?: AbortSignal;
  once?: boolean;
}

interface TierRun {
  e: EnrolledProject;
  commit: string;
  base: string;
  tier: (typeof TIERS)[number];
  checkout: string;
  snapshotBase: string;
  executable: string;
  auditHome: string;
  packs: string[];
  signal?: AbortSignal;
}

async function auditTier({ e, commit, base, tier, checkout, snapshotBase, executable, auditHome, packs, signal }: TierRun): Promise<boolean> {
  const at = new Date().toISOString();
  const start = performance.now();
  let exit = 0;
  let message: string | undefined;
  try {
    await exec(process.execPath, [executable, "audit", "--tier", tier, "--base", snapshotBase, "--format", "json"], {
      cwd: checkout,
      env: { ...gitEnv(), WARDEN_HOME: auditHome, GIT_ALLOW_PROTOCOL: "" },
      maxBuffer: 64 * 1024 * 1024,
      signal,
    });
  } catch (cause) {
    if (signal?.aborted === true) throw cause;
    const error = cause as { code?: unknown; stderr?: string; message: string };
    exit = typeof error.code === "number" ? error.code : 2;
    message = error.stderr?.trim() || error.message;
  }
  const path = join(auditHome, "evidence", `${e.project}.jsonl`);
  let entries: Record<string, unknown>[] = [];
  try {
    entries = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const summary = [...entries].reverse().find((entry) => entry.kind === "cost" && entry.guardrail === RUN_TOTAL && entry.tier === tier && typeof entry.at === "string" && entry.at >= at);
  if (summary === undefined && exit === 0) {
    exit = 2;
    message = `Warden produced no ${tier} receipt for ${commit}.`;
  }
  const fallback = { at, kind: "cost", guardrail: RUN_TOTAL, run: randomUUID(), tier, outcome: "error", exit, ms: performance.now() - start, files: 0, next: message };
  appendEvidence(e.project, {
    ...(summary ?? fallback),
    ...(exit !== 0 && summary?.exit !== exit ? { outcome: "error", exit } : {}),
    ...(message === undefined ? {} : { next: (summary?.next as string | undefined) ?? message }),
    root: e.root, ref: e.ref, commit, base, packs, trigger: TRIGGER,
  } as Parameters<typeof appendEvidence>[1]);
  return exit === 0 && summary !== undefined && (summary.outcome === "ran" || summary.outcome === "empty");
}

export function recordAuditFailure(e: EnrolledProject, message: string): void {
  const at = new Date().toISOString();
  for (const tier of TIERS) appendEvidence(e.project, { at, kind: "cost", guardrail: RUN_TOTAL, run: randomUUID(), tier, outcome: "error", exit: 2, ms: 0, files: 0, next: message, root: e.root, ref: e.ref, trigger: TRIGGER } as Parameters<typeof appendEvidence>[1]);
}

export async function auditEnrollment(enrolled: EnrolledProject, opts: AuditOptions): Promise<boolean> {
  const { signal, once = false } = opts;
  const e: EnrolledProject = { ...readEnrollment(enrolled.dir), dir: enrolled.dir };
  const commit = await commitAt(e.root, e.ref, signal);
  const path = join(e.dir, "checkpoint.json");
  const checkpoint = readCheckpoint(path);
  const prior = checkpoint.head;
  if (prior !== undefined && prior !== commit) {
    try {
      await git(e.root, ["merge-base", "--is-ancestor", prior, commit], signal);
    } catch (cause) {
      if ((cause as { code?: unknown }).code === 1) throw new Error(`${e.ref} no longer descends from ${prior}. Next action: verify the published history, then delete ${path} to resume automatic audits`);
      throw cause;
    }
  }
  const pending = TIERS.filter((tier) => {
    const state = checkpoint.tiers[tier];
    return state?.completed !== commit && (once || state?.commit !== commit || Date.now() - state.at >= RETRY_MS);
  });
  if (pending.length === 0) return true;
  if (checkpoint.base === undefined && e.initialBase !== undefined) await git(e.root, ["merge-base", "--is-ancestor", e.initialBase, commit], signal);
  checkpoint.head = commit;
  checkpoint.base ??= await commitAt(e.root, e.initialBase ?? `${commit}^`, signal);
  const tampered = enrollmentTampering(e.dir, opts.signers ?? join(opts.wardenRoot, TRUST_SIGNERS));
  if (tampered.length > 0) {
    const text = canonicalJson([commit, tampered]);
    for (const tier of pending) checkpoint.tiers[tier] = { ...checkpoint.tiers[tier], base: checkpoint.tiers[tier]?.completed ?? checkpoint.tiers[tier]?.base ?? checkpoint.base, commit, at: Date.now() };
    if (checkpoint.tampered !== text) {
      const at = new Date().toISOString();
      const next = `the enrolled policy in ${e.dir} differs from what its owner signed. Have the owner review it and run warden enroll sign ${e.root} --ref ${e.ref} --key <their trust key> in a terminal, or restore the signed files`;
      for (const t of tampered) appendEvidence(e.project, { at, kind: "tampered", file: t.file, detail: t.detail, ...(t.guardrail === undefined ? {} : { guardrail: t.guardrail }), root: e.root, ref: e.ref, commit, trigger: TRIGGER } as Parameters<typeof appendEvidence>[1]);
      for (const tier of pending) appendEvidence(e.project, { at, kind: "cost", guardrail: RUN_TOTAL, run: randomUUID(), tier, outcome: "tampered", exit: 0, ms: 0, files: 0, next, root: e.root, ref: e.ref, commit, base: checkpoint.tiers[tier]?.base, trigger: TRIGGER } as Parameters<typeof appendEvidence>[1]);
      checkpoint.tampered = text;
    }
    writeAtomic(path, `${JSON.stringify(checkpoint)}\n`);
    return false;
  }
  delete checkpoint.tampered;
  writeAtomic(path, `${JSON.stringify(checkpoint)}\n`);
  const config = parseConfig(join(e.dir, POLICY, "config.yaml"), readFileSync(join(e.dir, POLICY, "config.yaml"), "utf8"));
  if (config.project !== e.project) throw new Error(`${join(e.dir, POLICY, "config.yaml")} names project ${config.project}, but ${join(e.dir, "enrollment.json")} names ${e.project}. Next action: make them match, then run warden enroll sign again`);
  const packs = config.packs.filter((pack) => pack.enabled !== false).map((pack) => pack.id);
  return withScratch(async (scratch) => {
    const { checkout, at } = await enrolledCheckout(e, scratch, signal);
    let allCompleted = true;
    for (const tier of pending) {
      const previous = checkpoint.tiers[tier];
      const base = previous?.completed ?? previous?.base ?? (checkpoint.base as string);
      const state: TierState = { ...previous, base, commit, at: Date.now() };
      checkpoint.tiers[tier] = state;
      writeAtomic(path, `${JSON.stringify(checkpoint)}\n`);
      const snapshotted = await at(commit, base);
      const done = await auditTier({ e, commit, base, tier, checkout, snapshotBase: snapshotted.base as string, executable: opts.executable ?? join(opts.wardenRoot, "bin", "warden.js"), auditHome: join(scratch, `evidence-${tier}`), packs, signal });
      if (done) {
        state.completed = commit;
        writeAtomic(path, `${JSON.stringify(checkpoint)}\n`);
      }
      allCompleted = allCompleted && done;
    }
    return allCompleted;
  });
}
