import { expect, it } from "vitest";
import { bench, guardrailIds } from "./pack-bench.js";

const PATHS = '["**/*"]';

it.for(await guardrailIds("collection-folders", PATHS))("%s scales at most linearly", async (rule, ctx) => {
  const { code, out } = await bench("collection-folders", PATHS, { rule }, ctx);
  expect(code, out).toBe(0);
});
