/**
 * Protocol-free production-composition fixture for the real
 * ConformanceReporter: a passing bracketed ID, a duplicate requirement ID
 * (one pass, one intentional failure) and a generic assertion. It records the
 * configuration the native child actually loaded in `diagnostic.json`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { loadConfigWithHierarchy } from "@/logic/config-loader";

const config = loadConfigWithHierarchy();
writeFileSync(
  join(process.cwd(), "diagnostic.json"),
  JSON.stringify({
    authorization_interaction: config.issuance.authorization_interaction,
    config_file_ini: process.env.CONFIG_FILE_INI,
    credential_types: config.issuance.credential_types,
    issuer_url: config.issuance.url,
  }),
);

describe("Production matrix", () => {
  describe("Requirement identifiers", () => {
    test("[CI_900]: bracketed requirement passes", () => {
      expect(config.issuance.url).toMatch(/^https:\/\//);
    });

    test("CI_901: duplicate requirement — first occurrence passes", () => {
      expect(true).toBe(true);
    });

    test("CI_901: duplicate requirement — second occurrence fails on purpose", () => {
      expect("intentional failure", "deliberate native FAIL").toBe("pass");
    });
  });

  test("generic assertion without a requirement id passes", () => {
    expect(config.issuance.credential_types.length).toBeGreaterThan(0);
  });
});
