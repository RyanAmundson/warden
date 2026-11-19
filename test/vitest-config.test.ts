import { expect, it } from "vitest";
import config from "../vitest.config.js";

it("only the scaling project raises the test timeout, to two from-scratch measurements; every other test keeps the 5 s default", () => {
  const projects = (config.test?.projects ?? []) as { test: { name: string; testTimeout?: number } }[];
  expect(config.test?.testTimeout).toBeUndefined();
  expect(Object.fromEntries(projects.map((p) => [p.test.name, p.test.testTimeout]))).toEqual({ unit: undefined, scaling: 10_000 });
});
