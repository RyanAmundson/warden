import { describe, expect, it } from "vitest";
import { requireNode25 } from "../../src/cli/node-version.js";

describe("requireNode25", () => {
  it.each(["25.0.0", "25.2.1", "26.1.0", "100.0.0"])("accepts Node %s", (version) => {
    expect(() => requireNode25(version)).not.toThrow();
  });

  it.each(["24.9.0", "22.11.0", "20.18.1", "9.0.0"])("refuses Node %s with one next action", (version) => {
    expect(() => requireNode25(version)).toThrow(
      `Warden needs Node 25 or newer; this is Node ${version}. Next action: install Node 25 or newer, then run warden again`,
    );
  });
});
