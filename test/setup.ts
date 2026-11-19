import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const home = mkdtempSync(join(tmpdir(), "warden-test-home-"));
process.env.WARDEN_HOME = home;

afterAll(() => rmSync(home, { recursive: true, force: true }));
