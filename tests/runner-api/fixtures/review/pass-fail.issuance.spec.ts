/**
 * Ordinary native outcome: one passing and one failing assertion, no errors
 * outside test bodies. The suite is FAILED and the run is `fail`.
 */
import { describe, expect, test } from "vitest";

describe("Ordinary suite", () => {
  test("[CI_922]: passes", () => {
    expect(true).toBe(true);
  });

  test("[CI_923]: fails on purpose", () => {
    expect("intentional failure", "deliberate native FAIL").toBe("pass");
  });
});
