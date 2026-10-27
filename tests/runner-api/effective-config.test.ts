/* eslint-disable max-lines-per-function */
import type { ItWalletSpecsVersion } from "@pagopa/io-wallet-utils";

import { describe, expect, it } from "vitest";

import type { Config } from "@/types";

import { buildEffectiveConfig } from "@/runner-api/effective-config";
import {
  getProfile,
  type Profile,
  ProfileError,
  validateRunOverrides,
} from "@/runner-api/profiles";

function makeBaseConfig(): Config {
  return {
    issuance: {
      authorization_interaction: "auto",
      callback_port: 4000,
      client_authentication: "auto",
      credential_types: ["cfg-1"],
      save_credential: false,
      tests_dir: "./tests/issuance",
      url: "https://default-issuer.example",
    },
    issuer: { port: 3003 },
    logging: {
      log_file: "./data/logs/test.log",
      log_format: "[%(tag)]: %(message)",
      log_level: "INFO",
    },
    network: {
      bind_address: "127.0.0.1",
      max_retries: 10,
      timeout: 10,
      tls_reject_unauthorized: true,
    },
    presentation: {
      authorize_request_url: "https://rp.example/auth",
      tests_dir: "./tests/presentation",
    },
    profile: { ecosystem: "generic_oid4vci" },
    steps_mapping: { mapping: {} },
    testing: {
      custom_step_pattern: "**/*.ts",
      spec_pattern: "**/*.spec.ts",
      strict_custom_steps: false,
    },
    trust: {
      ca_cert_path: "./data/trust",
      certificate_subject: "CN=test",
      federation_trust_anchors: ["https://ta.example"],
      federation_trust_anchors_jwks_path: "./data/trust",
    },
    trust_anchor: { port: 3001, verify: true },
    wallet: {
      backup_storage_path: "./data/backup",
      credentials_storage_path: "./data/credentials",
      port: 3002,
      wallet_attestations_storage_path: "./data/attestation",
      wallet_id: "test-wallet",
      wallet_name: "Test Wallet",
      wallet_version: "V1_0" as ItWalletSpecsVersion,
    },
  };
}

function requireProfile(id: string): Profile {
  const p = getProfile(id);
  if (!p) {
    throw new Error(`Profile '${id}' not found`);
  }
  return p;
}

const WS = "/tmp/wct-run-test";
const profile = requireProfile("credimi-issuance-smoke");

