import { expect, it } from "vitest";
import { CODE_PATHS, bench, guardrailIds } from "./pack-bench.js";

it.for(await guardrailIds("declarative-ui", CODE_PATHS))("%s scales at most linearly", async (rule, ctx) => {
  const { code, out } = await bench("declarative-ui", CODE_PATHS, { rule }, ctx);
  expect(code, out).toBe(0);
});
