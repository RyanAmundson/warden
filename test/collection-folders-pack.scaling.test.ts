import { expect, it } from "vitest";
import { bench } from "./pack-bench.js";

it.for([
  "warden-collection-holds-only-folders",
  "warden-collections-do-not-nest",
  "warden-collection-names-are-plural-kebab-case",
  "warden-collection-items-share-one-shape",
])("%s scales at most linearly", async (rule, ctx) => {
  const { code, out } = await bench("collection-folders", '["**/*"]', { rule }, ctx);
  expect(code, out).toBe(0);
});