describe("buildEffectiveConfig", () => {
  it("resolves test file from profile selection", () => {
    const eff = buildEffectiveConfig(
      profile,
      "credimi-issuance-smoke",
      {},
      makeBaseConfig(),
      WS,
    );
    expect(eff.testFile).toBe(
      "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
    );
    expect(eff.selectionId).toBe("credimi-issuance-smoke");
  });

  it("binds target issuer to config when no override", () => {
    const eff = buildEffectiveConfig(
      profile,
      "credimi-issuance-smoke",
      {},
      makeBaseConfig(),
      WS,
    );
    expect(eff.target.issuerIdentifier).toBe("https://default-issuer.example");
  });

  it("binds target issuer to override when provided", () => {
    const eff = buildEffectiveConfig(
      profile,
      "credimi-issuance-smoke",
      { issuer_url: "https://override-issuer.example" },
      makeBaseConfig(),
      WS,
    );
    expect(eff.target.issuerIdentifier).toBe("https://override-issuer.example");
  });

  it("effective issuer_identifier equals override (identity binding)", () => {
    const overrides = validateRunOverrides({
      issuer_url: "https://sut.example",
    });
    const eff = buildEffectiveConfig(
      profile,
      "credimi-issuance-smoke",
      overrides,
      makeBaseConfig(),
      WS,
    );
    expect(eff.target.issuerIdentifier).toBe(overrides.issuer_url);
  });

  it("provides fresh per-run writable paths under the workspace", () => {
    const eff = buildEffectiveConfig(
      profile,
      "credimi-issuance-smoke",
      {},
      makeBaseConfig(),
      WS,
    );
    expect(eff.writablePaths.db).toContain(WS);
    expect(eff.writablePaths.logs).toContain(WS);
    expect(eff.writablePaths.credentials).toContain(WS);
    expect(eff.writablePaths.backup).toContain(WS);
  });

  it("preserves trust settings from base config", () => {
    const config = makeBaseConfig();
    const eff = buildEffectiveConfig(
      profile,
      "credimi-issuance-smoke",
      {},
      config,
      WS,
    );
    // Trust settings are not overridden by the profile system
    expect(config.trust.certificate_subject).toBe("CN=test");
    expect(config.trust_anchor.verify).toBe(true);
    expect(eff).toBeDefined();
  });

  it("sets coverageMode to interoperability for credimi-issuance-smoke", () => {
    const eff = buildEffectiveConfig(
      profile,
      "credimi-issuance-smoke",
      {},
      makeBaseConfig(),
      WS,
    );
    expect(eff.coverageMode).toBe("interoperability");
    expect(eff.coverageMode).not.toBe("it_wallet_profile");
  });

  it("throws for unknown selection ID", () => {
    expect(() =>
      buildEffectiveConfig(profile, "bogus", {}, makeBaseConfig(), WS),
    ).toThrow(ProfileError);
  });

  it("rejects browser_redirect when no driver is configured", () => {
    const overrides = validateRunOverrides({
      authorization_interaction: "browser_redirect",
    });
    expect(() =>
      buildEffectiveConfig(
        profile,
        "credimi-issuance-smoke",
        overrides,
        makeBaseConfig(),
        WS,
      ),
    ).toThrow(ProfileError);
  });

  it("allows auto interaction", () => {
    const overrides = validateRunOverrides({
      authorization_interaction: "auto",
    });
    expect(() =>
      buildEffectiveConfig(
        profile,
        "credimi-issuance-smoke",
        overrides,
        makeBaseConfig(),
        WS,
      ),
    ).not.toThrow();
  });

  it("rejects auto that resolves to browser_redirect (it_wallet) without a driver", () => {
    const base = makeBaseConfig();
    base.profile.ecosystem = "it_wallet";
    expect(() =>
      buildEffectiveConfig(profile, "credimi-issuance-smoke", {}, base, WS),
    ).toThrow(/no authorization driver/);
  });

  it("allows auto resolving to browser_redirect when the profile has a driver", () => {
    const base = makeBaseConfig();
    base.profile.ecosystem = "it_wallet";
    const withDriver: Profile = {
      ...profile,
      authorizationDriver: { modulePath: "/abs/driver.mjs", type: "puppeteer" },
    };
    const eff = buildEffectiveConfig(
      withDriver,
      "credimi-issuance-smoke",
      {},
      base,
      WS,
    );
    expect(eff.authorizationDriver?.modulePath).toBe("/abs/driver.mjs");
  });

  it("rejects credential_presentation for issuance profile", () => {
    const overrides = validateRunOverrides({
      authorization_interaction: "credential_presentation",
    });
    expect(() =>
      buildEffectiveConfig(
        profile,
        "credimi-issuance-smoke",
        overrides,
        makeBaseConfig(),
        WS,
      ),
    ).toThrow(ProfileError);
  });

  it("accepts credential_offer_uri in overrides", () => {
    const overrides = validateRunOverrides({
      credential_offer_uri:
        "openid-credential-offer://?credential_offer=%7B%7D",
    });
    const eff = buildEffectiveConfig(
      profile,
      "credimi-issuance-smoke",
      overrides,
      makeBaseConfig(),
      WS,
    );
    expect(eff.overrides.credential_offer_uri).toBe(
      "openid-credential-offer://?credential_offer=%7B%7D",
    );
  });

  it("accepts credential_configuration_ids in overrides", () => {
    const overrides = validateRunOverrides({
      credential_configuration_ids: ["pid-1", "pid-2"],
    });
    const eff = buildEffectiveConfig(
      profile,
      "credimi-issuance-smoke",
      overrides,
      makeBaseConfig(),
      WS,
    );
    expect(eff.overrides.credential_configuration_ids).toEqual([
      "pid-1",
      "pid-2",
    ]);
  });

  it("does not allow arbitrary path or script input through overrides", () => {
    expect(() => validateRunOverrides({ config_path: "/etc/passwd" })).toThrow(
      ProfileError,
    );
    expect(() => validateRunOverrides({ exec: "rm -rf /" })).toThrow(
      ProfileError,
    );
  });
});
