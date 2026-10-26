import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfigWithHierarchy } from "@/logic/config-loader";

function minimalIni(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    "issuance.url": "https://issuer.example",
    "issuer.port": "3003",
    "logging.log_file": "./data/logs/test.log",
    "logging.log_format": "[%(tag)]: %(message)",
    "logging.log_level": "INFO",
    "presentation.authorize_request_url":
      "https://rp.example/auth?client_id=x&request_uri=y",
    "trust.ca_cert_path": "./data/trust",
    "trust.certificate_subject": "CN=test",
    "trust.federation_trust_anchors[]": "https://ta.example",
    "trust.federation_trust_anchors_jwks_path": "./data/trust",
    "trust_anchor.port": "3001",
    "wallet.backup_storage_path": "./data/backup",
    "wallet.credentials_storage_path": "./data/credentials",
    "wallet.port": "3002",
    "wallet.wallet_attestations_storage_path": "./data/attestation",
    "wallet.wallet_id": "test-wallet",
    "wallet.wallet_name": "Test Wallet",
    "wallet.wallet_version": "V1_0",
    ...overrides,
  };

  const sections: Record<string, string[]> = {
    issuance: [],
    issuer: [],
    logging: [],
    network: [],
    presentation: [],
    profile: [],
    steps_mapping: [],
    testing: [],
    trust: [],
    trust_anchor: [],
    wallet: [],
  };

  for (const [key, value] of Object.entries(base)) {
    const dotIndex = key.indexOf(".");
    const section = key.slice(0, dotIndex);
    const field = key.slice(dotIndex + 1);
    const lines = sections[section];
    if (lines) {
      lines.push(`${field} = ${value}`);
    }
  }

  const ini = Object.entries(sections)
    .filter(([, lines]) => lines.length > 0)
    .map(([section, lines]) => `[${section}]\n${lines.join("\n")}`)
    .join("\n\n");

  return ini;
}

// Store and restore relevant env vars around each test
const ENV_KEYS = [
  "CONFIG_FILE_INI",
  "CONFIG_CREDENTIAL_ISSUER_URI",
  "CONFIG_PRESENTATION_AUTHORIZE_URI",
  "CONFIG_LOG_FILE",
  "CONFIG_LOG_LEVEL",
] as const;

const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
  savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = savedEnv[key];
    }
  }
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "wct-cfg-"));
  // Clear env so tests are deterministic
  for (const key of ENV_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
});

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true });
  restoreEnv();
});

describe("config path resolution", () => {
  it("resolves relative paths against the config file directory", () => {
    const iniPath = path.join(tempDir, "config.ini");
    writeFileSync(iniPath, minimalIni());

    const config = loadConfigWithHierarchy({ fileIni: iniPath }, iniPath);

    expect(config.wallet.credentials_storage_path).toBe(
      path.resolve(tempDir, "data/credentials"),
    );
    expect(config.logging.log_file).toBe(
      path.resolve(tempDir, "data/logs/test.log"),
    );
  });

  it("keeps absolute paths unchanged", () => {
    const absCreds = path.join(tempDir, "abs-creds");
    const iniPath = path.join(tempDir, "config.ini");
    writeFileSync(
      iniPath,
      minimalIni({ "wallet.credentials_storage_path": absCreds }),
    );

    const config = loadConfigWithHierarchy({ fileIni: iniPath }, iniPath);
    expect(config.wallet.credentials_storage_path).toBe(absCreds);
  });

  it("CONFIG_FILE_INI env var is picked up as the custom ini", () => {
    const defaultIni = path.join(tempDir, "default.ini");
    writeFileSync(
      defaultIni,
      minimalIni({ "wallet.wallet_id": "from-default" }),
    );

    const customIni = path.join(tempDir, "custom.ini");
    writeFileSync(customIni, minimalIni({ "wallet.wallet_id": "from-custom" }));

    process.env.CONFIG_FILE_INI = customIni;
    const config = loadConfigWithHierarchy(null, defaultIni);
    expect(config.wallet.wallet_id).toBe("from-custom");
  });

  it("custom ini overrides default ini", () => {
    const defaultIni = path.join(tempDir, "default.ini");
    writeFileSync(
      defaultIni,
      minimalIni({ "wallet.wallet_id": "from-default" }),
    );

    const customIni = path.join(tempDir, "custom.ini");
    writeFileSync(customIni, minimalIni({ "wallet.wallet_id": "from-custom" }));

    const config = loadConfigWithHierarchy({ fileIni: customIni }, defaultIni);
    expect(config.wallet.wallet_id).toBe("from-custom");
  });

  it("CLI options override custom ini", () => {
    const defaultIni = path.join(tempDir, "default.ini");
    writeFileSync(defaultIni, minimalIni());

    const customIni = path.join(tempDir, "custom.ini");
    writeFileSync(customIni, minimalIni({ "wallet.wallet_id": "from-custom" }));

    const config = loadConfigWithHierarchy(
      { credentialIssuerUri: "https://cli-issuer.example", fileIni: customIni },
      defaultIni,
    );
    expect(config.issuance.url).toBe("https://cli-issuer.example");
    expect(config.wallet.wallet_id).toBe("from-custom");
  });
});
