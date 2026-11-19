import { expect, it } from "vitest";
import { CODE_PATHS, bench } from "./pack-bench.js";

it.each(["architecture-world-modules", "architecture-world-globals", "architecture-source-shape"])("%s scales at most linearly", async (rule) => {
  const { code, out } = await bench("architecture", CODE_PATHS, { rule });
  expect(code, out).toBe(0);
});
