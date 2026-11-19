import { expect, it } from "vitest";
import { CODE_PATHS, bench } from "./pack-bench.js";

it.for(["warden-no-comments", "warden-no-suppressions"])("%s scales at most linearly", async (rule, ctx) => {
  const { code, out } = await bench("core", CODE_PATHS, { rule }, ctx);
  expect(code, out).toBe(0);
});
