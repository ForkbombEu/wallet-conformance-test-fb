import { describe, expect, it } from "vitest";

import {
  extractDescription,
  extractRequirementId,
} from "@/report/requirement-id";

describe("extractRequirementId", () => {
  it("extracts CI_ style IDs", () => {
    expect(extractRequirementId("CI_002: verifies credential issuance")).toBe(
      "CI_002",
    );
  });

  it("extracts RPR- style IDs", () => {
    expect(extractRequirementId("RPR-001: presentation happy path")).toBe(
      "RPR-001",
    );
  });

  it("extracts IDs with suffix letters", () => {
    expect(extractRequirementId("CI_015a: deferred issuance")).toBe("CI_015a");
  });

  it("returns null for generic titles without IDs", () => {
    expect(
      extractRequirementId("completes the authorization-code issuance flow"),
    ).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractRequirementId("")).toBeNull();
  });

  it("returns null when ID is not at the start", () => {
    expect(extractRequirementId("test CI_002: something")).toBeNull();
  });
});

describe("extractDescription", () => {
  it("strips the ID prefix", () => {
    expect(extractDescription("CI_002: verifies credential issuance")).toBe(
      "verifies credential issuance",
    );
  });

  it("returns the title unchanged when no ID is present", () => {
    expect(extractDescription("completes the flow")).toBe("completes the flow");
  });

  it("handles titles with extra whitespace after ID", () => {
    expect(extractDescription("RPR-001:   presentation flow")).toBe(
      "presentation flow",
    );
  });
});
