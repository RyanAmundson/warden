import { expect, it } from "vitest";
import { CODE_PATHS, bench } from "./pack-bench.js";

it.each(["warden-no-comments", "warden-no-suppressions"])("%s scales at most linearly", async (rule) => {
  const { code, out } = await bench("core", CODE_PATHS, { rule });
  expect(code, out).toBe(0);
});
