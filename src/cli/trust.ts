import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commitOf, commonDir } from "../runner/changed.js";
import { TRUST_SIGNERS, keygen, signTrust, signatureValid, signerLines, writeTrust } from "../runner/trust.js";

const inAgent = (pub: string): boolean => {
  const blob = readFileSync(pub, "utf8").split(" ")[1];
  const listed = spawnSync("ssh-add", ["-L"], { encoding: "utf8" });
  return (listed.stdout ?? "").split("\n").some((line) => line.split(" ")[1] === blob);
};

export function runTrust(root: string, wardenRoot: string, commit: string, key: string, reason: string): number {
  const signers = join(wardenRoot, TRUST_SIGNERS);
  if (keygen(["-y", "-P", "", "-f", key]).status === 0) throw new Error(`${key} has no passphrase, so any process running as you could sign with it. Next action: run ssh-keygen -p -f ${key} to set one, then run warden trust again`);
  if (!existsSync(`${key}.pub`)) throw new Error(`${key}.pub is missing, so Warden cannot check whether ssh-agent holds the key. Next action: run ssh-keygen -y -f ${key} > ${key}.pub, then run warden trust again`);
  if (inAgent(`${key}.pub`)) throw new Error(`${key} is loaded in ssh-agent, so any process running as you could sign with it without the passphrase. Next action: run ssh-add -d ${key}.pub, then run warden trust again`);
  if (signerLines(signers).length === 0) throw new Error(`${signers} lists no owner key, so no trust can be signed. Next action: make a passphrase-protected key with ssh-keygen -t ed25519 -f ~/.ssh/warden_owner, never add it to ssh-agent, and add a line "<you> <public key>" for it to ${signers}`);
  const full = commitOf(root, commit);
  if (full === undefined) throw new Error(`${commit} is not a commit in ${root}. Next action: pass the full id the daemon's alert names`);
  const trust = signTrust(key, { repo: commonDir(root), commit: full, reason, at: new Date().toISOString() });
  if (!signatureValid(signers, trust)) throw new Error(`${key} is not an owner key in ${signers}, so the daemon would not honor this trust. Next action: sign with the key that ${signers} lists`);
  process.stdout.write(`Trusted ${trust.commit} for ${trust.repo} in ${writeTrust(trust)}. The daemon clears its alert at its next scan.\n`);
  return 0;
}
