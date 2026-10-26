import { describe, expect, test } from "vitest";

describe("Outer Suite", () => {
  describe("Inner Suite", () => {
    test("CI_001: nested test", () => {
      expect(true).toBe(true);
    });
  });

  test("CI_002: top-level test", () => {
    expect(true).toBe(true);
  });
});

test("generic smoke test", () => {
  expect(true).toBe(true);
});
