import { realpathSync } from "node:fs";
import { join } from "node:path";
import { compileEnrollment, enrollmentDir, enrollmentTampering, migrateEnrollment, signEnrollment } from "../runner/enrollment.js";
import { TRUST_SIGNERS } from "../runner/trust.js";
import { requireOwnerKey } from "./trust.js";
const sign = (repo, ref) => `warden enroll sign ${repo} --ref ${ref} --key <your trust key>`;
export async function runEnrollMigrate(repo, ref, from, wardenRoot, data, links, initialBase) {
    const m = await migrateEnrollment(repo, ref, from ?? ref, wardenRoot, data, links, initialBase);
    process.stdout.write(`Enrolled ${m.project} in ${m.dir}. Its baseline holds ${m.gaps} gaps, the same as the repository's .warden/baseline.json. Next action: review the enrollment, then run ${sign(realpathSync(repo), ref)} in a terminal.\n`);
    return 0;
}
export async function runEnrollCompile(repo, ref, wardenRoot) {
    const root = realpathSync(repo);
    const dir = enrollmentDir(root, ref);
    const { gaps } = await compileEnrollment(dir, wardenRoot);
    process.stdout.write(`Compiled the enrolled policy in ${dir}. Its baseline holds ${gaps} gaps. Next action: review the change, then run ${sign(root, ref)} in a terminal.\n`);
    return 0;
}
export function runEnrollSign(repo, ref, key, wardenRoot) {
    const root = realpathSync(repo);
    const dir = enrollmentDir(root, ref);
    const signers = join(wardenRoot, TRUST_SIGNERS);
    requireOwnerKey(key, signers, "run warden enroll sign again");
    signEnrollment(dir, key);
    if (enrollmentTampering(dir, signers).length > 0)
        throw new Error(`${key} is not an owner key in ${signers}, so the daemon would not honor this enrollment. Next action: sign with the key that ${signers} lists`);
    process.stdout.write(`Signed the enrollment in ${dir}. The daemon uses it at its next scan; restart the daemon if this enrollment is new.\n`);
    return 0;
}
