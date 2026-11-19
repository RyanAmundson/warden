import { appendFileSync, existsSync, mkdirSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROTATE_BYTES, appendEvidence, evidenceFile, previousEvidenceFile, readEvidence, readEvidenceTail } from "../../src/runner/evidence.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "warden-evidence-"));
  vi.stubEnv("WARDEN_HOME", home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

const pad = (project: string): void => {
  truncateSync(evidenceFile(project), ROTATE_BYTES - 1);
  appendFileSync(evidenceFile(project), "\n");
};

describe("evidence", () => {
  it("a full Evidence file moves aside before the next append, so a project keeps at most two files of history", () => {
    appendEvidence("p", { at: "t", kind: "fired", detail: "one" });
    pad("p");
    appendEvidence("p", { at: "t", kind: "fired", detail: "two" });
    expect(statSync(previousEvidenceFile("p")).size).toBe(ROTATE_BYTES);
    expect(readEvidence("p").map((e) => e.detail)).toEqual(["one", "two"]);
    pad("p");
    appendEvidence("p", { at: "t", kind: "fired", detail: "three" });
    expect(readEvidence("p").map((e) => e.detail)).toEqual(["two", "three"]);
    expect(statSync(evidenceFile("p")).size).toBeLessThan(100);
  });

  it("a tail read returns only the whole lines in its last bytes, reaching into the moved-aside file", () => {
    mkdirSync(join(home, "evidence"));
    const line = (detail: string): string => `${JSON.stringify({ at: "t", kind: "fired", detail })}\n`;
    writeFileSync(previousEvidenceFile("p"), line("a") + line("b"));
    writeFileSync(evidenceFile("p"), line("c"));
    expect(readEvidenceTail("p", line("b").length + line("c").length + 3).map((e) => e.detail)).toEqual(["b", "c"]);
    expect(readEvidenceTail("p", line("c").length).map((e) => e.detail)).toEqual(["c"]);
    expect(readEvidenceTail("p", 1 << 20).map((e) => e.detail)).toEqual(["a", "b", "c"]);
    expect(readEvidenceTail("q", 1 << 20)).toEqual([]);
    expect(existsSync(evidenceFile("q"))).toBe(false);
  });
});
