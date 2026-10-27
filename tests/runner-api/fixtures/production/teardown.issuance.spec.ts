/**
 * Harmless production-composition fixture: one passing check followed by a
 * failing teardown (afterAll). No SUT is contacted. The compiled runner must
 * not publish this as `pass`.
 */
import { afterAll, describe, expect, test } from "vitest";

describe("Production teardown", () => {
  afterAll(() => {
    throw new Error("teardown failed on purpose");
  });

  test("[CI_930]: check passes before teardown", () => {
    expect(true).toBe(true);
  });
});
