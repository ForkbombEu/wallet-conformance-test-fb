import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadProfiles, startRunner } from "../../src/runner-api/main";
import { buildEffectiveConfig } from "../../src/runner-api/effective-config";
import { loadConfigWithHierarchy } from "@/logic/config-loader";

const TOKEN = "l08-test-token";

function makeIni(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    "global.data_dir": "./data",
    "global.log_level": "INFO",
    "issuance.url": "https://issuer.example",
    "issuer.port": "3003",
    "logging.log_file": "./data/logs/test.log",
    "logging.log_format": "%(message)s",
    "logging.log_level": "INFO",
    "presentation.authorize_request_url": "https://rp.example/auth",
    "trust.ca_cert_path": "./data/trust",
    "trust.certificate_subject": "CN=test",
    "trust.federation_trust_anchors[]": "https://ta.example",
    "trust.federation_trust_anchors_jwks_path": "./data/trust",
    "trust_anchor.port": "3001",
    "wallet.backup_storage_path": "./data/backup",
    "wallet.credentials_storage_path": "./data/credentials",
    "wallet.port": "3002",
    "wallet.wallet_attestations_storage_path": "./data/attestation",
    "wallet.wallet_id": "test",
    "wallet.wallet_name": "Test",
    "wallet.wallet_version": "V1_0",
    ...overrides,
  };

  const sections: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(base)) {
    const dotIndex = key.indexOf(".");
    const section = key.slice(0, dotIndex);
    const field = key.slice(dotIndex + 1);
    if (!sections[section]) sections[section] = [];
    sections[section]!.push(`${field} = ${value}`);
  }

  return Object.entries(sections)
    .map(([section, lines]) => `[${section}]\n${lines.join("\n")}`)
    .join("\n\n");
}

function makeProfilesJson(configDir: string): string {
  const profilesPath = join(configDir, "profiles.json");
  writeFileSync(
    profilesPath,
    JSON.stringify({
      profiles: [
        {
          id: "profile-a",
          configFile: "config-a.ini",
          category: "issuance",
          coverageMode: "interoperability",
          allowedAuthorizationInteraction: ["auto"],
          selections: [
            {
              id: "credimi-issuance-smoke",
              testFile: "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
            },
          ],
        },
        {
          id: "profile-b",
          configFile: "config-b.ini",
          category: "issuance",
          coverageMode: "interoperability",
          allowedAuthorizationInteraction: ["auto"],
          selections: [
            {
              id: "credimi-issuance-smoke",
              testFile: "tests/credimi/issuance/credimi-flow.issuance.spec.ts",
            },
          ],
        },
      ],
    }),
  );
  return profilesPath;
}

let dir: string;
let savedToken: undefined | string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wct-l08-"));
  savedToken = process.env.CREDIMI_RUNNER_TOKEN;
});

afterEach(() => {
  if (savedToken === undefined) {
    Reflect.deleteProperty(process.env, "CREDIMI_RUNNER_TOKEN");
  } else {
    process.env.CREDIMI_RUNNER_TOKEN = savedToken;
  }
  rmSync(dir, { force: true, recursive: true });
});

