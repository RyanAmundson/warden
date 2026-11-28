import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, readLockFile, sha256 } from "../compiler/lock.js";
import { ENROLLMENT_NAMESPACE, type EnrolledProject, enrollmentManifest, enrollmentPolicyDir, writeEnrollmentSignature } from "../runner/enrollment.js";
import { wardenHome } from "../runner/evidence.js";
import { TRUST_SIGNERS, signedBy } from "../runner/trust.js";
import { PackSettingsError } from "./pack-settings.js";
import { requireOwnerKey } from "./trust.js";

const exec = promisify(execFile);
let prompting = false;

export const stagedEnrollmentDir = (entry: EnrolledProject) => join(wardenHome(), "staged-enrollments", basename(entry.dir));

function stagedPolicy(entry: EnrolledProject) {
  const dir = stagedEnrollmentDir(entry);
  if (!existsSync(dir)) return undefined;
  if (!lstatSync(dirname(dir)).isDirectory() || !lstatSync(dir).isDirectory() || readdirSync(dir, { recursive: true, withFileTypes: true })
    .some((file) => !file.isFile() && !file.isDirectory())) {
    throw new PackSettingsError(422, "The staged enrollment must contain regular files and directories.");
  }
  const text = enrollmentManifest(dir);
  const staged = JSON.parse(text) as { enrollment: EnrolledProject; files: Record<string, string> };
  const { project, root, ref } = staged.enrollment;
  if (project !== entry.project || root !== entry.root || ref !== entry.ref) {
    throw new PackSettingsError(409, "The staged policy belongs to a different project, checkout, or branch.");
  }
  return { dir, text, staged, revision: sha256(text) };
}

function diffEntries<T>(current: Record<string, T>, proposed: Record<string, T>) {
  return [...new Set([...Object.keys(current), ...Object.keys(proposed)])].sort().flatMap((name) => {
    if (!Object.hasOwn(current, name)) return [{ name, change: "Added" }];
    if (!Object.hasOwn(proposed, name)) return [{ name, change: "Removed" }];
    return canonicalJson(current[name]) === canonicalJson(proposed[name]) ? [] : [{ name, change: "Changed" }];
  });
}

export function enrollmentReview(entry: EnrolledProject, wardenRoot: string) {
  const policy = stagedPolicy(entry);
  if (policy === undefined) return { ref: entry.ref, stage: null };
  const { dir, staged, text, revision } = policy;
  const signed = join(dir, "signed.json");
  const signature = `${signed}.sig`;
  const verified = existsSync(signed) && existsSync(signature) && readFileSync(signed, "utf8") === text &&
    signedBy(join(wardenRoot, TRUST_SIGNERS), ENROLLMENT_NAMESPACE, text, readFileSync(signature, "utf8"));
  const active = JSON.parse(enrollmentManifest(entry.dir)) as typeof staged;
  return { ref: entry.ref, stage: {
    revision, verified, canSign: process.platform === "darwin",
    rules: diffEntries(readLockFile(join(enrollmentPolicyDir(entry.dir), "lock.json")).guardrails,
      readLockFile(join(enrollmentPolicyDir(dir), "lock.json")).guardrails),
    files: diffEntries(active.files, staged.files),
  } };
}

async function promptForSignature(text: string, key: string, entry: EnrolledProject, revision: string): Promise<string> {
  if (process.platform !== "darwin") throw new PackSettingsError(409, "The native signing prompt requires macOS.");
  const scratch = await mkdtemp(join(tmpdir(), "warden-sign-"));
  try {
    const message = join(scratch, "policy");
    const askpass = join(scratch, "askpass");
    await writeFile(message, text, { mode: 0o600 });
    await writeFile(askpass, `#!/bin/sh
exec /usr/bin/osascript - "$WARDEN_SIGN_PROJECT" "$WARDEN_SIGN_REF" "$WARDEN_SIGN_REVISION" <<'APPLESCRIPT'
on run argv
  set notice to "Sign the reviewed Warden policy for " & item 1 of argv & return & item 2 of argv & return & "Policy " & item 3 of argv
  return text returned of (display dialog notice with title "Warden policy signing" default answer "" with hidden answer buttons {"Cancel", "Sign"} default button "Sign" cancel button "Cancel" giving up after 90)
end run
APPLESCRIPT
`, { mode: 0o700 });
    try {
      await exec("/usr/bin/ssh-keygen", ["-q", "-Y", "sign", "-f", key, "-n", ENROLLMENT_NAMESPACE, message], {
        env: { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", WARDEN_SIGN_PROJECT: entry.project,
          WARDEN_SIGN_REF: entry.ref, WARDEN_SIGN_REVISION: revision },
        timeout: 100_000,
      });
    } catch {
      throw new PackSettingsError(409, "The signature was not created. Open the prompt again and unlock the owner key.");
    }
    return await readFile(`${message}.sig`, "utf8");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function signReviewedEnrollment(entry: EnrolledProject, wardenRoot: string, revision: unknown,
  sign = promptForSignature, key = join(homedir(), ".ssh", "warden_owner")) {
  const policy = stagedPolicy(entry);
  if (policy === undefined || policy.revision !== revision) {
    throw new PackSettingsError(409, "The staged policy changed. Review the current changes before signing.");
  }
  enrollmentReview(entry, wardenRoot);
  if (prompting) throw new PackSettingsError(409, "Finish the open signing prompt before starting another.");
  const signers = join(wardenRoot, TRUST_SIGNERS);
  requireOwnerKey(key, signers, "open Review and sign again");
  prompting = true;
  try {
    const signature = await sign(policy.text, key, entry, policy.revision);
    if (stagedPolicy(entry)?.revision !== revision) {
      throw new PackSettingsError(409, "The staged policy changed while you were signing. Review it again.");
    }
    if (!signedBy(signers, ENROLLMENT_NAMESPACE, policy.text, signature)) {
      throw new PackSettingsError(409, "The signature does not match Warden's trusted owner key.");
    }
    writeEnrollmentSignature(policy.dir, policy.text, signature);
    return enrollmentReview(entry, wardenRoot);
  } finally {
    prompting = false;
  }
}
