/**
 * Every test passes, but a rejection escapes the test body: Vitest reports
 * an unhandled error and exits 1. The runner must not publish `pass`.
 */
import { describe, expect, test } from "vitest";

describe("Broken suite (unhandled rejection)", () => {
  test("[CI_921]: passes but leaks a rejection", async () => {
    void Promise.reject(new Error("unhandled rejection on purpose"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(true).toBe(true);
  });
});
