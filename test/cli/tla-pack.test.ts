import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const entry = resolve(import.meta.dirname, "../../packs/tla/check.js");
const model = "protocol/Token";

type Interpreter = (model: string, result: { status: number; stdout: string; stderr: string }) => { code: number; message?: string };

const simulate = async () => {
  const { interpretTlc } = await import(entry) as { interpretTlc: Interpreter };
  return (status: number, stdout: string) => interpretTlc(model, { status, stdout, stderr: "" });
};

const message = (code: number, severity: number, text: string) =>
  `@!@!@STARTMSG ${code}:${severity} @!@!@\n${text}\n@!@!@ENDMSG ${code} @!@!@\n`;

it("reports a missing TLC installation as a setup error", () => {
  const { WARDEN_TLC_JAR: _jar, ...env } = process.env;
  const result = spawnSync(process.execPath, [entry], {
    cwd: import.meta.dirname,
    env: { ...env, WARDEN_SETTINGS: JSON.stringify({ model }) },
    encoding: "utf8",
  });
  expect(result.status, result.stdout + result.stderr).toBe(2);
  expect(result.stderr).toContain("Set WARDEN_TLC_JAR");
});

it("keeps the named invariant after a long counterexample", async () => {
  const read = await simulate();
  expect(read(0, "")).toEqual({ code: 0 });
  const states = Array.from({ length: 14 }, (_, n) => message(2217, 4, `${n}: Running\nn = ${n}`)).join("");
  const finding = read(12, message(2110, 1, "Invariant BelowLimit is violated.") + states);
  expect(finding.code).toBe(1);
  expect(finding.message?.split("\n").slice(-3)).toEqual(["13: Running", "n = 13", "protocol/Token.tla: Invariant BelowLimit is violated."]);
});

it("preserves native parser and semantic diagnostics", async () => {
  const read = await simulate();
  const generic = message(3002, 1, "Parsing or semantic analysis failed.");
  const syntax = "***Parse Error***\nWas expecting Identifier\nEncountered ==== at line 3, column 1.\n";
  expect(() => read(150, syntax + generic)).toThrow(/protocol\/Token\.tla:.*Encountered.*line 3, column 1/);
  const semantic = "*** Errors: 1\n\nline 5, col 15 to line 5, col 21 of module Token\n\nUnknown operator: Unknown.\n";
  expect(() => read(150, semantic + generic)).toThrow(/protocol\/Token\.tla:.*line 5, col 15.*Unknown operator: Unknown/);
});

it("distinguishes a false assumption from an assumption evaluation error", async () => {
  const read = await simulate();
  expect(read(10, message(2104, 1, "Assumption is false."))).toMatchObject({ code: 1, message: expect.stringContaining("is false") });
  expect(() => read(10, message(2105, 1, "Evaluating assumption failed."))).toThrow("Evaluating assumption failed.");
});
