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
import { RUN_TOTAL, appendEvidence, wardenHome, writeAtomic } from "./evidence.js";
import { TRUST_SIGNERS, signText, signedBy } from "./trust.js";
const exec = promisify(execFile);
export const ENROLLMENT_NAMESPACE = "warden-enrollment";
const TIERS = ["edit", "boundary"];
const RETRY_MS = 60_000;
const TRIGGER = "main audit";
const POLICY = "policy";
export const enrollmentPolicyDir = (dir) => join(dir, POLICY);
const DATA = "data";
const SIGNED = "signed.json";
const BASELINE = `${POLICY}/baseline.json`;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const gitEnv = () => {
    const env = { ...process.env, GIT_ALLOW_PROTOCOL: "file", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" };
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"])
        delete env[name];
    return env;
};
const SNAPSHOT_IDENTITY = {
    GIT_AUTHOR_NAME: "Warden", GIT_AUTHOR_EMAIL: "warden@localhost", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Warden", GIT_COMMITTER_EMAIL: "warden@localhost", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};
const git = async (cwd, args, signal, env = {}) => (await exec("git", args, { cwd, signal, env: { ...gitEnv(), ...env }, maxBuffer: 256 * 1024 * 1024 })).stdout.trim();
const commitAt = (root, ref, signal) => git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], signal);
export const enrollmentsDir = () => join(wardenHome(), "enrollments");
export const enrollmentDir = (root, ref) => join(enrollmentsDir(), sha256(`${root}\0${ref}`).slice(0, 16));
const relativePath = (path) => typeof path === "string" && path !== "" && !isAbsolute(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const readEnrollment = (dir) => {
    const file = join(dir, "enrollment.json");
    let value;
    try {
        value = JSON.parse(readFileSync(file, "utf8"));
    }
    catch (cause) {
        throw new RecordError(file, "", `cannot be read: ${cause.message}. Next action: run warden enroll migrate again for this repository and ref`);
    }
    if (value === null || typeof value !== "object" ||
        typeof value.project !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.project) ||
        typeof value.root !== "string" || !isAbsolute(value.root) ||
        typeof value.ref !== "string" || !value.ref.startsWith("refs/") ||
        !Array.isArray(value.data) || !value.data.every((glob) => typeof glob === "string" && glob !== "" && !isAbsolute(glob)) ||
        !Array.isArray(value.links) || !value.links.every(relativePath) ||
        (value.reportAdapters !== undefined && (!Array.isArray(value.reportAdapters) ||
            new Set(value.reportAdapters).size !== value.reportAdapters.length ||
            !value.reportAdapters.every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(id) && id !== "eslint"))) ||
        (value.initialBase !== undefined && (typeof value.initialBase !== "string" || !COMMIT.test(value.initialBase)))) {
        throw new RecordError(file, "", "needs a project ID, an absolute repository path, a full ref, data globs, relative links, optional unique report adapter IDs, and an optional full initialBase commit. Next action: run warden enroll migrate again for this repository and ref");
    }
    return value;
};
export function readEnrollments() {
    const dir = enrollmentsDir();
    const projects = new Map();
    if (!existsSync(dir))
        return projects;
    for (const name of readdirSync(dir).sort()) {
        const enrolled = join(dir, name);
        if (!existsSync(join(enrolled, "enrollment.json")))
            continue;
        const enrollment = readEnrollment(enrolled);
        if (projects.has(enrollment.project)) {
            throw new RecordError(join(enrolled, "enrollment.json"), "/project", `project ${enrollment.project} is enrolled twice. Next action: delete one of the two enrollment folders under ${dir}`);
        }
        projects.set(enrollment.project, { ...enrollment, dir: enrolled });
    }
    return projects;
}
const filesUnder = (dir, prefix) => {
    if (!existsSync(join(dir, prefix)))
        return [];
    return readdirSync(join(dir, prefix), { recursive: true, withFileTypes: true }).flatMap((entry) => {
        const path = join(entry.parentPath, entry.name).slice(dir.length + 1);
        if (entry.isSymbolicLink())
            throw new RecordError(join(dir, path), "", "is a symbolic link, which an enrollment cannot hold. Next action: replace it with the file it points to");
        return entry.isFile() ? [path] : [];
    });
};
const manifestOf = (dir) => {
    const files = [...filesUnder(dir, POLICY), ...filesUnder(dir, DATA)].sort();
    const baseline = existsSync(join(dir, BASELINE)) ? JSON.parse(readFileSync(join(dir, BASELINE), "utf8")) : {};
    return { enrollment: readEnrollment(dir), files: Object.fromEntries(files.map((file) => [file, sha256(readFileSync(join(dir, file)))])), baseline };
};
const manifestText = (dir) => `${canonicalJson(manifestOf(dir))}\n`;
export function signEnrollment(dir, key) {
    const text = manifestText(dir);
    const signature = signText(key, ENROLLMENT_NAMESPACE, text, "run warden enroll sign again");
    writeAtomic(join(dir, SIGNED), text);
    writeAtomic(join(dir, `${SIGNED}.sig`), signature);
}
export function enrollmentTampering(dir, signers) {
    const text = existsSync(join(dir, SIGNED)) ? readFileSync(join(dir, SIGNED), "utf8") : undefined;
    const signature = existsSync(join(dir, `${SIGNED}.sig`)) ? readFileSync(join(dir, `${SIGNED}.sig`), "utf8") : undefined;
    if (text === undefined || signature === undefined)
        return [{ file: join(dir, SIGNED), detail: "unsigned" }];
    if (!signedBy(signers, ENROLLMENT_NAMESPACE, text, signature))
        return [{ file: join(dir, `${SIGNED}.sig`), detail: "untrusted-signature" }];
    const signed = JSON.parse(text);
    const now = manifestOf(dir);
    const found = [];
    if (canonicalJson(signed.enrollment) !== canonicalJson(now.enrollment))
        found.push({ file: join(dir, "enrollment.json"), detail: "changed" });
    for (const file of [...new Set([...Object.keys(signed.files), ...Object.keys(now.files)])].sort()) {
        if (file === BASELINE)
            continue;
        const was = signed.files[file];
        const is = now.files[file];
        if (was !== is)
            found.push({ file: join(dir, file), detail: was === undefined ? "added" : is === undefined ? "removed" : "changed" });
    }
    for (const [guardrail, entries] of Object.entries(now.baseline)) {
        if (Object.entries(entries).some(([file, n]) => n > (signed.baseline[guardrail]?.[file] ?? 0)))
            found.push({ file: join(dir, BASELINE), detail: "loosened", guardrail });
    }
    return found;
}
const overlay = (dir, target) => {
    cpSync(enrollmentPolicyDir(dir), join(target, ".warden"), { recursive: true });
    if (existsSync(join(dir, DATA)))
        cpSync(join(dir, DATA), target, { recursive: true });
};
async function snapshot(checkout, e, staging, commit, parent, signal) {
    const env = { GIT_INDEX_FILE: join(checkout, ".git", "warden-snapshot-index") };
    await git(checkout, ["read-tree", commit], signal, env);
    const listed = (await git(checkout, ["ls-files", "-z"], signal, env)).split("\0").filter((file) => file !== "");
    const ignoreCase = ignoresPathCase(checkout);
    const keyOf = (path) => pathCaseKey(path, ignoreCase);
    const globs = e.data.map(keyOf);
    const stripped = listed.filter((file) => {
        const key = keyOf(file);
        return key === ".warden" || key.startsWith(".warden/") || globs.some((glob) => matchesGlob(key, glob));
    });
    for (let i = 0; i < stripped.length; i += 500)
        await git(checkout, ["update-index", "--force-remove", "--", ...stripped.slice(i, i + 500)], signal, env);
    await git(checkout, ["--work-tree", staging, "add", "--force", "--ignore-removal", "--", "."], signal, env);
    const tree = await git(checkout, ["write-tree"], signal, env);
    return git(checkout, ["commit-tree", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", `Warden audit snapshot of ${commit}`], signal, SNAPSHOT_IDENTITY);
}
async function enrolledCheckout(e, scratch, signal) {
    const checkout = join(scratch, "checkout");
    const staging = join(scratch, "staging");
    mkdirSync(staging);
    overlay(e.dir, staging);
    const format = await git(e.root, ["rev-parse", "--show-object-format"], signal);
    await git(scratch, ["init", "--quiet", "--object-format", format, "--", checkout], signal);
    const objects = join(await git(e.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal), "objects");
    writeFileSync(join(checkout, ".git", "objects", "info", "alternates"), `${objects}\n`);
    const at = async (commit, base) => {
        const parent = base === undefined ? undefined : await snapshot(checkout, e, staging, base, undefined, signal);
        const head = await snapshot(checkout, e, staging, commit, parent, signal);
        await git(checkout, ["checkout", "--quiet", "--force", "--detach", head], signal);
        for (const link of e.links) {
            const target = join(e.root, link);
            if (existsSync(target) && !existsSync(join(checkout, link)))
                symlinkSync(target, join(checkout, link));
        }
        return { head, ...(parent === undefined ? {} : { base: parent }) };
    };
    return { checkout, at };
}
const withScratch = async (run) => {
    const scratch = realpathSync(await mkdtemp(join(tmpdir(), "warden-enrollment-")));
    try {
        return await run(scratch);
    }
    finally {
        await rm(scratch, { recursive: true, force: true });
    }
};
const total = (b) => Object.values(b).reduce((n, entries) => n + Object.values(entries).reduce((a, x) => a + x, 0), 0);
export async function compileEnrollment(dir, wardenRoot) {
    const e = { ...readEnrollment(dir), dir };
    return withScratch(async (scratch) => {
        const { checkout, at } = await enrolledCheckout(e, scratch);
        await at(await commitAt(e.root, e.ref));
        const { findings, written } = await compile(checkout, wardenRoot);
        if (findings.length > 0)
            throw new Error(`warden compile reported ${findings.map((f) => `${f.code} ${f.record}: ${f.message}`).join("; ")}. Next action: fix ${join(dir, POLICY, "config.yaml")}, then run warden enroll compile again`);
        const outside = written.filter((file) => !file.startsWith(".warden/"));
        if (outside.length > 0)
            throw new Error(`warden compile wrote ${outside.join(", ")} outside .warden, which an enrollment cannot hold. Next action: disable the packs that generate those files in ${join(dir, POLICY, "config.yaml")}, then run warden enroll compile again`);
        rmSync(join(dir, POLICY), { recursive: true, force: true });
        cpSync(join(checkout, ".warden"), join(dir, POLICY), { recursive: true });
        return { gaps: total(JSON.parse(readFileSync(join(dir, BASELINE), "utf8"))) };
    });
}
export async function migrateEnrollment(repo, ref, from, wardenRoot, data, links, initialBase) {
    const root = realpathSync(repo);
    if (await git(root, ["rev-parse", "--show-toplevel"]) !== root)
        throw new Error(`${repo} is not the top of a Git checkout. Next action: pass the repository's root folder`);
    const commit = await commitAt(root, from);
    await commitAt(root, ref);
    const show = (path) => exec("git", ["cat-file", "blob", `${commit}:${path}`], { cwd: root, env: gitEnv(), encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }).then((r) => r.stdout);
    const listed = (await git(root, ["ls-tree", "-r", "-z", "--name-only", commit])).split("\0").filter((file) => file !== "");
    const policy = listed.filter((file) => file.startsWith(".warden/"));
    if (!policy.includes(".warden/config.yaml"))
        throw new Error(`${commit} in ${root} has no .warden/config.yaml to migrate. Next action: pass --from a commit that holds the in-repo enrollment`);
    const config = parseConfig(".warden/config.yaml", (await show(".warden/config.yaml")).toString("utf8"));
    const dir = enrollmentDir(root, ref);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
        return await writeMigration(dir, root, ref, commit, config.project, show, listed, policy, wardenRoot, data, links, initialBase);
    }
    catch (cause) {
        rmSync(dir, { recursive: true, force: true });
        throw cause;
    }
}
async function writeMigration(dir, root, ref, commit, project, show, listed, policy, wardenRoot, data, links, initialBase) {
    const enrollment = { project, root, ref, data, links, ...(initialBase === undefined ? {} : { initialBase }) };
    writeFileSync(join(dir, "enrollment.json"), `${JSON.stringify(enrollment, null, 2)}\n`);
    const copy = async (path, to) => {
        mkdirSync(join(to, ".."), { recursive: true });
        writeFileSync(to, await show(path));
    };
    for (const file of policy)
        await copy(file, join(dir, POLICY, file.slice(".warden/".length)));
    for (const file of listed.filter((f) => data.some((glob) => matchesGlob(f, glob))))
        await copy(file, join(dir, DATA, file));
    const sourceGaps = policy.includes(".warden/baseline.json") ? total(JSON.parse((await show(".warden/baseline.json")).toString("utf8"))) : 0;
    const { gaps } = await compileEnrollment(dir, wardenRoot);
    if (gaps !== sourceGaps)
        throw new Error(`the enrolled baseline holds ${gaps} gaps, but ${commit}'s .warden/baseline.json holds ${sourceGaps}. Next action: report this to Warden's maintainers with ${dir}`);
    return { dir, project, gaps, sourceGaps };
}
const readCheckpoint = (file) => {
    let text;
    try {
        text = readFileSync(file, "utf8");
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return { tiers: {} };
        throw cause;
    }
    const checkpoint = JSON.parse(text);
    if (!checkpoint || !COMMIT.test(checkpoint.head ?? "") || !COMMIT.test(checkpoint.base ?? "") || !checkpoint.tiers ||
        (checkpoint.tampered !== undefined && typeof checkpoint.tampered !== "string") ||
        Object.entries(checkpoint.tiers).some(([tier, state]) => !TIERS.includes(tier) ||
            !state || !COMMIT.test(state.base) || !COMMIT.test(state.commit) ||
            !Number.isFinite(state.at) || (state.completed !== undefined && !COMMIT.test(state.completed)))) {
        throw new Error(`Cannot read the enrolled audit checkpoint at ${file}. Next action: delete it so the next audit starts from the ref's current commit`);
    }
    return checkpoint;
};
async function runEnrolledTier({ e, commit, base, tier, checkout, snapshotBase, executable, auditHome, packs, signal, rule }) {
    const at = new Date().toISOString();
    const start = performance.now();
    let exit = 0;
    let message;
    try {
        await exec(process.execPath, [executable, "audit", "--tier", tier, "--base", snapshotBase, "--format", "json", ...(rule === undefined ? [] : ["--rule", rule])], {
            cwd: checkout,
            env: { ...gitEnv(), WARDEN_HOME: auditHome, GIT_ALLOW_PROTOCOL: "" },
            maxBuffer: 64 * 1024 * 1024,
            signal,
        });
    }
    catch (cause) {
        if (signal?.aborted === true)
            throw cause;
        const error = cause;
        exit = typeof error.code === "number" ? error.code : 2;
        message = error.stderr?.trim() || error.message;
    }
    const path = join(auditHome, "evidence", `${e.project}.jsonl`);
    let entries = [];
    try {
        entries = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    }
    catch (cause) {
        if (cause.code !== "ENOENT")
            throw cause;
    }
    const summary = [...entries].reverse().find((entry) => entry.kind === "cost" && entry.guardrail === RUN_TOTAL && entry.tier === tier && typeof entry.at === "string" && entry.at >= at);
    if (summary === undefined && exit === 0) {
        exit = 2;
        message = `Warden produced no ${tier} receipt for ${commit}.`;
    }
    const fallback = { at, kind: "cost", guardrail: RUN_TOTAL, run: randomUUID(), tier, outcome: "error", exit, ms: performance.now() - start, files: 0, next: message };
    return {
        ...(summary ?? fallback),
        ...(exit !== 0 && summary?.exit !== exit ? { outcome: "error", exit } : {}),
        ...(message === undefined ? {} : { next: summary?.next ?? message }),
        root: e.root, ref: e.ref, commit, base, packs, trigger: TRIGGER,
    };
}
export async function checkCandidate(project, checkout, ref, base, candidate, rule, opts) {
    const summary = { version: 1, project, ref, base, candidate, rule };
    const { signal } = opts;
    try {
        if (!COMMIT.test(base) || !COMMIT.test(candidate) || base.length !== candidate.length || base === candidate) {
            throw new Error("Supply distinct full base and candidate commit IDs.");
        }
        const worktrees = await git(checkout, ["worktree", "list", "--porcelain", "-z"], signal);
        const enrolled = worktrees.split("\0")
            .filter((field) => field.startsWith("worktree "))
            .map((field) => enrollmentDir(field.slice("worktree ".length), ref))
            .filter((dir) => existsSync(join(dir, "enrollment.json")));
        const [enrollment, alternate] = enrolled;
        if (enrollment === undefined || alternate !== undefined) {
            throw new Error(`Expected one signed enrollment for ${project} at ${ref}, found ${enrolled.length}.`);
        }
        return await withScratch(async (scratch) => {
            const dir = join(scratch, "enrollment");
            cpSync(enrollment, dir, { recursive: true });
            const invalid = enrollmentTampering(dir, opts.signers ?? join(opts.wardenRoot, TRUST_SIGNERS))[0];
            if (invalid !== undefined)
                throw new Error(`Invalid enrollment: ${invalid.detail} (${invalid.file}).`);
            const e = { ...readEnrollment(dir), dir };
            if (e.project !== project || e.ref !== ref)
                throw new Error("The signed enrollment names a different project or ref.");
            const common = (root) => git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal);
            if (realpathSync(await common(checkout)) !== realpathSync(await common(e.root))) {
                throw new Error("The candidate checkout does not share the enrolled repository's Git objects.");
            }
            if (await commitAt(checkout, base, signal) !== base || await commitAt(checkout, candidate, signal) !== candidate) {
                throw new Error("The base and candidate must both name commits.");
            }
            await git(checkout, ["merge-base", "--is-ancestor", base, candidate], signal);
            const config = parseConfig(join(dir, POLICY, "config.yaml"), readFileSync(join(dir, POLICY, "config.yaml"), "utf8"));
            if (config.project !== project)
                throw new Error("The signed policy names a different project.");
            const packs = config.packs.filter((pack) => pack.enabled !== false).map((pack) => pack.id);
            const isolated = await enrolledCheckout(e, scratch, signal);
            const { base: snapshotBase } = await isolated.at(candidate, base);
            if (snapshotBase === undefined)
                throw new Error("Warden could not read the base snapshot.");
            const receipt = await runEnrolledTier({
                e, commit: candidate, base, tier: "boundary", checkout: isolated.checkout, snapshotBase,
                executable: opts.executable ?? join(opts.wardenRoot, "bin", "warden.js"),
                auditHome: join(scratch, "evidence"), packs, signal, rule,
            });
            if (receipt.exit === 0 && receipt.outcome === "ran" && Object.hasOwn(receipt.rules ?? {}, rule) &&
                (receipt.result === "pass" || receipt.result === "fail")) {
                return { ...summary, result: receipt.result, findings: receipt.failures, message: receipt.next };
            }
            return { ...summary, result: "error", message: receipt.next ?? `No completed result for ${rule}.` };
        });
    }
    catch (cause) {
        return { ...summary, result: "error", message: cause.message };
    }
}
export function recordAuditFailure(e, message) {
    const at = new Date().toISOString();
    for (const tier of TIERS)
        appendEvidence(e.project, { at, kind: "cost", guardrail: RUN_TOTAL, run: randomUUID(), tier, outcome: "error", exit: 2, ms: 0, files: 0, next: message, root: e.root, ref: e.ref, trigger: TRIGGER });
}
export async function auditEnrollment(enrolled, opts) {
    const { signal, once = false } = opts;
    const e = { ...readEnrollment(enrolled.dir), dir: enrolled.dir };
    const commit = await commitAt(e.root, e.ref, signal);
    const path = join(e.dir, "checkpoint.json");
    const checkpoint = readCheckpoint(path);
    const prior = checkpoint.head;
    if (prior !== undefined && prior !== commit) {
        try {
            await git(e.root, ["merge-base", "--is-ancestor", prior, commit], signal);
        }
        catch (cause) {
            if (cause.code === 1)
                throw new Error(`${e.ref} no longer descends from ${prior}. Next action: verify the published history, then delete ${path} to resume automatic audits`);
            throw cause;
        }
    }
    const pending = TIERS.filter((tier) => {
        const state = checkpoint.tiers[tier];
        return state?.completed !== commit && (once || state?.commit !== commit || Date.now() - state.at >= RETRY_MS);
    });
    if (pending.length === 0)
        return true;
    if (checkpoint.base === undefined && e.initialBase !== undefined)
        await git(e.root, ["merge-base", "--is-ancestor", e.initialBase, commit], signal);
    checkpoint.head = commit;
    checkpoint.base ??= await commitAt(e.root, e.initialBase ?? `${commit}^`, signal);
    const tampered = enrollmentTampering(e.dir, opts.signers ?? join(opts.wardenRoot, TRUST_SIGNERS));
    if (tampered.length > 0) {
        const text = canonicalJson([commit, tampered]);
        for (const tier of pending)
            checkpoint.tiers[tier] = { ...checkpoint.tiers[tier], base: checkpoint.tiers[tier]?.completed ?? checkpoint.tiers[tier]?.base ?? checkpoint.base, commit, at: Date.now() };
        if (checkpoint.tampered !== text) {
            const at = new Date().toISOString();
            const next = `the enrolled policy in ${e.dir} differs from what its owner signed. Have the owner review it and run warden enroll sign ${e.root} --ref ${e.ref} --key <their trust key> in a terminal, or restore the signed files`;
            for (const t of tampered)
                appendEvidence(e.project, { at, kind: "tampered", file: t.file, detail: t.detail, ...(t.guardrail === undefined ? {} : { guardrail: t.guardrail }), root: e.root, ref: e.ref, commit, trigger: TRIGGER });
            for (const tier of pending)
                appendEvidence(e.project, { at, kind: "cost", guardrail: RUN_TOTAL, run: randomUUID(), tier, outcome: "tampered", exit: 0, ms: 0, files: 0, next, root: e.root, ref: e.ref, commit, base: checkpoint.tiers[tier]?.base, trigger: TRIGGER });
            checkpoint.tampered = text;
        }
        writeAtomic(path, `${JSON.stringify(checkpoint)}\n`);
        return false;
    }
    delete checkpoint.tampered;
    writeAtomic(path, `${JSON.stringify(checkpoint)}\n`);
    const config = parseConfig(join(e.dir, POLICY, "config.yaml"), readFileSync(join(e.dir, POLICY, "config.yaml"), "utf8"));
    if (config.project !== e.project)
        throw new Error(`${join(e.dir, POLICY, "config.yaml")} names project ${config.project}, but ${join(e.dir, "enrollment.json")} names ${e.project}. Next action: make them match, then run warden enroll sign again`);
    const packs = config.packs.filter((pack) => pack.enabled !== false).map((pack) => pack.id);
    return withScratch(async (scratch) => {
        const { checkout, at } = await enrolledCheckout(e, scratch, signal);
        let allCompleted = true;
        for (const tier of pending) {
            const previous = checkpoint.tiers[tier];
            const base = previous?.completed ?? previous?.base ?? checkpoint.base;
            const state = { ...previous, base, commit, at: Date.now() };
            checkpoint.tiers[tier] = state;
            writeAtomic(path, `${JSON.stringify(checkpoint)}\n`);
            const snapshotted = await at(commit, base);
            const receipt = await runEnrolledTier({ e, commit, base, tier, checkout, snapshotBase: snapshotted.base, executable: opts.executable ?? join(opts.wardenRoot, "bin", "warden.js"), auditHome: join(scratch, `evidence-${tier}`), packs, signal });
            appendEvidence(e.project, receipt);
            const done = receipt.exit === 0 && (receipt.outcome === "ran" || receipt.outcome === "empty");
            if (done) {
                state.completed = commit;
                writeAtomic(path, `${JSON.stringify(checkpoint)}\n`);
            }
            allCompleted = allCompleted && done;
        }
        return allCompleted;
    });
}
