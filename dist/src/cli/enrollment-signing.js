import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, readLockFile, sha256 } from "../compiler/lock.js";
import { ENROLLMENT_NAMESPACE, enrollmentManifest, writeEnrollmentSignature } from "../runner/enrollment.js";
import { wardenHome } from "../runner/evidence.js";
import { TRUST_SIGNERS, signedBy } from "../runner/trust.js";
import { PackSettingsError } from "./pack-settings.js";
import { requireOwnerKey } from "./trust.js";
const exec = promisify(execFile);
let prompting = false;
export const stagedEnrollmentDir = (entry) => join(wardenHome(), "staged-enrollments", basename(entry.dir));
const approvedParent = (entry) => join(wardenHome(), "approved-enrollments", basename(entry.dir));
export const approvedEnrollmentDir = (entry, revision) => join(approvedParent(entry), revision);
function validateDirectory(dir) {
    if (!lstatSync(dirname(dir)).isDirectory() || !lstatSync(dir).isDirectory() || readdirSync(dir, { recursive: true, withFileTypes: true })
        .some((file) => !file.isFile() && !file.isDirectory())) {
        throw new PackSettingsError(422, "Enrollment review requires regular files and directories.");
    }
}
function stagedPolicy(entry) {
    const dir = stagedEnrollmentDir(entry);
    if (!existsSync(dir))
        return undefined;
    validateDirectory(dir);
    const text = enrollmentManifest(dir);
    const staged = JSON.parse(text);
    const { project, root, ref } = staged.enrollment;
    if (project !== entry.project || root !== entry.root || ref !== entry.ref) {
        throw new PackSettingsError(409, "The staged policy belongs to a different project, checkout, or branch.");
    }
    return { dir, text, staged, revision: sha256(text) };
}
function diffEntries(current, proposed) {
    return [...new Set([...Object.keys(current), ...Object.keys(proposed)])].sort().flatMap((name) => {
        const before = Object.hasOwn(current, name) ? current[name] : undefined;
        const after = Object.hasOwn(proposed, name) ? proposed[name] : undefined;
        if (canonicalJson(before) === canonicalJson(after))
            return [];
        return [{ name, change: before === undefined ? "Added" : after === undefined ? "Removed" : "Changed", before, after }];
    });
}
function reviewedFile(dir, name, digest) {
    const file = join(dir, name);
    const bytes = readFileSync(file);
    if (sha256(bytes) !== digest) {
        throw new PackSettingsError(409, "The policy files changed during review. Reload the project's Checks tab.");
    }
    return isUtf8(bytes) ? { text: bytes.toString("utf8"), binary: false } : { text: bytes.toString("base64"), binary: true };
}
export function enrollmentReview(entry, wardenRoot) {
    const policy = stagedPolicy(entry);
    if (policy === undefined)
        return { ref: entry.ref, stage: null };
    const { dir, staged, text, revision } = policy;
    const approved = approvedEnrollmentDir(entry, revision);
    const signed = join(approved, "signed.json");
    const signature = `${signed}.sig`;
    const verified = existsSync(signed) && existsSync(signature) && readFileSync(signed, "utf8") === text &&
        signedBy(join(wardenRoot, TRUST_SIGNERS), ENROLLMENT_NAMESPACE, text, readFileSync(signature, "utf8")) &&
        enrollmentManifest(approved) === text;
    validateDirectory(entry.dir);
    const active = JSON.parse(enrollmentManifest(entry.dir));
    const lockName = "policy/lock.json";
    const rules = (directory, files) => readLockFile(join(directory, lockName), reviewedFile(directory, lockName, files[lockName] ?? "").text).guardrails;
    return { ref: entry.ref, stage: {
            revision, verified, canSign: process.platform === "darwin",
            settings: diffEntries(active.enrollment, staged.enrollment),
            rules: diffEntries(rules(entry.dir, active.files), rules(dir, staged.files)),
            files: diffEntries(active.files, staged.files).map(({ name, change, before, after }) => ({
                name, change,
                before: before === undefined ? undefined : reviewedFile(entry.dir, name, before),
                after: after === undefined ? undefined : reviewedFile(dir, name, after),
            })),
        } };
}
async function promptForSignature(text, key, entry, revision) {
    if (process.platform !== "darwin")
        throw new PackSettingsError(409, "The native signing prompt requires macOS.");
    const scratch = await mkdtemp(join(tmpdir(), "warden-sign-"));
    try {
        const message = join(scratch, "policy");
        const askpass = join(scratch, "askpass");
        await writeFile(message, text, { mode: 0o600 });
        const approval = join(scratch, "approval");
        await writeFile(askpass, `#!/bin/sh
/usr/bin/osascript - "$WARDEN_SIGN_PROJECT" "$WARDEN_SIGN_REF" "$WARDEN_SIGN_REVISION" <<'APPLESCRIPT'
on run argv
  set notice to "Sign the reviewed Warden policy for " & item 1 of argv & return & item 2 of argv & return & "Policy " & item 3 of argv
  set response to display dialog notice with title "Warden policy signing" default answer "" with hidden answer buttons {"Cancel", "Sign"} default button "Sign" cancel button "Cancel" giving up after 90
  if gave up of response then error number -128
  return text returned of response
end run
APPLESCRIPT
status=$?
[ "$status" -eq 0 ] || exit "$status"
: > "$WARDEN_SIGN_APPROVAL"
`, { mode: 0o700 });
        const env = { ...process.env };
        delete env.SSH_AUTH_SOCK;
        try {
            await exec("/usr/bin/ssh-keygen", ["-q", "-Y", "sign", "-f", key, "-n", ENROLLMENT_NAMESPACE, message], {
                env: { ...env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", WARDEN_SIGN_PROJECT: entry.project,
                    WARDEN_SIGN_REF: entry.ref, WARDEN_SIGN_REVISION: revision, WARDEN_SIGN_APPROVAL: approval },
                timeout: 100_000,
            });
        }
        catch {
            throw new PackSettingsError(409, "The signature was not created. Open the prompt again and unlock the owner key.");
        }
        if (!existsSync(approval))
            throw new PackSettingsError(409, "The native signing prompt did not approve this revision.");
        return await readFile(`${message}.sig`, "utf8");
    }
    finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
export async function signReviewedEnrollment(entry, wardenRoot, revision, sign = promptForSignature, key = join(homedir(), ".ssh", "warden_owner")) {
    const policy = stagedPolicy(entry);
    if (policy === undefined || policy.revision !== revision) {
        throw new PackSettingsError(409, "The staged policy changed. Review the current changes before signing.");
    }
    const review = enrollmentReview(entry, wardenRoot);
    if (review.stage === null || review.stage.revision !== revision) {
        throw new PackSettingsError(409, "The staged policy changed. Review the current changes before signing.");
    }
    if (review.stage.verified) {
        throw new PackSettingsError(409, "This policy revision already has a verified signature.");
    }
    if (prompting)
        throw new PackSettingsError(409, "Finish the open signing prompt before starting another.");
    const signers = join(wardenRoot, TRUST_SIGNERS);
    requireOwnerKey(key, signers, "open Policy signing again");
    prompting = true;
    let snapshot;
    try {
        const parent = approvedParent(entry);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        if (!lstatSync(dirname(parent)).isDirectory() || !lstatSync(parent).isDirectory()) {
            throw new PackSettingsError(422, "The approved enrollment store must be a local directory.");
        }
        snapshot = await mkdtemp(join(parent, ".pending-"));
        for (const name of ["enrollment.json", "policy", "data"]) {
            const source = join(policy.dir, name);
            if (existsSync(source))
                await cp(source, join(snapshot, name), { recursive: true });
        }
        validateDirectory(snapshot);
        if (enrollmentManifest(snapshot) !== policy.text) {
            throw new PackSettingsError(409, "The staged policy changed before signing. Review it again.");
        }
        const signature = await sign(policy.text, key, entry, policy.revision);
        if (stagedPolicy(entry)?.revision !== revision) {
            throw new PackSettingsError(409, "The staged policy changed while you were signing. Review it again.");
        }
        if (!signedBy(signers, ENROLLMENT_NAMESPACE, policy.text, signature)) {
            throw new PackSettingsError(409, "The signature does not match Warden's trusted owner key.");
        }
        writeEnrollmentSignature(snapshot, policy.text, signature);
        await rename(snapshot, approvedEnrollmentDir(entry, policy.revision));
        return { ...review, stage: { ...review.stage, verified: true } };
    }
    finally {
        prompting = false;
        if (snapshot !== undefined)
            await rm(snapshot, { recursive: true, force: true });
    }
}
