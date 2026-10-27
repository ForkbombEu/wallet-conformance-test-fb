/**
 * Every test passes, but the suite's afterAll hook throws: Vitest exits 1
 * without a failing assertion. The runner must not publish this as `pass`.
 */
import { afterAll, describe, expect, test } from "vitest";

describe("Broken suite (afterAll)", () => {
  afterAll(() => {
    throw new Error("afterAll failed on purpose");
  });

  test("[CI_920]: passes", () => {
    expect(true).toBe(true);
  });
});
