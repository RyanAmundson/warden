import { expect, it } from "vitest";
import { CODE_PATHS, bench } from "./pack-bench.js";

it.for(["architecture-world-modules", "architecture-world-globals", "architecture-source-shape"])("%s scales at most linearly", async (rule, ctx) => {
  const { code, out } = await bench("architecture", CODE_PATHS, { rule }, ctx);
  expect(code, out).toBe(0);
});
