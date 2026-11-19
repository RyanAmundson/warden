import { expect, it } from "vitest";
import { CODE_PATHS, bench, guardrailIds } from "./pack-bench.js";

it.for(await guardrailIds("core", CODE_PATHS))("%s scales at most linearly", async (rule, ctx) => {
  const { code, out } = await bench("core", CODE_PATHS, { rule }, ctx);
  expect(code, out).toBe(0);
});
