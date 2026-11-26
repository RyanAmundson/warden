import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wardenHome, writeAtomic } from "./evidence.js";

const TRUST_NAMESPACE = "warden-trust";

export const TRUST_SIGNERS = "trust_signers";

export const trustDir = (): string => join(wardenHome(), "daemon", "trust");

export interface Trust {
  repo: string;
  commit: string;
  reason: string;
  at: string;
  signature: string;
}

export interface TrustFile {
  file: string;
  text: string;
  record?: Trust;
}

const message = (t: Omit<Trust, "signature">): string => `${JSON.stringify({ repo: t.repo, commit: t.commit, reason: t.reason, at: t.at })}\n`;

export const keygen = (args: string[], input?: string): { status: number | null; stdout: string } => {
  const r = spawnSync("ssh-keygen", args, { input, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (r.error !== undefined) throw new Error(`ssh-keygen could not run, so trust signatures cannot be checked: ${r.error.message}. Next action: install OpenSSH so ssh-keygen is on PATH`);
  return { status: r.status, stdout: r.stdout };
};

const inTemp = <T>(run: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "warden-trust-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const signerLines = (signers: string): string[] =>
  existsSync(signers) ? readFileSync(signers, "utf8").split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#")) : [];

export function signedBy(signers: string, namespace: string, text: string, signature: string): boolean {
  return inTemp((dir) => {
    const sig = join(dir, "signed.sig");
    writeFileSync(sig, signature);
    const found = keygen(["-Y", "find-principals", "-s", sig, "-f", signers]);
    if (found.status !== 0) return false;
    return found.stdout.split("\n").filter((p) => p !== "").some((p) => keygen(["-Y", "verify", "-f", signers, "-I", p, "-n", namespace, "-s", sig], text).status === 0);
  });
}

export const signatureValid = (signers: string, t: Trust): boolean => signedBy(signers, TRUST_NAMESPACE, message(t), t.signature);

export function signText(key: string, namespace: string, text: string, again: string): string {
  return inTemp((dir) => {
    const file = join(dir, "signed");
    writeFileSync(file, text);
    const r = spawnSync("ssh-keygen", ["-q", "-Y", "sign", "-f", key, "-n", namespace, file], { stdio: ["inherit", "ignore", "inherit"] });
    if (r.error !== undefined || r.status !== 0) throw new Error(`ssh-keygen could not sign with ${key}${r.error === undefined ? "" : `: ${r.error.message}`}. Next action: ${again} in a terminal and enter the key's passphrase`);
    return readFileSync(`${file}.sig`, "utf8");
  });
}

export const signTrust = (key: string, t: Omit<Trust, "signature">): Trust => ({ ...t, signature: signText(key, TRUST_NAMESPACE, message(t), "run warden trust again") });

const trustFile = (t: Pick<Trust, "repo" | "commit">): string => join(trustDir(), `${createHash("sha256").update(t.repo).digest("hex").slice(0, 12)}-${t.commit}.json`);

export const writeTrust = (t: Trust): string => {
  const file = trustFile(t);
  writeAtomic(file, `${JSON.stringify(t, null, 2)}\n`);
  return file;
};

const isTrust = (v: unknown): v is Trust => {
  const t = v as Partial<Trust> | null;
  return typeof t === "object" && t !== null && [t.repo, t.commit, t.reason, t.at, t.signature].every((f) => typeof f === "string");
};

export function readTrustFiles(): TrustFile[] {
  const dir = trustDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const file = join(dir, name);
      const text = readFileSync(file, "utf8");
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        value = undefined;
      }
      return isTrust(value) ? { file, text, record: value } : { file, text };
    });
}
