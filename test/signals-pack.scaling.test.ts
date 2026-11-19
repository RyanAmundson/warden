import { expect, it } from "vitest";
import { bench, guardrailIds } from "./pack-bench.js";

const PATHS = '["src/**"]';

it.for(await guardrailIds("signals", PATHS))("%s scales at most linearly", async (rule, ctx) => {
  const { code, out } = await bench("signals", PATHS, { rule }, ctx);
  expect(code, out).toBe(0);
});
