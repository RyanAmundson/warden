const NEVER_BLOCK = new Set(["check", "audit", "guard", "session-end"]);
const VERDICT = /Warden reported problems \(verdict (\d+)\) and exits 0, because Warden never blocks work\.\n/;

export const verdictOf = (args: string[], r: { status: number | null; stdout: string; stderr: string }): { code: number | null; out: string; err: string } => {
  if (!NEVER_BLOCK.has(args[0] ?? "")) return { code: r.status, out: r.stdout, err: r.stderr };
  if (r.status !== 0) throw new Error(`warden ${args.join(" ")} exited ${String(r.status)}, but Warden never blocks: ${r.stderr}`);
  const found = r.stderr.match(VERDICT);
  return { code: found === null ? 0 : Number(found[1]), out: r.stdout, err: r.stderr.replace(VERDICT, "") };
};

export const withVerdict = <R extends { status: number | null; stdout: string; stderr: string }>(args: string[], r: R): R => {
  const { code, err } = verdictOf(args, r);
  return { ...r, status: code, stderr: err };
};
