import { expect, it } from "vitest";
import { CODE_PATHS, bench } from "./pack-bench.js";

it.each([
  "principles-complexity",
  "principles-nesting-depth",
  "principles-function-length",
  "principles-parameter-count",
  "principles-file-length",
  "principles-one-class-per-file",
  "principles-unused-locals",
  "principles-useless-constructor",
  "principles-unused-private-members",
])("%s scales at most linearly", async (rule) => {
  const { code, out } = await bench("principles", CODE_PATHS, { rule });
  expect(code, out).toBe(0);
});
