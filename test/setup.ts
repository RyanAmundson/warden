import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { exampleProjectsRemoved } from "../src/compiler/examples.js";

const home = mkdtempSync(join(tmpdir(), "warden-test-home-"));
process.env.WARDEN_HOME = home;

afterAll(async () => {
  await exampleProjectsRemoved();
  rmSync(home, { recursive: true, force: true });
});
