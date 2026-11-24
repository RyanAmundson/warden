import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { commonDir } from "../runner/changed.js";
import { TRUST_SIGNERS, signTrust, signatureValid, signerLines, writeTrust } from "../runner/trust.js";
export function runTrust(root, wardenRoot, commit, key, reason) {
    const signers = join(wardenRoot, TRUST_SIGNERS);
    if (spawnSync("ssh-keygen", ["-y", "-P", "", "-f", key], { stdio: "ignore" }).status === 0)
        throw new Error(`${key} has no passphrase, so any process running as you could sign with it. Next action: run ssh-keygen -p -f ${key} to set one, then run warden trust again`);
    if (signerLines(signers).length === 0)
        throw new Error(`${signers} lists no owner key, so no trust can be signed. Next action: make a passphrase-protected key with ssh-keygen -t ed25519 -f ~/.ssh/warden_owner, never add it to ssh-agent, and add a line "<you> <public key>" for it to ${signers}`);
    const full = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], { cwd: root, encoding: "utf8" });
    if (full.status !== 0)
        throw new Error(`${commit} is not a commit in ${root}. Next action: pass the full id the daemon's alert names`);
    const trust = signTrust(key, { repo: commonDir(root), commit: full.stdout.trim(), reason, at: new Date().toISOString() });
    if (!signatureValid(signers, trust))
        throw new Error(`${key} is not an owner key in ${signers}, so the daemon would not honor this trust. Next action: sign with the key that ${signers} lists`);
    process.stdout.write(`Trusted ${trust.commit} for ${trust.repo} in ${writeTrust(trust)}. The daemon clears its alert at its next scan.\n`);
    return 0;
}
