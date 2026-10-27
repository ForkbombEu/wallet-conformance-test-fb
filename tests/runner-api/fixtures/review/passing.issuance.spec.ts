/**
 * A clean, harmless native suite: every assertion passes and nothing fails
 * outside test bodies. Used to prove a real `pass` and the publication path.
 */
import { describe, expect, test } from "vitest";

describe("Clean suite", () => {
  test("[CI_925]: passes", () => {
    expect(true).toBe(true);
  });
});