describe("L08 — loadProfiles resolves and validates", () => {
  it("loads profiles with resolved configFile paths", () => {
    writeFileSync(join(dir, "config-a.ini"), makeIni());
    writeFileSync(
      join(dir, "config-b.ini"),
      makeIni({ "issuance.url": "https://b.example" }),
    );
    const profilesPath = makeProfilesJson(dir);

    const profiles = loadProfiles(profilesPath);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]?.id).toBe("profile-a");
    expect(profiles[1]?.id).toBe("profile-b");
    // configFile is resolved to absolute path
    expect(profiles[0]?.configFile).toContain("config-a.ini");
    expect(profiles[1]?.configFile).toContain("config-b.ini");
  });

  it("rejects duplicate profile IDs", () => {
    writeFileSync(join(dir, "config-a.ini"), makeIni());
    const profilesPath = join(dir, "profiles.json");
    writeFileSync(
      profilesPath,
      JSON.stringify({
        profiles: [
          {
            id: "dup",
            configFile: "config-a.ini",
            category: "issuance",
            coverageMode: "interoperability",
            allowedAuthorizationInteraction: ["auto"],
            selections: [{ id: "s1", testFile: "t" }],
          },
          {
            id: "dup",
            configFile: "config-a.ini",
            category: "issuance",
            coverageMode: "interoperability",
            allowedAuthorizationInteraction: ["auto"],
            selections: [{ id: "s1", testFile: "t" }],
          },
        ],
      }),
    );
    expect(() => loadProfiles(profilesPath)).toThrow(/Duplicate profile id/);
  });

  it("rejects missing configFile", () => {
    writeFileSync(join(dir, "config-a.ini"), makeIni());
    const profilesPath = join(dir, "profiles.json");
    writeFileSync(
      profilesPath,
      JSON.stringify({
        profiles: [
          {
            id: "p1",
            configFile: "nonexistent.ini",
            category: "issuance",
            coverageMode: "interoperability",
            allowedAuthorizationInteraction: ["auto"],
            selections: [{ id: "s1", testFile: "t" }],
          },
        ],
      }),
    );
    expect(() => loadProfiles(profilesPath)).toThrow(/config not found/);
  });

  it("rejects empty profiles", () => {
    const profilesPath = join(dir, "profiles.json");
    writeFileSync(profilesPath, JSON.stringify({ profiles: [] }));
    expect(() => loadProfiles(profilesPath)).toThrow(/no profiles/);
  });

  it("rejects profile with no selections", () => {
    writeFileSync(join(dir, "config-a.ini"), makeIni());
    const profilesPath = join(dir, "profiles.json");
    writeFileSync(
      profilesPath,
      JSON.stringify({
        profiles: [
          {
            id: "p1",
            configFile: "config-a.ini",
            category: "issuance",
            coverageMode: "interoperability",
            allowedAuthorizationInteraction: ["auto"],
            selections: [],
          },
        ],
      }),
    );
    expect(() => loadProfiles(profilesPath)).toThrow(/no selections/);
  });
});

describe("L08 — buildEffectiveConfig with real config", () => {
  it("empty overrides use real base config without TypeError", () => {
    writeFileSync(
      join(dir, "config-a.ini"),
      makeIni({ "issuance.url": "https://real-issuer.example" }),
    );
    writeFileSync(join(dir, "config-b.ini"), makeIni());
    const profilesPath = makeProfilesJson(dir);
    const profiles = loadProfiles(profilesPath);

    const config = loadConfigWithHierarchy({
      fileIni: profiles[0]!.configFile,
    });
    const effectiveConfig = buildEffectiveConfig(
      profiles[0]!,
      "credimi-issuance-smoke",
      {},
      config,
      join(dir, "run"),
    );

    // No TypeError — this is the core L08 gate
    expect(effectiveConfig.target.issuerIdentifier).toBe(
      "https://real-issuer.example",
    );
    expect(effectiveConfig.profileId).toBe("profile-a");
  });

  it("custom INI values survive through effective config", () => {
    writeFileSync(join(dir, "config-a.ini"), makeIni());
    writeFileSync(
      join(dir, "config-b.ini"),
      makeIni({ "issuance.url": "https://b-issuer.example" }),
    );
    const profilesPath = makeProfilesJson(dir);
    const profiles = loadProfiles(profilesPath);

    const config = loadConfigWithHierarchy({
      fileIni: profiles[1]!.configFile,
    });
    const effectiveConfig = buildEffectiveConfig(
      profiles[1]!,
      "credimi-issuance-smoke",
      {},
      config,
      join(dir, "run"),
    );

    expect(effectiveConfig.target.issuerIdentifier).toBe(
      "https://b-issuer.example",
    );
    expect(effectiveConfig.profileId).toBe("profile-b");
  });

  it("relative paths resolve from profiles JSON directory", () => {
    writeFileSync(join(dir, "config-a.ini"), makeIni());
    writeFileSync(join(dir, "config-b.ini"), makeIni());
    const profilesPath = makeProfilesJson(dir);
    const profiles = loadProfiles(profilesPath);
    expect(profiles[0]?.configFile).toBe(join(dir, "config-a.ini"));
  });
});
