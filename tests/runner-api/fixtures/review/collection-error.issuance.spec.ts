/**
 * The module throws while being collected: no test runs. The native session
 * must not end PASSED, and the collection error is kept in the export.
 */
import { describe, expect, test } from "vitest";

function failCollection(): void {
  throw new Error("collection failed on purpose");
}

failCollection();

describe("Never collected", () => {
  test("[CI_924]: never runs", () => {
    expect(true).toBe(true);
  });
});
