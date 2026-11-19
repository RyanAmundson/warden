import { describe, expect, it } from "vitest";
import { widens } from "../../src/runner/tamper.js";

describe("path widening", () => {
  it("adding a brace member widens a glob", () => {
    expect(widens("src/{a,b}/**", "src/{a}/**")).toBe(true);
    expect(widens("src/{a}/**", "src/{a,b}/**")).toBe(false);
  });

  it("adding a brace member to a negated glob narrows it, and removing one widens it", () => {
    expect(widens("!**/{sources/**,test/**}", "!**/{sources/**}")).toBe(false);
    expect(widens("!**/{sources/**}", "!**/{sources/**,test/**}")).toBe(true);
  });

  it("compares each glob of a Practice and config pair on its own", () => {
    expect(widens("!**/{sources/**} & src/{a,b}/**", "!**/{sources/**} & src/{a}/**")).toBe(true);
    expect(widens("!**/{sources/**,x/**} & src/{a,b}/**", "!**/{sources/**} & src/{a}/**")).toBe(false);
  });
});
