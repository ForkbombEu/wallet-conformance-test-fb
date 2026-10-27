/**
 * Harmless protocol-free fixture for native discovery tests.
 *
 * Selected through the production profile/worker path, it records the
 * effective configuration that the native child actually loaded into
 * `diagnostic.json` in its working directory (the run workspace). Two
 * credential type markers switch behaviour:
 * - `fixture_force_failure`: DIAG_002 fails (readable native failure)
 * - `fixture_verbose`: writes several MiB to stdout (pipe back-pressure)
 */
import { defineIssuanceTest } from "#/config/test-metadata";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { loadConfigWithHierarchy } from "@/logic/config-loader";
import { resolveDbPath } from "@/report/db";

const configurations = await defineIssuanceTest("NativeDiscoveryFixture");
const config = loadConfigWithHierarchy();
const credentialTypes = config.issuance.credential_types;

writeFileSync(
  join(process.cwd(), "diagnostic.json"),
  JSON.stringify(
    {
      authorization_interaction: config.issuance.authorization_interaction,
      backup_storage_path: config.wallet.backup_storage_path,
      ca_cert_path: config.trust.ca_cert_path,
      config_file_ini: process.env.CONFIG_FILE_INI,
      configuration_count: configurations.length,
      credential_offer_uri: config.issuance.credential_offer_uri ?? null,
      credential_types: credentialTypes,
      credentials_storage_path: config.wallet.credentials_storage_path,
      db_path: resolveDbPath(),
      issuer_url: config.issuance.url,
      log_file: config.logging.log_file,
      wallet_attestations_storage_path:
        config.wallet.wallet_attestations_storage_path,
    },
    null,
    2,
  ),
);

if (credentialTypes.includes("fixture_verbose")) {
  const line = `${"x".repeat(1023)}\n`;
  for (let i = 0; i < 4096; i++) process.stdout.write(line);
}

describe("Native discovery fixture", () => {
  test("[DIAG_001] effective configuration was loaded", () => {
    expect(configurations.length).toBeGreaterThan(0);
  });

  test("[DIAG_002] no forced failure was requested", () => {
    expect(credentialTypes).not.toContain("fixture_force_failure");
  });
});
